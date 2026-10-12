import type { ItadJobStatus } from './job-types'

/**
 * Pickup task in the platform calendar (pickup calendar spec "Desired state" and "Step").
 * Pure: the job's state decides what the calendar task must look like, and the comparison
 * with the stored link and the actual task decides the one step the sync takes. The job is
 * the source of truth; the task is its projection.
 */
export const PICKUP_TASK_INTERACTION_TYPE = 'itad-pickup'
export const PICKUP_TASK_SOURCE = 'itad.job_pickup'
export const PICKUP_TASK_DURATION_MINUTES = 60

export const PICKUP_TASK_LINK_STATES = ['creating', 'planned', 'completed', 'cancelled', 'lost'] as const
export type PickupTaskLinkState = (typeof PICKUP_TASK_LINK_STATES)[number]

/** Interaction statuses of the installed `customers` module. */
export const INTERACTION_STATUS = { planned: 'planned', completed: 'done', cancelled: 'canceled' } as const

export type PickupTaskJob = {
  id: string
  status: ItadJobStatus
  deleted: boolean
  internalReference: string
  name: string
  customerReference: string | null
  scheduledPickupAt: Date | null
  pickupCoordinatorUserId: string | null
}

/** Localized fragments; the caller resolves them in the organization's default locale. */
export type PickupTaskTexts = {
  title: (reference: string, name: string) => string
  customerReference: (value: string) => string
  jobLink: (url: string) => string
}

export type PickupTaskContent = {
  scheduledAt: Date
  durationMinutes: number
  ownerUserId: string | null
  title: string
  body: string
}

export type DesiredPickupTask =
  | { kind: 'planned'; content: PickupTaskContent }
  | { kind: 'completed' }
  | { kind: 'cancelled' }

const COMPLETED_STATUSES: readonly ItadJobStatus[] = ['in_transit', 'receiving', 'processing', 'closeout_review', 'completed']

export function jobUrl(jobId: string): string {
  return `/backend/itad/jobs/${encodeURIComponent(jobId)}`
}

export function pickupTaskContent(job: PickupTaskJob, scheduledAt: Date, texts: PickupTaskTexts): PickupTaskContent {
  const lines = [job.internalReference]
  if (job.customerReference) lines.push(texts.customerReference(job.customerReference))
  lines.push(texts.jobLink(jobUrl(job.id)))
  return {
    scheduledAt,
    durationMinutes: PICKUP_TASK_DURATION_MINUTES,
    ownerUserId: job.pickupCoordinatorUserId,
    title: texts.title(job.internalReference, job.name),
    body: lines.join('\n'),
  }
}

export function desiredPickupTask(job: PickupTaskJob, texts: PickupTaskTexts): DesiredPickupTask {
  if (job.deleted) return { kind: 'cancelled' }
  if (job.status === 'scheduled' && job.scheduledPickupAt) {
    return { kind: 'planned', content: pickupTaskContent(job, job.scheduledPickupAt, texts) }
  }
  if (COMPLETED_STATUSES.includes(job.status)) return { kind: 'completed' }
  return { kind: 'cancelled' }
}

/** The task as `customers` holds it now; `null` = missing or deleted. */
export type ActualPickupTask = {
  status: string
  scheduledAt: Date | null
  durationMinutes: number | null
  ownerUserId: string | null
  title: string | null
  body: string | null
}

export type CurrentPickupTask = {
  link: { state: PickupTaskLinkState; interactionId: string } | null
  actual: ActualPickupTask | null
}

export type FinalLinkState = 'planned' | 'completed' | 'cancelled'

export type PickupTaskStep =
  | { kind: 'none' }
  /** The task already matches; only the link state is recorded. */
  | { kind: 'finalize'; state: FinalLinkState }
  /** The task is gone and nothing has to replace it. */
  | { kind: 'mark_lost' }
  /**
   * Create the task. `reuseInteractionId` = an earlier create that never landed; otherwise
   * a new link replaces the current one, which is kept as history or marked lost.
   */
  | { kind: 'create'; content: PickupTaskContent; reuseInteractionId: string | null; previous: 'keep' | 'lost' | null }
  | { kind: 'update'; content: PickupTaskContent; reopen: boolean }
  | { kind: 'complete' }
  | { kind: 'cancel' }

export function contentMatches(actual: ActualPickupTask, content: PickupTaskContent): boolean {
  return (
    actual.scheduledAt?.getTime() === content.scheduledAt.getTime() &&
    actual.durationMinutes === content.durationMinutes &&
    (actual.ownerUserId ?? null) === content.ownerUserId &&
    (actual.title ?? '') === content.title &&
    (actual.body ?? '') === content.body
  )
}

export function planPickupTaskStep(desired: DesiredPickupTask, current: CurrentPickupTask): PickupTaskStep {
  const { link, actual } = current
  const terminalLink = link?.state === 'completed' || link?.state === 'cancelled' || link?.state === 'lost'

  if (!link || terminalLink) {
    // History is never re-checked; only a planned job opens a new occurrence.
    if (desired.kind !== 'planned') return { kind: 'none' }
    return { kind: 'create', content: desired.content, reuseInteractionId: null, previous: link ? 'keep' : null }
  }

  if (!actual) {
    if (link.state === 'creating') {
      // The earlier create never landed: retry it with the same id, or drop it.
      return desired.kind === 'planned'
        ? { kind: 'create', content: desired.content, reuseInteractionId: link.interactionId, previous: null }
        : { kind: 'mark_lost' }
    }
    // A planned task disappeared outside the sync.
    return desired.kind === 'planned'
      ? { kind: 'create', content: desired.content, reuseInteractionId: null, previous: 'lost' }
      : { kind: 'mark_lost' }
  }

  // The task exists (planned link, or a create whose finalize was lost).
  if (desired.kind === 'planned') {
    if (actual.status !== INTERACTION_STATUS.planned) return { kind: 'update', content: desired.content, reopen: true }
    if (!contentMatches(actual, desired.content)) return { kind: 'update', content: desired.content, reopen: false }
    return link.state === 'planned' ? { kind: 'none' } : { kind: 'finalize', state: 'planned' }
  }
  if (desired.kind === 'completed') {
    return actual.status === INTERACTION_STATUS.completed ? { kind: 'finalize', state: 'completed' } : { kind: 'complete' }
  }
  return actual.status === INTERACTION_STATUS.cancelled ? { kind: 'finalize', state: 'cancelled' } : { kind: 'cancel' }
}

/** The link state after a step succeeds; `null` = the step does not change it. */
export function linkStateAfter(step: PickupTaskStep): PickupTaskLinkState | null {
  switch (step.kind) {
    case 'none':
      return null
    case 'finalize':
      return step.state
    case 'mark_lost':
      return 'lost'
    case 'create':
    case 'update':
      return 'planned'
    case 'complete':
      return 'completed'
    case 'cancel':
      return 'cancelled'
  }
}

import { randomUUID } from 'node:crypto'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { createFallbackTranslator } from '@open-mercato/shared/lib/i18n/translate'
import { detectLocale, loadDictionary } from '@open-mercato/shared/lib/i18n/server'
import { resolveSupportedLocale } from '@open-mercato/shared/lib/i18n/locale'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import { ItadJob, ItadJobPickupTask } from '../data/entities'
import {
  desiredPickupTask,
  linkStateAfter,
  planPickupTaskStep,
  type PickupTaskJob,
  type PickupTaskStep,
  type PickupTaskTexts,
} from '../domain/pickup-task'
import {
  cancelPickupTask,
  completePickupTask,
  createPickupTask,
  ensurePickupActivityType,
  readPickupTask,
  updatePickupTask,
  type CustomerScope,
} from '../module-integrations/customers'

/**
 * Reconciles a job's pickup task in the platform calendar (pickup calendar spec "Sync").
 * Read → decide (pure domain) → intent (create only) → one `customers` command →
 * finalize. No `itad` transaction is open while the `customers` command runs; a parallel
 * create loses on the "one current link per job" index. If the job changed while the
 * step ran, the sync runs again (at most `MAX_ROUNDS`).
 *
 * It never throws for a failed step: the error code lands in `last_error`, the job page
 * shows it, and the next job change, Retry or the CLI runs the sync again.
 */
const MAX_ROUNDS = 3
const ERROR_MAX_LENGTH = 500

type Resolver = { resolve: <T = unknown>(name: string) => T }

export type PickupTaskSyncResult = {
  steps: Array<PickupTaskStep['kind']>
  error: string | null
}

/** The task's text is data, written once; `OM_ITAD_CALENDAR_LOCALE` pins its language. */
async function loadPickupTaskTexts(): Promise<{ texts: PickupTaskTexts; activityTypeLabel: string }> {
  const locale = resolveSupportedLocale(process.env.OM_ITAD_CALENDAR_LOCALE) ?? (await detectLocale())
  const translate = createFallbackTranslator(await loadDictionary(locale))
  return {
    texts: {
      title: (reference, name) => translate('itad.pickupTask.title', 'Device pickup – {reference} – {name}', { reference, name }),
      customerReference: (value) => translate('itad.pickupTask.customerReference', 'Customer reference: {value}', { value }),
      jobLink: (url) => translate('itad.pickupTask.jobLink', 'ITAD job: {url}', { url }),
    },
    activityTypeLabel: translate('itad.pickupTask.activityType', 'ITAD pickup'),
  }
}

function toDomainJob(job: ItadJob): PickupTaskJob {
  return {
    id: job.id,
    status: job.status,
    deleted: Boolean(job.deletedAt),
    internalReference: job.internalReference,
    name: job.name,
    customerReference: job.customerReference ?? null,
    scheduledPickupAt: job.scheduledPickupAt ?? null,
    pickupCoordinatorUserId: job.pickupCoordinatorUserId ?? null,
  }
}

function errorCode(error: unknown): string {
  if (isCrudHttpError(error)) {
    const body = error.body as { error?: unknown } | undefined
    const message = typeof body?.error === 'string' ? body.error : `http_${error.status}`
    return message.slice(0, ERROR_MAX_LENGTH)
  }
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, ERROR_MAX_LENGTH)
}

const isUniqueViolation = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false
  const record = error as { name?: unknown; code?: unknown }
  return record.name === 'UniqueConstraintViolationException' || record.code === '23505'
}

/** Loads the job including a soft-deleted one: a deleted draft still cancels its task. */
async function loadJob(em: EntityManager, scope: CustomerScope, jobId: string): Promise<ItadJob | null> {
  return em.findOne(ItadJob, { id: jobId, tenantId: scope.tenantId, organizationId: scope.organizationId } as FilterQuery<ItadJob>)
}

async function loadCurrentLink(em: EntityManager, scope: CustomerScope, jobId: string): Promise<ItadJobPickupTask | null> {
  return em.findOne(ItadJobPickupTask, {
    job: jobId,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    isCurrent: true,
  } as FilterQuery<ItadJobPickupTask>)
}

async function recordLink(
  container: Resolver,
  linkId: string,
  changes: Partial<Pick<ItadJobPickupTask, 'state' | 'isCurrent' | 'scheduledAt' | 'causedByUserId' | 'lastSyncedAt' | 'lastError'>>,
): Promise<void> {
  const em = container.resolve<EntityManager>('em').fork()
  const link = await em.findOne(ItadJobPickupTask, { id: linkId })
  if (!link) return
  Object.assign(link, changes)
  await em.flush()
}

/**
 * Writes the create intent: retires the previous current link (kept as history or
 * marked lost) and inserts a `creating` link with a pre-chosen interaction id, in one
 * short transaction. Returns `null` when a parallel sync already holds the current link.
 */
async function writeCreateIntent(
  container: Resolver,
  scope: CustomerScope,
  input: { jobId: string; previousLinkId: string | null; previous: 'keep' | 'lost' | null; scheduledAt: Date; causedByUserId: string | null },
): Promise<ItadJobPickupTask | null> {
  const em = container.resolve<EntityManager>('em').fork()
  try {
    return await em.transactional(async (tx) => {
      if (input.previousLinkId) {
        const previous = await tx.findOne(ItadJobPickupTask, { id: input.previousLinkId })
        if (previous) {
          previous.isCurrent = false
          if (input.previous === 'lost') previous.state = 'lost'
          // The old row must stop being current before the new one is inserted.
          await tx.flush()
        }
      }
      const link = tx.create(ItadJobPickupTask, {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        job: tx.getReference(ItadJob, input.jobId),
        interactionId: randomUUID(),
        state: 'creating',
        isCurrent: true,
        scheduledAt: input.scheduledAt,
        causedByUserId: input.causedByUserId,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      await tx.flush()
      return link
    })
  } catch (error) {
    if (isUniqueViolation(error)) return null
    throw error
  }
}

async function runRound(
  container: Resolver,
  scope: CustomerScope,
  jobId: string,
  causedByUserId: string | null,
): Promise<{ step: PickupTaskStep['kind']; error: string | null; jobVersion: number | null; stop: boolean }> {
  const em = container.resolve<EntityManager>('em').fork()
  const job = await loadJob(em, scope, jobId)
  const link = await loadCurrentLink(em, scope, jobId)
  if (!job && !link) return { step: 'none', error: null, jobVersion: null, stop: true }
  const jobVersion = job?.updatedAt?.getTime() ?? null

  const queryEngine = container.resolve<QueryEngine>('queryEngine')
  const actual = link ? await readPickupTask(queryEngine, scope, link.interactionId) : null
  const { texts, activityTypeLabel } = await loadPickupTaskTexts()
  const desired = job ? desiredPickupTask(toDomainJob(job), texts) : ({ kind: 'cancelled' } as const)
  const step = planPickupTaskStep(desired, {
    link: link ? { state: link.state, interactionId: link.interactionId } : null,
    actual,
  })

  if (step.kind === 'none') {
    if (link?.lastError) await recordLink(container, link.id, { lastError: null, lastSyncedAt: new Date() })
    return { step: step.kind, error: null, jobVersion, stop: true }
  }

  // The link that the command acts on (and that records success or failure).
  let target = link
  try {
    switch (step.kind) {
      case 'create': {
        if (!job) return { step: step.kind, error: null, jobVersion, stop: true }
        if (!step.reuseInteractionId) {
          target = await writeCreateIntent(container, scope, {
            jobId,
            previousLinkId: link?.id ?? null,
            previous: step.previous,
            scheduledAt: step.content.scheduledAt,
            causedByUserId,
          })
          // A parallel sync holds the current link; it creates the task.
          if (!target) return { step: 'none', error: null, jobVersion, stop: true }
        }
        await ensurePickupActivityType(container, scope, activityTypeLabel)
        await createPickupTask(container, scope, {
          interactionId: target!.interactionId,
          companyId: job.customerId,
          content: step.content,
        })
        break
      }
      case 'update':
        await updatePickupTask(container, scope, { interactionId: link!.interactionId, content: step.content, reopen: step.reopen })
        break
      case 'complete':
        await completePickupTask(container, scope, link!.interactionId)
        break
      case 'cancel':
        await cancelPickupTask(container, scope, link!.interactionId)
        break
      case 'finalize':
      case 'mark_lost':
        break
    }
  } catch (error) {
    const code = errorCode(error)
    if (target) await recordLink(container, target.id, { lastError: code, lastSyncedAt: new Date(), causedByUserId })
    return { step: step.kind, error: code, jobVersion, stop: true }
  }

  const state = linkStateAfter(step)
  if (target && state) {
    await recordLink(container, target.id, {
      state,
      isCurrent: state !== 'lost',
      ...(step.kind === 'create' || step.kind === 'update' ? { scheduledAt: step.content.scheduledAt } : {}),
      causedByUserId,
      lastSyncedAt: new Date(),
      lastError: null,
    })
  }
  return { step: step.kind, error: null, jobVersion, stop: false }
}

export async function syncPickupTask(
  container: Resolver,
  scope: CustomerScope,
  jobId: string,
  options: { causedByUserId?: string | null } = {},
): Promise<PickupTaskSyncResult> {
  const steps: PickupTaskSyncResult['steps'] = []
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const outcome = await runRound(container, scope, jobId, options.causedByUserId ?? null)
    steps.push(outcome.step)
    if (outcome.error) return { steps, error: outcome.error }
    if (outcome.stop) return { steps, error: null }
    // A step ran: go again only if the job changed meanwhile, or to finish a multi-step
    // case (a vanished task is marked lost, then the next round creates its successor).
    const em = container.resolve<EntityManager>('em').fork()
    const latest = await loadJob(em, scope, jobId)
    const changed = (latest?.updatedAt?.getTime() ?? null) !== outcome.jobVersion
    if (!changed && outcome.step !== 'mark_lost') return { steps, error: null }
  }
  return { steps, error: null }
}

/** Seeds the `itad-pickup` activity type for a new tenant (spec REQ-514). */
export async function seedPickupActivityType(container: Resolver, scope: CustomerScope): Promise<void> {
  const { activityTypeLabel } = await loadPickupTaskTexts()
  await ensurePickupActivityType(container, scope, activityTypeLabel)
}

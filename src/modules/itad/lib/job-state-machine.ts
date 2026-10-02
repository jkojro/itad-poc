import type { ItadJobStatus } from '../data/entities'
import type { ItadJobConditionKey } from './job-conditions'
import { isTerminalStatus } from './job-editability'

export const ITAD_JOB_ACTIONS = [
  'schedule',
  'unschedule',
  'dispatch',
  'return_to_scheduled',
  'start_receiving',
  'start_processing',
  'start_closeout',
  'complete',
  'hold',
  'resume',
  'cancel',
] as const

export type ItadJobAction = (typeof ITAD_JOB_ACTIONS)[number]

/** Statuses a job may be put on hold from (spec Q-003). */
export const HOLDABLE_STATUSES: readonly ItadJobStatus[] = [
  'scheduled',
  'in_transit',
  'receiving',
  'processing',
  'closeout_review',
]

type FixedTransition = {
  from: readonly ItadJobStatus[]
  /** `null` means "the stored pre-hold status" (resume). */
  to: ItadJobStatus | null
  conditions: readonly ItadJobConditionKey[]
  reasonRequired: boolean
}

/** Spec "Transition table" — the single source of truth for allowed moves. */
export const ITAD_JOB_TRANSITIONS: Record<ItadJobAction, FixedTransition> = {
  schedule: { from: ['draft'], to: 'scheduled', conditions: ['schedulingDataComplete'], reasonRequired: false },
  unschedule: { from: ['scheduled'], to: 'draft', conditions: [], reasonRequired: true },
  dispatch: { from: ['scheduled'], to: 'in_transit', conditions: [], reasonRequired: false },
  return_to_scheduled: { from: ['in_transit'], to: 'scheduled', conditions: [], reasonRequired: true },
  start_receiving: { from: ['in_transit'], to: 'receiving', conditions: [], reasonRequired: false },
  start_processing: { from: ['receiving'], to: 'processing', conditions: ['receivingComplete'], reasonRequired: false },
  start_closeout: { from: ['processing'], to: 'closeout_review', conditions: ['allAssetsProcessed'], reasonRequired: false },
  complete: {
    from: ['closeout_review'],
    to: 'completed',
    conditions: ['noBlockingExceptions', 'requiredDocumentsComplete'],
    reasonRequired: false,
  },
  hold: { from: HOLDABLE_STATUSES, to: 'on_hold', conditions: [], reasonRequired: true },
  resume: { from: ['on_hold'], to: null, conditions: [], reasonRequired: false },
  cancel: {
    from: ['draft', 'scheduled', 'in_transit', 'receiving', 'processing', 'closeout_review', 'on_hold'],
    to: 'cancelled',
    conditions: [],
    reasonRequired: true,
  },
}

export const REASON_MIN_LENGTH = 3
export const REASON_MAX_LENGTH = 1000

export type StateMachineJob = {
  status: ItadJobStatus
  statusBeforeHold?: ItadJobStatus | null
}

export function isItadJobAction(value: unknown): value is ItadJobAction {
  return typeof value === 'string' && (ITAD_JOB_ACTIONS as readonly string[]).includes(value)
}

/** Actions valid from the job's current status, in table order. Terminal jobs have none. */
export function availableActions(job: StateMachineJob): ItadJobAction[] {
  if (isTerminalStatus(job.status)) return []
  return ITAD_JOB_ACTIONS.filter((action) => ITAD_JOB_TRANSITIONS[action].from.includes(job.status))
}

/**
 * Target status of `action` for `job`, or `null` when the action is not valid from the
 * current status. `resume` targets the stored pre-hold status; a hold without one is
 * corrupt data and is treated as not resumable.
 */
export function resolveTargetStatus(job: StateMachineJob, action: ItadJobAction): ItadJobStatus | null {
  const transition = ITAD_JOB_TRANSITIONS[action]
  if (!transition.from.includes(job.status)) return null
  if (transition.to !== null) return transition.to
  const previous = job.statusBeforeHold ?? null
  return previous && HOLDABLE_STATUSES.includes(previous) ? previous : null
}

export function isReasonValid(reason: string | null | undefined): boolean {
  const trimmed = typeof reason === 'string' ? reason.trim() : ''
  return trimmed.length >= REASON_MIN_LENGTH && trimmed.length <= REASON_MAX_LENGTH
}

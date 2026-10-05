import type { ItadJobStatus } from './job-types'
import {
  ITAD_JOB_TRANSITIONS,
  isReasonValid,
  resolveTargetStatus,
  type ItadJobAction,
} from './job-state-machine'

export const ITAD_JOB_CONDITION_KEYS = [
  'schedulingDataComplete',
  'receivingComplete',
  'allAssetsProcessed',
  'noBlockingExceptions',
  'requiredDocumentsComplete',
] as const

export type ItadJobConditionKey = (typeof ITAD_JOB_CONDITION_KEYS)[number]

export type ConditionState = 'met' | 'unmet' | 'confirmation_required'

export type ConditionEvaluation = {
  key: ItadJobConditionKey
  state: ConditionState
  /** Translation key explaining an `unmet` state. */
  detailKey?: string
}

export type ConditionJob = {
  status: ItadJobStatus
  statusBeforeHold?: ItadJobStatus | null
  customerId: string
  name: string
  scheduledPickupAt?: Date | null
}

/** Side-effect-free lookups a condition may need; injected so the registry stays testable. */
export type ConditionDeps = {
  isCustomerValid: (customerId: string) => Promise<boolean>
}

type ConditionDefinition = {
  key: ItadJobConditionKey
  source: 'data' | 'manual'
  /** When false, a manual confirmation for this condition is rejected. */
  manualAllowed: boolean
  evaluate: (job: ConditionJob, deps: ConditionDeps) => Promise<ConditionEvaluation>
}

const manualCondition = (key: ItadJobConditionKey): ConditionDefinition => ({
  key,
  source: 'manual',
  manualAllowed: true,
  evaluate: async () => ({ key, state: 'confirmation_required' }),
})

/**
 * Module-internal condition registry (spec "Conditions"). Later specs switch an
 * operational condition to `source: 'data'` with `manualAllowed: false` and a real
 * `evaluate`; the state machine and the transition command stay unchanged.
 */
export const ITAD_JOB_CONDITIONS: Record<ItadJobConditionKey, ConditionDefinition> = {
  schedulingDataComplete: {
    key: 'schedulingDataComplete',
    source: 'data',
    manualAllowed: false,
    evaluate: async (job, deps) => {
      if (!job.name || !job.name.trim()) {
        return { key: 'schedulingDataComplete', state: 'unmet', detailKey: 'itad.jobs.conditions.detail.nameMissing' }
      }
      if (!job.scheduledPickupAt) {
        return { key: 'schedulingDataComplete', state: 'unmet', detailKey: 'itad.jobs.conditions.detail.pickupMissing' }
      }
      if (!(await deps.isCustomerValid(job.customerId))) {
        return { key: 'schedulingDataComplete', state: 'unmet', detailKey: 'itad.jobs.conditions.detail.customerInvalid' }
      }
      return { key: 'schedulingDataComplete', state: 'met' }
    },
  },
  receivingComplete: manualCondition('receivingComplete'),
  allAssetsProcessed: manualCondition('allAssetsProcessed'),
  noBlockingExceptions: manualCondition('noBlockingExceptions'),
  requiredDocumentsComplete: manualCondition('requiredDocumentsComplete'),
}

export function isConditionKey(value: unknown): value is ItadJobConditionKey {
  return typeof value === 'string' && (ITAD_JOB_CONDITION_KEYS as readonly string[]).includes(value)
}

export const COMMENT_MIN_LENGTH = 3
export const COMMENT_MAX_LENGTH = 1000

export type ConfirmationInput = { condition: string; comment?: string | null }

export type TransitionRejection =
  | { code: 'transition_not_allowed' }
  | { code: 'reason_required' }
  | { code: 'confirmation_duplicate'; condition: string }
  | { code: 'confirmation_not_allowed'; condition: string }
  | { code: 'confirmation_not_required'; condition: string }
  | { code: 'comment_required'; condition: string }
  | { code: 'condition_unmet'; conditions: ItadJobConditionKey[] }

export type TransitionDecision =
  | {
      ok: true
      target: ItadJobStatus
      evaluations: ConditionEvaluation[]
      confirmations: Array<{ condition: ItadJobConditionKey; comment: string }>
    }
  | { ok: false; rejection: TransitionRejection; evaluations: ConditionEvaluation[] }

export async function evaluateConditions(
  keys: readonly ItadJobConditionKey[],
  job: ConditionJob,
  deps: ConditionDeps,
): Promise<ConditionEvaluation[]> {
  const results: ConditionEvaluation[] = []
  for (const key of keys) results.push(await ITAD_JOB_CONDITIONS[key].evaluate(job, deps))
  return results
}

/**
 * Decides one transition request. Pure apart from the injected lookups, so every rule
 * of the spec's error catalog (rows 7, 10, 11) is unit-testable. Authorization (row 2,
 * `itad.jobs.confirm_conditions` when confirmations are sent) and terminal/lock checks
 * are the caller's job and run before this.
 */
export async function decideTransition(input: {
  job: ConditionJob
  action: ItadJobAction
  reason?: string | null
  confirmations?: ConfirmationInput[] | null
  deps: ConditionDeps
}): Promise<TransitionDecision> {
  const { job, action, deps } = input
  const target = resolveTargetStatus(job, action)
  if (!target) return { ok: false, rejection: { code: 'transition_not_allowed' }, evaluations: [] }

  const transition = ITAD_JOB_TRANSITIONS[action]
  if (transition.reasonRequired && !isReasonValid(input.reason)) {
    return { ok: false, rejection: { code: 'reason_required' }, evaluations: [] }
  }

  const evaluations = await evaluateConditions(transition.conditions, job, deps)
  const byKey = new Map(evaluations.map((evaluation) => [evaluation.key, evaluation]))
  const accepted: Array<{ condition: ItadJobConditionKey; comment: string }> = []
  const seen = new Set<string>()

  for (const confirmation of input.confirmations ?? []) {
    const condition = confirmation.condition
    if (seen.has(condition)) {
      return { ok: false, rejection: { code: 'confirmation_duplicate', condition }, evaluations }
    }
    seen.add(condition)
    if (!isConditionKey(condition)) {
      return { ok: false, rejection: { code: 'confirmation_not_required', condition }, evaluations }
    }
    if (!ITAD_JOB_CONDITIONS[condition].manualAllowed) {
      return { ok: false, rejection: { code: 'confirmation_not_allowed', condition }, evaluations }
    }
    const evaluation = byKey.get(condition)
    if (!evaluation || evaluation.state !== 'confirmation_required') {
      return { ok: false, rejection: { code: 'confirmation_not_required', condition }, evaluations }
    }
    const comment = typeof confirmation.comment === 'string' ? confirmation.comment.trim() : ''
    if (comment.length < COMMENT_MIN_LENGTH || comment.length > COMMENT_MAX_LENGTH) {
      return { ok: false, rejection: { code: 'comment_required', condition }, evaluations }
    }
    accepted.push({ condition, comment })
  }

  const confirmed = new Set(accepted.map((entry) => entry.condition))
  const unmet = evaluations
    .filter((evaluation) => evaluation.state === 'unmet' || (evaluation.state === 'confirmation_required' && !confirmed.has(evaluation.key)))
    .map((evaluation) => evaluation.key)
  if (unmet.length > 0) {
    return { ok: false, rejection: { code: 'condition_unmet', conditions: unmet }, evaluations }
  }
  return { ok: true, target, evaluations, confirmations: accepted }
}

/**
 * Operational exceptions (exceptions spec "Exception record", "Lifecycle and
 * resolution"). Pure. An exception is one record per source occurrence; it is created by
 * the system and resolved either by a manager ("Resolve") or by the domain action that
 * fixes the underlying problem.
 */
export const ITAD_EXCEPTION_TYPES = ['missing_from_delivery', 'unexpected_asset', 'duplicate_serial', 'sanitization_failed'] as const
export type ItadExceptionType = (typeof ITAD_EXCEPTION_TYPES)[number]

export const ITAD_EXCEPTION_STATUSES = ['open', 'resolved'] as const
export type ItadExceptionStatus = (typeof ITAD_EXCEPTION_STATUSES)[number]

export const ITAD_EXCEPTION_OUTCOMES = [
  'not_shipped',
  'lost_in_transit',
  'manifest_error',
  'accepted_into_job',
  'same_device',
  'second_device_set_aside',
  'retry_approved',
  'not_data_bearing',
  'job_cancelled',
] as const
export type ItadExceptionOutcome = (typeof ITAD_EXCEPTION_OUTCOMES)[number]

export const ITAD_EXCEPTION_EVENT_KINDS = ['created', 'assigned', 'unassigned', 'resolved'] as const
export type ItadExceptionEventKind = (typeof ITAD_EXCEPTION_EVENT_KINDS)[number]

/** Outcomes a manager may pick with "Resolve" (Q4, Q5); the other types resolve through domain actions. */
const MANUAL_OUTCOMES: Record<ItadExceptionType, readonly ItadExceptionOutcome[]> = {
  missing_from_delivery: ['not_shipped', 'lost_in_transit', 'manifest_error'],
  unexpected_asset: ['accepted_into_job'],
  duplicate_serial: [],
  sanitization_failed: [],
}

export function manualOutcomes(type: ItadExceptionType): readonly ItadExceptionOutcome[] {
  return MANUAL_OUTCOMES[type]
}

export type ManualResolutionDecision =
  | { ok: true }
  | { ok: false; code: 'exception_resolved' | 'resolve_through_domain_action' | 'outcome_invalid' }

/** "Resolve" on an exception: only MISSING / UNEXPECTED, only while OPEN, only their own outcomes (E4-021). */
export function decideManualResolution(input: {
  type: ItadExceptionType
  status: ItadExceptionStatus
  outcome: string
}): ManualResolutionDecision {
  if (input.status !== 'open') return { ok: false, code: 'exception_resolved' }
  const allowed = MANUAL_OUTCOMES[input.type]
  if (allowed.length === 0) return { ok: false, code: 'resolve_through_domain_action' }
  if (!(allowed as readonly string[]).includes(input.outcome)) return { ok: false, code: 'outcome_invalid' }
  return { ok: true }
}

/**
 * Occurrence identity (E4-014). One exception per key, whatever its status: a replayed
 * command or event can never create a second one, while a genuinely new occurrence (a
 * new run, scan or asset) has a new key.
 */
export function exceptionSourceKey(
  source:
    | { type: 'missing_from_delivery'; manifestItemId: string }
    | { type: 'unexpected_asset'; assetId: string }
    | { type: 'duplicate_serial'; intakeScanId: string }
    | { type: 'sanitization_failed'; runId: string },
): string {
  switch (source.type) {
    case 'missing_from_delivery':
      return `missing:${source.manifestItemId}`
    case 'unexpected_asset':
      return `unexpected:${source.assetId}`
    case 'duplicate_serial':
      return `duplicate:${source.intakeScanId}`
    case 'sanitization_failed':
      return `sanitization_failed:${source.runId}`
  }
}

/** Facts for the `noBlockingExceptions` condition (all four types are blocking, E4-030). */
export type ExceptionFacts = { openExceptions: number }

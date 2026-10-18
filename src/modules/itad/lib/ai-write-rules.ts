import { decideManualResolution, manualOutcomes, type ItadExceptionStatus, type ItadExceptionType } from '../domain/exceptions'
import { getEditableFields, type EditabilityJob } from '../domain/job-editability'

/**
 * Eligibility of the AI assistant's writes (AI assistant spec, "Writes"), pure.
 *
 * - `input` problems never change after the proposal (wrong outcome for the type, missing
 *   reason, invalid time): the tool refuses them at prepare, so no preview exists.
 * - `state` problems can change (exception no longer open, job status, time passed): the
 *   preview shows them as blocked and the record version becomes `ineligible:<code>`, so a
 *   state change after the preview reads as a stale version at confirm, and the handler
 *   re-checks before the command. (The framework re-runs `loadBeforeRecord` at confirm and
 *   turns a thrown error into a 500, so state problems must not throw there.)
 */

export type WriteEligibility = { ok: true } | { ok: false; level: 'input' | 'state'; code: string }

export const REASON_MIN_LENGTH = 3
export const REASON_MAX_LENGTH = 1000

/** Version of a record whose write is currently blocked by its state. */
export const ineligibleVersion = (code: string) => `ineligible:${code}`

export function resolveExceptionEligibility(input: {
  type: ItadExceptionType
  status: ItadExceptionStatus
  outcome: string
  reason: string
}): WriteEligibility {
  if (manualOutcomes(input.type).length === 0) return { ok: false, level: 'input', code: 'resolve_through_domain_action' }
  if (!(manualOutcomes(input.type) as readonly string[]).includes(input.outcome)) return { ok: false, level: 'input', code: 'outcome_invalid' }
  const reason = input.reason.trim()
  if (reason.length < REASON_MIN_LENGTH || reason.length > REASON_MAX_LENGTH) return { ok: false, level: 'input', code: 'reason_required' }
  const decision = decideManualResolution({ type: input.type, status: input.status, outcome: input.outcome })
  return decision.ok ? { ok: true } : { ok: false, level: 'state', code: decision.code }
}

export function reschedulePickupEligibility(input: { job: EditabilityJob; at: Date; now: Date }): WriteEligibility {
  if (Number.isNaN(input.at.getTime())) return { ok: false, level: 'input', code: 'time_invalid' }
  if (!getEditableFields(input.job).includes('scheduledPickupAt')) return { ok: false, level: 'state', code: 'field_locked' }
  // Checked at prepare and again right before the command: a preview made at 10:58 for
  // 11:00 must not be applied at 11:01 (the record version does not change with time).
  if (input.at.getTime() <= input.now.getTime()) return { ok: false, level: 'state', code: 'time_in_past' }
  return { ok: true }
}

/** "Wed 21 Oct 2026, 11:00 Europe/Warsaw (UTC+2)" — the instant in the operator's time zone, stated explicitly. */
export function formatPickupTime(at: Date, timeZone: string, locale = 'en'): string {
  const zone = isValidTimeZone(timeZone) ? timeZone : 'UTC'
  const date = new Intl.DateTimeFormat(locale, {
    timeZone: zone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(at)
  const time = new Intl.DateTimeFormat(locale, { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at)
  return `${date}, ${time} ${zone} (${utcOffset(at, zone)})`
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone })
    return true
  } catch {
    return false
  }
}

function utcOffset(at: Date, timeZone: string): string {
  const part = new Intl.DateTimeFormat('en', { timeZone, timeZoneName: 'shortOffset' })
    .formatToParts(at)
    .find((entry) => entry.type === 'timeZoneName')?.value
  if (!part || part === 'GMT' || part === 'GMT+0' || part === 'UTC') return 'UTC'
  return part.replace('GMT', 'UTC')
}

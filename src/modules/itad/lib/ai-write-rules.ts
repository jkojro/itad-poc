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

/**
 * `refuseBeforeMs`: a time further in the past than this is refused as an input problem —
 * it cannot have been in the future when the preview was made (pending actions expire
 * sooner), so a wrong date (e.g. a wrong year) is refused at prepare and the model can
 * correct it, instead of a preview that only the operator sees as blocked. A time that
 * passed more recently stays a state problem (it was valid when the preview was made).
 */
export function reschedulePickupEligibility(input: { job: EditabilityJob; at: Date; now: Date; refuseBeforeMs?: number }): WriteEligibility {
  if (Number.isNaN(input.at.getTime())) return { ok: false, level: 'input', code: 'time_invalid' }
  if (input.refuseBeforeMs !== undefined && input.at.getTime() < input.now.getTime() - input.refuseBeforeMs) {
    return { ok: false, level: 'input', code: 'time_in_past' }
  }
  if (!getEditableFields(input.job).includes('scheduledPickupAt')) return { ok: false, level: 'state', code: 'field_locked' }
  // Checked at prepare and again right before the command: a preview made at 10:58 for
  // 11:00 must not be applied at 11:01 (the record version does not change with time).
  if (input.at.getTime() <= input.now.getTime()) return { ok: false, level: 'state', code: 'time_in_past' }
  return { ok: true }
}

const OFFSET_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/i
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?$/

/**
 * The pickup instant from what the model sends: ISO 8601 with an offset, or a local date
 * and time ("2026-11-03T13:00") read in `timeZone` — the natural way to say "13:00 in
 * Warsaw", resolved here with the zone's rules (DST included) rather than by the model.
 */
export function resolvePickupInstant(
  value: string,
  timeZone: string | undefined,
): { ok: true; at: Date } | { ok: false; code: 'time_invalid' | 'timezone_required' | 'timezone_invalid' } {
  const text = value.trim()
  if (OFFSET_DATE_TIME.test(text)) {
    const at = new Date(text)
    return Number.isNaN(at.getTime()) ? { ok: false, code: 'time_invalid' } : { ok: true, at }
  }
  const local = LOCAL_DATE_TIME.exec(text)
  if (!local) return { ok: false, code: 'time_invalid' }
  if (!timeZone) return { ok: false, code: 'timezone_required' }
  if (!isValidTimeZone(timeZone)) return { ok: false, code: 'timezone_invalid' }
  const [year, month, day, hour, minute, second] = local.slice(1).map((part) => Number(part ?? 0))
  const wall = Date.UTC(year, month - 1, day, hour, minute, second)
  const check = new Date(wall)
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) {
    return { ok: false, code: 'time_invalid' }
  }
  // The zone's offset at the guessed instant, re-read once at the corrected one (DST edges).
  let at = wall - zoneOffsetMs(new Date(wall), timeZone)
  at = wall - zoneOffsetMs(new Date(at), timeZone)
  return { ok: true, at: new Date(at) }
}

function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  )
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second))
  return asUtc - Math.floor(at.getTime() / 1000) * 1000
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

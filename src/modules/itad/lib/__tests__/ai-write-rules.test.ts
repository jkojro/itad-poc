import { describe, expect, it } from '@jest/globals'
import { formatPickupTime, ineligibleVersion, reschedulePickupEligibility, resolveExceptionEligibility } from '../ai-write-rules'

describe('resolveExceptionEligibility (A2)', () => {
  const base = { type: 'missing_from_delivery' as const, status: 'open' as const, outcome: 'not_shipped', reason: 'Customer confirmed it stayed on site' }

  it('accepts an allowed outcome with a reason on an open exception', () => {
    expect(resolveExceptionEligibility(base)).toEqual({ ok: true })
    expect(resolveExceptionEligibility({ ...base, type: 'unexpected_asset', outcome: 'accepted_into_job' })).toEqual({ ok: true })
  })

  it('refuses input problems at prepare: wrong outcome, missing reason, types resolved elsewhere', () => {
    expect(resolveExceptionEligibility({ ...base, outcome: 'accepted_into_job' })).toEqual({ ok: false, level: 'input', code: 'outcome_invalid' })
    expect(resolveExceptionEligibility({ ...base, reason: ' x ' })).toEqual({ ok: false, level: 'input', code: 'reason_required' })
    expect(resolveExceptionEligibility({ ...base, type: 'sanitization_failed' })).toEqual({
      ok: false,
      level: 'input',
      code: 'resolve_through_domain_action',
    })
  })

  it('treats a no longer open exception as a state problem (shown blocked, stale at confirm)', () => {
    expect(resolveExceptionEligibility({ ...base, status: 'resolved' })).toEqual({ ok: false, level: 'state', code: 'exception_resolved' })
    expect(ineligibleVersion('exception_resolved')).toBe('ineligible:exception_resolved')
  })
})

describe('reschedulePickupEligibility (A4)', () => {
  const now = new Date('2026-10-18T10:58:00Z')
  const at = new Date('2026-10-18T11:00:00Z')

  it('allows a future time on a draft, scheduled or on-hold-from-scheduled job', () => {
    expect(reschedulePickupEligibility({ job: { status: 'scheduled' }, at, now })).toEqual({ ok: true })
    expect(reschedulePickupEligibility({ job: { status: 'draft' }, at, now })).toEqual({ ok: true })
    expect(reschedulePickupEligibility({ job: { status: 'on_hold', statusBeforeHold: 'scheduled' }, at, now })).toEqual({ ok: true })
  })

  it('refuses once receiving started and when the time has passed — checked again at execute', () => {
    expect(reschedulePickupEligibility({ job: { status: 'receiving' }, at, now })).toEqual({ ok: false, level: 'state', code: 'field_locked' })
    // Previewed at 10:58 for 11:00, confirmed at 11:01: refused although the record did not change.
    expect(reschedulePickupEligibility({ job: { status: 'scheduled' }, at, now: new Date('2026-10-18T11:01:00Z') })).toEqual({
      ok: false,
      level: 'state',
      code: 'time_in_past',
    })
    expect(reschedulePickupEligibility({ job: { status: 'scheduled' }, at: new Date('nope'), now })).toEqual({ ok: false, level: 'input', code: 'time_invalid' })
  })
})

describe('formatPickupTime', () => {
  it('states the time in the operator time zone with its name and offset', () => {
    expect(formatPickupTime(new Date('2026-10-21T09:00:00Z'), 'Europe/Warsaw')).toBe('Wed, Oct 21, 2026, 11:00 Europe/Warsaw (UTC+2)')
    expect(formatPickupTime(new Date('2026-10-21T09:00:00Z'), 'UTC')).toBe('Wed, Oct 21, 2026, 09:00 UTC (UTC)')
    expect(formatPickupTime(new Date('2026-10-21T09:00:00Z'), 'Not/AZone')).toContain('UTC (UTC)')
  })
})

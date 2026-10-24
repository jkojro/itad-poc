import { describe, expect, it } from '@jest/globals'
import {
  approveRetryEligibility,
  formatPickupTime,
  ineligibleVersion,
  reschedulePickupEligibility,
  resolveExceptionEligibility,
  resolvePickupInstant,
  retryVersion,
  selectAssignable,
} from '../ai-write-rules'

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

describe('approveRetryEligibility (A3)', () => {
  const base = { jobStatus: 'processing' as const, assetStatus: 'review_required' as const, hasOpenFailure: true, reason: 'Drive reseated, retry' }

  it('allows a retry for a device in review with an open failure while the job is processing', () => {
    expect(approveRetryEligibility(base)).toEqual({ ok: true })
  })

  it('refuses a missing reason as input; job status, device status and a closed failure as state', () => {
    expect(approveRetryEligibility({ ...base, reason: ' ' })).toEqual({ ok: false, level: 'input', code: 'reason_required' })
    expect(approveRetryEligibility({ ...base, jobStatus: 'completed' })).toEqual({ ok: false, level: 'state', code: 'job_not_processing' })
    expect(approveRetryEligibility({ ...base, assetStatus: 'sanitized' })).toEqual({ ok: false, level: 'state', code: 'asset_not_in_review' })
    expect(approveRetryEligibility({ ...base, hasOpenFailure: false })).toEqual({ ok: false, level: 'state', code: 'no_open_failure' })
  })

  it('versions the device together with its open failure', () => {
    const version = retryVersion('2026-10-19T08:00:00.000Z', { id: 'e1', updatedAt: '2026-10-19T08:00:01.000Z' })
    expect(version).toBe('2026-10-19T08:00:00.000Z|e1@2026-10-19T08:00:01.000Z')
    expect(retryVersion('2026-10-19T08:00:00.000Z', { id: 'e1', updatedAt: '2026-10-19T09:00:00.000Z' })).not.toBe(version)
  })
})

describe('selectAssignable (A1)', () => {
  const jobExceptions = [
    { id: 'a', type: 'sanitization_failed' as const, status: 'open' as const, assignedToUserId: null },
    { id: 'b', type: 'sanitization_failed' as const, status: 'open' as const, assignedToUserId: 'u2' },
    { id: 'c', type: 'sanitization_failed' as const, status: 'resolved' as const, assignedToUserId: null },
    { id: 'd', type: 'missing_from_delivery' as const, status: 'open' as const, assignedToUserId: null },
  ]

  it('selects the open exceptions matching type and assignee; reports closed ones as excluded', () => {
    expect(selectAssignable({ requestedIds: ['a', 'b', 'c'], filter: { type: 'sanitization_failed', assignee: 'any' }, jobExceptions })).toEqual({
      selected: ['a', 'b'],
      excluded: ['c'],
      outside: [],
    })
    expect(selectAssignable({ requestedIds: ['a', 'b'], filter: { type: 'sanitization_failed', assignee: 'unassigned' }, jobExceptions })).toEqual({
      selected: ['a'],
      excluded: ['b'],
      outside: [],
    })
    expect(selectAssignable({ requestedIds: ['b'], filter: { assignee: 'u2' }, jobExceptions }).selected).toEqual(['b'])
  })

  it('puts ids of another type or not in the job outside the filter', () => {
    expect(selectAssignable({ requestedIds: ['a', 'd', 'zzz', 'a'], filter: { type: 'sanitization_failed', assignee: 'any' }, jobExceptions })).toEqual({
      selected: ['a'],
      excluded: [],
      outside: ['d', 'zzz'],
    })
  })
})

describe('resolvePickupInstant', () => {
  const ok = (value: string, zone?: string) => {
    const resolved = resolvePickupInstant(value, zone)
    return resolved.ok ? resolved.at.toISOString() : resolved.code
  }

  it('reads a local date and time in the given zone, with its DST offset', () => {
    expect(ok('2026-11-03T13:00', 'Europe/Warsaw')).toBe('2026-11-03T12:00:00.000Z')
    expect(ok('2026-10-21T13:00:00', 'Europe/Warsaw')).toBe('2026-10-21T11:00:00.000Z')
    // The night clocks go back (25 Oct 2026, 03:00 CEST → 02:00 CET): offsets on both sides.
    expect(ok('2026-10-25T01:30', 'Europe/Warsaw')).toBe('2026-10-24T23:30:00.000Z')
    expect(ok('2026-10-25T04:00', 'Europe/Warsaw')).toBe('2026-10-25T03:00:00.000Z')
    expect(ok('2026-11-03T13:00', 'America/New_York')).toBe('2026-11-03T18:00:00.000Z')
  })

  it('keeps an explicit offset as given, whatever the zone', () => {
    expect(ok('2026-11-03T13:00:00+01:00', 'America/New_York')).toBe('2026-11-03T12:00:00.000Z')
    expect(ok('2026-11-03T12:00:00Z')).toBe('2026-11-03T12:00:00.000Z')
  })

  it('refuses a local time without a zone, an unknown zone and impossible dates', () => {
    expect(ok('2026-11-03T13:00')).toBe('timezone_required')
    expect(ok('2026-11-03T13:00', 'Mars/Base')).toBe('timezone_invalid')
    expect(ok('2026-02-30T13:00', 'Europe/Warsaw')).toBe('time_invalid')
    expect(ok('2026-11-03T25:00', 'Europe/Warsaw')).toBe('time_invalid')
    expect(ok('tomorrow 13:00', 'Europe/Warsaw')).toBe('time_invalid')
  })
})

describe('formatPickupTime', () => {
  it('states the time in the operator time zone with its name and offset', () => {
    expect(formatPickupTime(new Date('2026-10-21T09:00:00Z'), 'Europe/Warsaw')).toBe('Wed, Oct 21, 2026, 11:00 Europe/Warsaw (UTC+2)')
    expect(formatPickupTime(new Date('2026-10-21T09:00:00Z'), 'UTC')).toBe('Wed, Oct 21, 2026, 09:00 UTC (UTC)')
    expect(formatPickupTime(new Date('2026-10-21T09:00:00Z'), 'Not/AZone')).toContain('UTC (UTC)')
  })
})

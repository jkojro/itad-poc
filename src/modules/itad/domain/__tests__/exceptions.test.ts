import { describe, expect, it } from '@jest/globals'
import { decideManualResolution, exceptionSourceKey, manualOutcomes, ITAD_EXCEPTION_TYPES } from '../exceptions'

describe('exception rules (exceptions spec TEST-401)', () => {
  it('names one occurrence per source record', () => {
    expect(exceptionSourceKey({ type: 'missing_from_delivery', manifestItemId: 'i1' })).toBe('missing:i1')
    expect(exceptionSourceKey({ type: 'unexpected_asset', assetId: 'a1' })).toBe('unexpected:a1')
    expect(exceptionSourceKey({ type: 'duplicate_serial', intakeScanId: 's1' })).toBe('duplicate:s1')
    expect(exceptionSourceKey({ type: 'sanitization_failed', runId: 'r1' })).toBe('sanitization_failed:r1')
  })

  it('offers manual outcomes only for missing and unexpected (Q4, Q5)', () => {
    expect(manualOutcomes('missing_from_delivery')).toEqual(['not_shipped', 'lost_in_transit', 'manifest_error'])
    expect(manualOutcomes('unexpected_asset')).toEqual(['accepted_into_job'])
    expect(manualOutcomes('duplicate_serial')).toEqual([])
    expect(manualOutcomes('sanitization_failed')).toEqual([])
  })

  it('resolves missing and unexpected with their own outcomes only', () => {
    expect(decideManualResolution({ type: 'missing_from_delivery', status: 'open', outcome: 'lost_in_transit' })).toEqual({ ok: true })
    expect(decideManualResolution({ type: 'unexpected_asset', status: 'open', outcome: 'accepted_into_job' })).toEqual({ ok: true })
    expect(decideManualResolution({ type: 'unexpected_asset', status: 'open', outcome: 'not_shipped' })).toEqual({
      ok: false,
      code: 'outcome_invalid',
    })
  })

  it('sends duplicates and failed sanitization to their domain actions (E4-021)', () => {
    for (const type of ['duplicate_serial', 'sanitization_failed'] as const) {
      expect(decideManualResolution({ type, status: 'open', outcome: 'same_device' })).toEqual({
        ok: false,
        code: 'resolve_through_domain_action',
      })
    }
  })

  it('never resolves an exception twice', () => {
    for (const type of ITAD_EXCEPTION_TYPES) {
      expect(decideManualResolution({ type, status: 'resolved', outcome: 'not_shipped' })).toEqual({ ok: false, code: 'exception_resolved' })
    }
  })
})

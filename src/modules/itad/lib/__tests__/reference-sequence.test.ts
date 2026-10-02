import { describe, expect, it } from '@jest/globals'
import { formatJobReference, referenceYearOf } from '../reference-sequence'

describe('formatJobReference', () => {
  it('zero-pads to five digits', () => {
    expect(formatJobReference(2026, 1)).toBe('ITAD-2026-00001')
    expect(formatJobReference(2026, 481)).toBe('ITAD-2026-00481')
    expect(formatJobReference(2026, 99999)).toBe('ITAD-2026-99999')
  })

  it('widens instead of wrapping above 99999', () => {
    expect(formatJobReference(2026, 100000)).toBe('ITAD-2026-100000')
  })
})

describe('referenceYearOf', () => {
  it('uses the UTC year, not the local one', () => {
    // 00:30 on 1 January in Poland (CET, UTC+1) is still the previous year in UTC.
    expect(referenceYearOf(new Date('2026-12-31T23:30:00.000Z'))).toBe(2026)
    expect(referenceYearOf(new Date('2027-01-01T00:00:00.000Z'))).toBe(2027)
  })
})

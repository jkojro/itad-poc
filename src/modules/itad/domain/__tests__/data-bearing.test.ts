import { describe, expect, it } from '@jest/globals'
import { decideClassification, parseDataBearingValue, resolveDataBearing } from '../data-bearing'
import { ITAD_ASSET_HISTORY_STATUSES, ITAD_ASSET_STATUSES, type ItadAssetStatus } from '../job-types'

describe('dataBearing resolution at the scan (sanitization spec TEST-301)', () => {
  it('prefers the manifest value, then the job default, else leaves it undetermined', () => {
    expect(resolveDataBearing({ manifestValue: false, jobDefault: true })).toEqual({ dataBearing: false, source: 'manifest' })
    expect(resolveDataBearing({ manifestValue: true, jobDefault: null })).toEqual({ dataBearing: true, source: 'manifest' })
    expect(resolveDataBearing({ manifestValue: null, jobDefault: true })).toEqual({ dataBearing: true, source: 'job_default' })
    expect(resolveDataBearing({ manifestValue: undefined, jobDefault: false })).toEqual({ dataBearing: false, source: 'job_default' })
    expect(resolveDataBearing({ manifestValue: null, jobDefault: null })).toEqual({ dataBearing: null, source: null })
  })
})

describe('manifest dataBearing values (sanitization spec TEST-301)', () => {
  it.each(['true', 'YES', ' y ', '1', 'Tak', 't'])('reads %p as true', (raw) => {
    expect(parseDataBearingValue(raw)).toEqual({ ok: true, value: true })
  })
  it.each(['false', 'No', 'N', '0', 'NIE'])('reads %p as false', (raw) => {
    expect(parseDataBearingValue(raw)).toEqual({ ok: true, value: false })
  })
  it('treats an empty cell as no value', () => {
    expect(parseDataBearingValue('')).toEqual({ ok: true, value: null })
    expect(parseDataBearingValue('   ')).toEqual({ ok: true, value: null })
    expect(parseDataBearingValue(undefined)).toEqual({ ok: true, value: null })
  })
  it.each(['maybe', 'HDD', '2', 'yes please'])('does not recognize %p', (raw) => {
    expect(parseDataBearingValue(raw)).toEqual({ ok: false })
  })
})

describe('classification (sanitization spec TEST-302, classification part)', () => {
  const asset = (status: ItadAssetStatus, dataBearing: boolean | null) => ({ status, dataBearing })

  it('moves an undecided or false asset to sanitization when marked as carrying data', () => {
    expect(decideClassification({ jobStatus: 'receiving', asset: asset('received', null), target: true })).toEqual({
      kind: 'change',
      toStatus: 'sanitization_required',
    })
    expect(decideClassification({ jobStatus: 'processing', asset: asset('received', false), target: true })).toEqual({
      kind: 'change',
      toStatus: 'sanitization_required',
    })
  })

  it('keeps received → received when marked as not carrying data', () => {
    expect(decideClassification({ jobStatus: 'receiving', asset: asset('received', null), target: false })).toEqual({
      kind: 'change',
      toStatus: 'received',
    })
  })

  it('returns a data-bearing asset to the normal path when marked as not carrying data', () => {
    for (const status of ['sanitization_required', 'sanitized', 'review_required'] as const) {
      expect(decideClassification({ jobStatus: 'processing', asset: asset(status, true), target: false })).toEqual({
        kind: 'change',
        toStatus: 'received',
      })
    }
  })

  it('is a no-op for the value the asset already has', () => {
    expect(decideClassification({ jobStatus: 'receiving', asset: asset('received', false), target: false })).toEqual({ kind: 'noop' })
    expect(decideClassification({ jobStatus: 'processing', asset: asset('sanitized', true), target: true })).toEqual({ kind: 'noop' })
  })

  it('refuses any change while a sanitization run is open', () => {
    for (const target of [true, false]) {
      expect(decideClassification({ jobStatus: 'processing', asset: asset('sanitization_in_progress', true), target })).toEqual({
        kind: 'refused',
        code: 'sanitization_in_progress',
      })
    }
  })

  it('in closeout review allows true → false only (no dead end without runs)', () => {
    expect(decideClassification({ jobStatus: 'closeout_review', asset: asset('received', false), target: true })).toEqual({
      kind: 'refused',
      code: 'sanitization_not_possible',
    })
    expect(decideClassification({ jobStatus: 'closeout_review', asset: asset('sanitized', true), target: false })).toEqual({
      kind: 'change',
      toStatus: 'received',
    })
  })

  it.each(['draft', 'scheduled', 'in_transit', 'on_hold', 'completed', 'cancelled'] as const)('refuses in %s', (jobStatus) => {
    expect(decideClassification({ jobStatus, asset: asset('received', null), target: true })).toEqual({
      kind: 'refused',
      code: 'assets_locked',
    })
  })
})

describe('asset status vocabulary', () => {
  it('keeps the transition state sanitization_failed out of persisted statuses', () => {
    expect(ITAD_ASSET_STATUSES).not.toContain('sanitization_failed')
    expect(ITAD_ASSET_HISTORY_STATUSES).toContain('sanitization_failed')
    for (const status of ITAD_ASSET_STATUSES) expect(ITAD_ASSET_HISTORY_STATUSES).toContain(status)
  })
})

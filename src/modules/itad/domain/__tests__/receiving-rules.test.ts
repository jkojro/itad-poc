import { describe, expect, it } from '@jest/globals'
import { ITAD_JOB_STATUSES } from '../job-types'
import {
  canFlagDifferentDevice,
  canResolveAsSameDevice,
  decideScanResult,
  isReceivingActive,
  resolveNote,
} from '../receiving-rules'

describe('receiving rules', () => {
  it('allows receiving only in the receiving status itself (not on hold)', () => {
    expect(ITAD_JOB_STATUSES.filter((status) => isReceivingActive({ status }))).toEqual(['receiving'])
  })

  it('decides the scan result from the job facts', () => {
    expect(decideScanResult({ activeAssetExists: true, manifestItemExists: true })).toBe('duplicate')
    expect(decideScanResult({ activeAssetExists: true, manifestItemExists: false })).toBe('duplicate')
    expect(decideScanResult({ activeAssetExists: false, manifestItemExists: true })).toBe('matched')
    expect(decideScanResult({ activeAssetExists: false, manifestItemExists: false })).toBe('unexpected')
  })

  it('validates notes and reasons', () => {
    expect(resolveNote(null, false)).toBeNull()
    expect(resolveNote('   ', false)).toBeNull()
    expect(resolveNote(null, true)).toBe(false)
    expect(resolveNote('ab', false)).toBe(false)
    expect(resolveNote('  on shelf B  ', true)).toBe('on shelf B')
    expect(resolveNote('x'.repeat(1001), true)).toBe(false)
  })

  it('lets a pending duplicate be resolved, also after a flag, and flagged only once', () => {
    const pending = { result: 'duplicate' as const, resolvedAt: null, flaggedDifferentDeviceAt: null }
    const flagged = { ...pending, flaggedDifferentDeviceAt: new Date() }
    const resolved = { ...pending, resolvedAt: new Date() }
    expect([canResolveAsSameDevice(pending), canFlagDifferentDevice(pending)]).toEqual([true, true])
    expect([canResolveAsSameDevice(flagged), canFlagDifferentDevice(flagged)]).toEqual([true, false])
    expect([canResolveAsSameDevice(resolved), canFlagDifferentDevice(resolved)]).toEqual([false, false])
    expect(canResolveAsSameDevice({ result: 'matched' })).toBe(false)
  })
})

import { describe, expect, it } from '@jest/globals'
import { ITAD_JOB_STATUSES, type ItadJobStatus } from '../job-types'
import { canChangeManifest, effectiveJobStatus } from '../manifest-rules'

describe('manifest rules', () => {
  it('allows manifest changes from draft through receiving only', () => {
    const allowed = ITAD_JOB_STATUSES.filter((status) => status !== 'on_hold' && canChangeManifest({ status }))
    expect(allowed).toEqual(['draft', 'scheduled', 'in_transit', 'receiving'])
  })

  it('treats a held job as the status it was held from', () => {
    const held = (from: ItadJobStatus) => ({ status: 'on_hold' as const, statusBeforeHold: from })
    expect(effectiveJobStatus(held('receiving'))).toBe('receiving')
    expect(canChangeManifest(held('receiving'))).toBe(true)
    expect(canChangeManifest(held('processing'))).toBe(false)
    expect(canChangeManifest({ status: 'on_hold', statusBeforeHold: null })).toBe(false)
  })
})

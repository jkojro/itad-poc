import { describe, expect, it } from '@jest/globals'
import { ITAD_JOB_STATUSES, type ItadJobStatus } from '../job-types'
import { canChangeManifest, effectiveJobStatus, resolveItemDeleteReason } from '../manifest-rules'

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

describe('resolveItemDeleteReason', () => {
  it('requires 3–1000 characters while receiving, also when held from receiving', () => {
    expect(resolveItemDeleteReason({ status: 'receiving' }, null)).toEqual({ ok: false })
    expect(resolveItemDeleteReason({ status: 'receiving' }, '  ok ')).toEqual({ ok: false })
    expect(resolveItemDeleteReason({ status: 'on_hold', statusBeforeHold: 'receiving' }, '')).toEqual({ ok: false })
    expect(resolveItemDeleteReason({ status: 'receiving' }, ' Wrong row ')).toEqual({ ok: true, reason: 'Wrong row' })
    expect(resolveItemDeleteReason({ status: 'receiving' }, 'x'.repeat(1001))).toEqual({ ok: false })
  })

  it('makes the reason optional before receiving, but validates a given one', () => {
    expect(resolveItemDeleteReason({ status: 'draft' }, null)).toEqual({ ok: true, reason: null })
    expect(resolveItemDeleteReason({ status: 'in_transit' }, '   ')).toEqual({ ok: true, reason: null })
    expect(resolveItemDeleteReason({ status: 'scheduled' }, 'ab')).toEqual({ ok: false })
    expect(resolveItemDeleteReason({ status: 'draft' }, 'Customer correction')).toEqual({ ok: true, reason: 'Customer correction' })
  })
})

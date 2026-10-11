import { describe, expect, it } from '@jest/globals'
import { classificationRequiredFeature } from '../data-bearing'
import { ITAD_ASSET_STATUSES, ITAD_JOB_STATUSES, type ItadAssetStatus } from '../job-types'
import { canAttachEvidence, decideRunAction, verificationNotesRequired, type RunAction } from '../sanitization-state-machine'

const ALLOWED: Record<RunAction, ItadAssetStatus> = {
  start_run: 'sanitization_required',
  record_pass: 'sanitization_in_progress',
  record_fail: 'sanitization_in_progress',
  abort_run: 'sanitization_in_progress',
  approve_retry: 'review_required',
}

describe('sanitization state machine (sanitization spec TEST-302)', () => {
  it.each(Object.entries(ALLOWED) as Array<[RunAction, ItadAssetStatus]>)('%s is allowed only from %s', (action, from) => {
    for (const status of ITAD_ASSET_STATUSES) {
      const decision = decideRunAction({ jobStatus: 'processing', assetStatus: status, action })
      if (status === from) expect(decision.ok).toBe(true)
      else expect(decision).toEqual({ ok: false, code: 'asset_transition_not_allowed' })
    }
  })

  it('records the expected steps; FAIL passes through the transition state sanitization_failed', () => {
    const at = (action: RunAction) => decideRunAction({ jobStatus: 'processing', assetStatus: ALLOWED[action], action })
    expect(at('start_run')).toEqual({ ok: true, toStatus: 'sanitization_in_progress', steps: [{ from: 'sanitization_required', to: 'sanitization_in_progress' }] })
    expect(at('record_pass')).toMatchObject({ ok: true, toStatus: 'sanitized' })
    expect(at('record_fail')).toEqual({
      ok: true,
      toStatus: 'review_required',
      steps: [
        { from: 'sanitization_in_progress', to: 'sanitization_failed' },
        { from: 'sanitization_failed', to: 'review_required' },
      ],
    })
    expect(at('abort_run')).toMatchObject({ ok: true, toStatus: 'sanitization_required' })
    expect(at('approve_retry')).toMatchObject({ ok: true, toStatus: 'sanitization_required' })
  })

  it('allows run actions only while the job is in processing (Q5)', () => {
    for (const jobStatus of ITAD_JOB_STATUSES.filter((status) => status !== 'processing')) {
      expect(decideRunAction({ jobStatus, assetStatus: 'sanitization_required', action: 'start_run' })).toEqual({
        ok: false,
        code: 'processing_required',
      })
    }
  })

  it('requires verification notes for FAIL only', () => {
    expect(verificationNotesRequired('FAIL')).toBe(true)
    expect(verificationNotesRequired('PASS')).toBe(false)
  })

  it('accepts evidence until the job is completed or cancelled', () => {
    expect(canAttachEvidence('processing')).toBe(true)
    expect(canAttachEvidence('closeout_review')).toBe(true)
    expect(canAttachEvidence('completed')).toBe(false)
    expect(canAttachEvidence('cancelled')).toBe(false)
  })
})

describe('who may classify in which job status (sanitization spec Q12)', () => {
  it('receiving: the receiving feature without a reason; afterwards a manager with a reason', () => {
    expect(classificationRequiredFeature('receiving')).toEqual({ feature: 'itad.assets.receive', reasonRequired: false })
    expect(classificationRequiredFeature('processing')).toEqual({ feature: 'itad.sanitization.manage', reasonRequired: true })
    expect(classificationRequiredFeature('closeout_review')).toEqual({ feature: 'itad.sanitization.manage', reasonRequired: true })
    for (const status of ['draft', 'scheduled', 'in_transit', 'on_hold', 'completed', 'cancelled'] as const) {
      expect(classificationRequiredFeature(status)).toBeNull()
    }
  })
})

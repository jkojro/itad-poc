import { describe, expect, it } from '@jest/globals'
import { ITAD_JOB_STATUSES, type ItadJobStatus } from '../../data/entities'
import {
  ITAD_JOB_ACTIONS,
  availableActions,
  isReasonValid,
  resolveTargetStatus,
  type ItadJobAction,
} from '../job-state-machine'

/** Spec "Transition table", written out independently of the implementation. */
const EXPECTED: Record<ItadJobStatus, Partial<Record<ItadJobAction, ItadJobStatus>>> = {
  draft: { schedule: 'scheduled', cancel: 'cancelled' },
  scheduled: { unschedule: 'draft', dispatch: 'in_transit', hold: 'on_hold', cancel: 'cancelled' },
  in_transit: { return_to_scheduled: 'scheduled', start_receiving: 'receiving', hold: 'on_hold', cancel: 'cancelled' },
  receiving: { start_processing: 'processing', hold: 'on_hold', cancel: 'cancelled' },
  processing: { start_closeout: 'closeout_review', hold: 'on_hold', cancel: 'cancelled' },
  closeout_review: { complete: 'completed', hold: 'on_hold', cancel: 'cancelled' },
  completed: {},
  on_hold: { cancel: 'cancelled' },
  cancelled: {},
}

describe('ITAD job state machine (spec TEST-001)', () => {
  for (const status of ITAD_JOB_STATUSES) {
    for (const action of ITAD_JOB_ACTIONS) {
      if (status === 'on_hold' && action === 'resume') continue
      const expected = EXPECTED[status][action] ?? null
      it(`${status} --${action}--> ${expected ?? 'rejected'}`, () => {
        expect(resolveTargetStatus({ status }, action)).toBe(expected)
      })
    }
  }

  it('resume returns exactly to the stored pre-hold status', () => {
    for (const previous of ['scheduled', 'in_transit', 'receiving', 'processing', 'closeout_review'] as const) {
      expect(resolveTargetStatus({ status: 'on_hold', statusBeforeHold: previous }, 'resume')).toBe(previous)
    }
  })

  it('resume without a valid pre-hold status is rejected', () => {
    expect(resolveTargetStatus({ status: 'on_hold', statusBeforeHold: null }, 'resume')).toBeNull()
    expect(resolveTargetStatus({ status: 'on_hold', statusBeforeHold: 'draft' }, 'resume')).toBeNull()
  })

  it('terminal statuses offer no actions', () => {
    expect(availableActions({ status: 'completed' })).toEqual([])
    expect(availableActions({ status: 'cancelled' })).toEqual([])
  })

  it('lists the actions of the transition table for a status', () => {
    expect(availableActions({ status: 'in_transit' })).toEqual(['return_to_scheduled', 'start_receiving', 'hold', 'cancel'])
    expect(availableActions({ status: 'on_hold', statusBeforeHold: 'receiving' })).toEqual(['resume', 'cancel'])
  })

  it('validates reason length 3–1000 after trimming', () => {
    expect(isReasonValid('  ab ')).toBe(false)
    expect(isReasonValid('abc')).toBe(true)
    expect(isReasonValid('x'.repeat(1000))).toBe(true)
    expect(isReasonValid('x'.repeat(1001))).toBe(false)
    expect(isReasonValid(null)).toBe(false)
  })
})

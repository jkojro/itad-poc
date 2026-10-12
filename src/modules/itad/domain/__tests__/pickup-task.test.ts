import { describe, expect, it } from '@jest/globals'
import {
  desiredPickupTask,
  linkStateAfter,
  planPickupTaskStep,
  type ActualPickupTask,
  type CurrentPickupTask,
  type DesiredPickupTask,
  type PickupTaskJob,
  type PickupTaskLinkState,
  type PickupTaskTexts,
} from '../pickup-task'

const texts: PickupTaskTexts = {
  title: (reference, name) => `Pickup – ${reference} – ${name}`,
  customerReference: (value) => `Customer reference: ${value}`,
  jobLink: (url) => `Job: ${url}`,
}

const AT = new Date('2026-10-20T08:00:00.000Z')
const job = (overrides: Partial<PickupTaskJob> = {}): PickupTaskJob => ({
  id: '22222222-2222-4222-8222-222222222222',
  status: 'scheduled',
  deleted: false,
  internalReference: 'ITAD-2026-00010',
  name: 'Bank refresh',
  customerReference: 'NB-1',
  scheduledPickupAt: AT,
  pickupCoordinatorUserId: '33333333-3333-4333-8333-333333333333',
  ...overrides,
})

const planned = desiredPickupTask(job(), texts) as Extract<DesiredPickupTask, { kind: 'planned' }>
const matching: ActualPickupTask = {
  status: 'planned',
  scheduledAt: AT,
  durationMinutes: 60,
  ownerUserId: planned.content.ownerUserId,
  title: planned.content.title,
  body: planned.content.body,
}
const ID = '44444444-4444-4444-8444-444444444444'
const current = (state: PickupTaskLinkState, actual: ActualPickupTask | null): CurrentPickupTask => ({
  link: { state, interactionId: ID },
  actual,
})

describe('desiredPickupTask (pickup calendar spec "Desired state")', () => {
  it('plans a scheduled job at its pickup time, for 60 minutes, owned by the coordinator', () => {
    expect(planned).toEqual({
      kind: 'planned',
      content: {
        scheduledAt: AT,
        durationMinutes: 60,
        ownerUserId: '33333333-3333-4333-8333-333333333333',
        title: 'Pickup – ITAD-2026-00010 – Bank refresh',
        body: 'ITAD-2026-00010\nCustomer reference: NB-1\nJob: /backend/itad/jobs/22222222-2222-4222-8222-222222222222',
      },
    })
  })

  it('leaves the customer reference out of the body when there is none', () => {
    const desired = desiredPickupTask(job({ customerReference: null }), texts)
    expect(desired.kind === 'planned' && desired.content.body).toBe(
      'ITAD-2026-00010\nJob: /backend/itad/jobs/22222222-2222-4222-8222-222222222222',
    )
  })

  it.each([
    ['in_transit', 'completed'],
    ['receiving', 'completed'],
    ['processing', 'completed'],
    ['closeout_review', 'completed'],
    ['completed', 'completed'],
    ['draft', 'cancelled'],
    ['on_hold', 'cancelled'],
    ['cancelled', 'cancelled'],
  ] as const)('maps %s to %s', (status, kind) => {
    expect(desiredPickupTask(job({ status }), texts)).toEqual({ kind })
  })

  it('cancels for a deleted job, whatever its status', () => {
    expect(desiredPickupTask(job({ deleted: true }), texts)).toEqual({ kind: 'cancelled' })
  })
})

describe('planPickupTaskStep (pickup calendar spec "Step")', () => {
  it('creates the first task when a job is scheduled', () => {
    expect(planPickupTaskStep(planned, { link: null, actual: null })).toEqual({
      kind: 'create',
      content: planned.content,
      reuseInteractionId: null,
      previous: null,
    })
  })

  it('creates a new occurrence after a terminal current link and keeps the old one as history', () => {
    for (const state of ['completed', 'cancelled'] as const) {
      expect(planPickupTaskStep(planned, current(state, matching))).toMatchObject({ kind: 'create', reuseInteractionId: null, previous: 'keep' })
    }
  })

  it('never creates a terminal task', () => {
    for (const desired of [{ kind: 'completed' }, { kind: 'cancelled' }] as const) {
      expect(planPickupTaskStep(desired, { link: null, actual: null })).toEqual({ kind: 'none' })
      expect(planPickupTaskStep(desired, current('completed', null))).toEqual({ kind: 'none' })
    }
  })

  it('retries an unconfirmed create with the same interaction id', () => {
    expect(planPickupTaskStep(planned, current('creating', null))).toEqual({
      kind: 'create',
      content: planned.content,
      reuseInteractionId: ID,
      previous: null,
    })
  })

  it('drops an unconfirmed create when the job no longer needs a planned task', () => {
    expect(planPickupTaskStep({ kind: 'cancelled' }, current('creating', null))).toEqual({ kind: 'mark_lost' })
  })

  it('finalizes a create that landed before its finalize was recorded', () => {
    expect(planPickupTaskStep(planned, current('creating', matching))).toEqual({ kind: 'finalize', state: 'planned' })
  })

  it('does nothing when the planned task matches', () => {
    expect(planPickupTaskStep(planned, current('planned', matching))).toEqual({ kind: 'none' })
  })

  it.each([
    ['date', { scheduledAt: new Date('2026-10-20T12:00:00.000Z') }],
    ['owner', { ownerUserId: null }],
    ['title', { title: 'Edited' }],
    ['body', { body: '' }],
    ['duration', { durationMinutes: 30 }],
  ])('updates drift in %s', (_label, change) => {
    expect(planPickupTaskStep(planned, current('planned', { ...matching, ...change }))).toEqual({
      kind: 'update',
      content: planned.content,
      reopen: false,
    })
  })

  it.each(['done', 'canceled'])('reopens a task set to %s outside the sync', (status) => {
    expect(planPickupTaskStep(planned, current('planned', { ...matching, status }))).toEqual({
      kind: 'update',
      content: planned.content,
      reopen: true,
    })
  })

  it('replaces a planned task deleted outside the sync and marks the old link lost', () => {
    expect(planPickupTaskStep(planned, current('planned', null))).toEqual({
      kind: 'create',
      content: planned.content,
      reuseInteractionId: null,
      previous: 'lost',
    })
  })

  it('marks a vanished task lost when the job no longer needs it', () => {
    expect(planPickupTaskStep({ kind: 'completed' }, current('planned', null))).toEqual({ kind: 'mark_lost' })
  })

  it('completes and cancels a planned task', () => {
    expect(planPickupTaskStep({ kind: 'completed' }, current('planned', matching))).toEqual({ kind: 'complete' })
    expect(planPickupTaskStep({ kind: 'cancelled' }, current('planned', matching))).toEqual({ kind: 'cancel' })
  })

  it('only records the state when the task already has it', () => {
    expect(planPickupTaskStep({ kind: 'completed' }, current('planned', { ...matching, status: 'done' }))).toEqual({
      kind: 'finalize',
      state: 'completed',
    })
    expect(planPickupTaskStep({ kind: 'cancelled' }, current('planned', { ...matching, status: 'canceled' }))).toEqual({
      kind: 'finalize',
      state: 'cancelled',
    })
  })

  it('never cancels a completed occurrence', () => {
    expect(planPickupTaskStep({ kind: 'cancelled' }, current('completed', { ...matching, status: 'done' }))).toEqual({ kind: 'none' })
  })
})

describe('linkStateAfter', () => {
  it('maps each step to the link state it leaves', () => {
    expect(linkStateAfter({ kind: 'none' })).toBeNull()
    expect(linkStateAfter({ kind: 'mark_lost' })).toBe('lost')
    expect(linkStateAfter({ kind: 'complete' })).toBe('completed')
    expect(linkStateAfter({ kind: 'cancel' })).toBe('cancelled')
    expect(linkStateAfter({ kind: 'update', content: planned.content, reopen: true })).toBe('planned')
    expect(linkStateAfter({ kind: 'create', content: planned.content, reuseInteractionId: null, previous: null })).toBe('planned')
  })
})

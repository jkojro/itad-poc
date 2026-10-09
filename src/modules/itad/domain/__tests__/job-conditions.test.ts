import { describe, expect, it } from '@jest/globals'
import { decideTransition, type ConditionDeps, type ConditionJob } from '../job-conditions'
import type { ReceivingFacts } from '../reconciliation'

const readyToProcess: ReceivingFacts = { activeManifestItems: 10, pendingDuplicates: 0, differentDeviceUnresolved: 0 }
const deps = (overrides: Partial<ConditionDeps> = {}, facts: ReceivingFacts = readyToProcess): ConditionDeps => ({
  isCustomerValid: async () => true,
  loadReceivingFacts: async () => facts,
  ...overrides,
})
const validCustomer = deps()
const invalidCustomer = deps({ isCustomerValid: async () => false })

const job = (overrides: Partial<ConditionJob> = {}): ConditionJob => ({
  id: '22222222-2222-4222-8222-222222222222',
  status: 'draft',
  customerId: '11111111-1111-4111-8111-111111111111',
  name: 'Bank refresh',
  scheduledPickupAt: new Date('2026-10-10T08:00:00.000Z'),
  ...overrides,
})

describe('decideTransition (spec TEST-002)', () => {
  it('rejects an action that is not valid from the current status', async () => {
    const decision = await decideTransition({ job: job({ status: 'draft' }), action: 'dispatch', deps: validCustomer })
    expect(decision).toMatchObject({ ok: false, rejection: { code: 'transition_not_allowed' } })
  })

  it('schedules when the data condition is met', async () => {
    const decision = await decideTransition({ job: job(), action: 'schedule', deps: validCustomer })
    expect(decision).toMatchObject({ ok: true, target: 'scheduled', confirmations: [] })
  })

  it('blocks scheduling without a pickup date or with an invalid customer', async () => {
    const noPickup = await decideTransition({ job: job({ scheduledPickupAt: null }), action: 'schedule', deps: validCustomer })
    expect(noPickup).toMatchObject({ ok: false, rejection: { code: 'condition_unmet', conditions: ['schedulingDataComplete'] } })
    const badCustomer = await decideTransition({ job: job(), action: 'schedule', deps: invalidCustomer })
    expect(badCustomer).toMatchObject({ ok: false, rejection: { code: 'condition_unmet' } })
  })

  it('never accepts a manual confirmation for a data condition', async () => {
    const decision = await decideTransition({
      job: job({ scheduledPickupAt: null }),
      action: 'schedule',
      confirmations: [{ condition: 'schedulingDataComplete', comment: 'trust me' }],
      deps: validCustomer,
    })
    expect(decision).toMatchObject({ ok: false, rejection: { code: 'confirmation_not_allowed' } })
  })

  it('requires a confirmation for a manual condition', async () => {
    const decision = await decideTransition({ job: job({ status: 'processing' }), action: 'start_closeout', deps: validCustomer })
    expect(decision).toMatchObject({ ok: false, rejection: { code: 'condition_unmet', conditions: ['allAssetsProcessed'] } })
  })

  it('accepts a valid manual confirmation and returns it trimmed', async () => {
    const decision = await decideTransition({
      job: job({ status: 'processing' }),
      action: 'start_closeout',
      confirmations: [{ condition: 'allAssetsProcessed', comment: '  all erased  ' }],
      deps: validCustomer,
    })
    expect(decision).toMatchObject({
      ok: true,
      target: 'closeout_review',
      confirmations: [{ condition: 'allAssetsProcessed', comment: 'all erased' }],
    })
  })

  it('needs every condition of complete confirmed', async () => {
    const partial = await decideTransition({
      job: job({ status: 'closeout_review' }),
      action: 'complete',
      confirmations: [{ condition: 'noBlockingExceptions', comment: 'none open' }],
      deps: validCustomer,
    })
    expect(partial).toMatchObject({ ok: false, rejection: { code: 'condition_unmet', conditions: ['requiredDocumentsComplete'] } })
  })

  it.each([
    ['duplicate', [{ condition: 'allAssetsProcessed', comment: 'one' }, { condition: 'allAssetsProcessed', comment: 'two' }], 'confirmation_duplicate'],
    ['not required by the action', [{ condition: 'noBlockingExceptions', comment: 'done' }], 'confirmation_not_required'],
    ['unknown condition', [{ condition: 'madeUp', comment: 'done' }], 'confirmation_not_required'],
    ['missing comment', [{ condition: 'allAssetsProcessed', comment: '' }], 'comment_required'],
    ['too short comment', [{ condition: 'allAssetsProcessed', comment: 'ok' }], 'comment_required'],
  ])('rejects a %s confirmation', async (_label, confirmations, code) => {
    const decision = await decideTransition({
      job: job({ status: 'processing' }),
      action: 'start_closeout',
      confirmations,
      deps: validCustomer,
    })
    expect(decision).toMatchObject({ ok: false, rejection: { code } })
  })

  it('requires a reason for hold, cancel and backward moves', async () => {
    for (const [status, action] of [
      ['scheduled', 'hold'],
      ['processing', 'cancel'],
      ['scheduled', 'unschedule'],
      ['in_transit', 'return_to_scheduled'],
    ] as const) {
      const missing = await decideTransition({ job: job({ status }), action, deps: validCustomer })
      expect(missing).toMatchObject({ ok: false, rejection: { code: 'reason_required' } })
      const given = await decideTransition({ job: job({ status }), action, reason: 'pickup failed', deps: validCustomer })
      expect(given.ok).toBe(true)
    }
  })

  describe('receivingComplete from data (manifest spec TEST-104)', () => {
    const startProcessing = (facts: ReceivingFacts, confirmations?: Array<{ condition: string; comment: string }>) =>
      decideTransition({ job: job({ status: 'receiving' }), action: 'start_processing', confirmations, deps: deps({}, facts) })

    it('lets receiving finish with missing and unexpected devices once the manifest is there and duplicates are closed', async () => {
      expect(await startProcessing(readyToProcess)).toMatchObject({ ok: true, target: 'processing', confirmations: [] })
    })

    it.each([
      ['no manifest', { activeManifestItems: 0, pendingDuplicates: 0, differentDeviceUnresolved: 0 }, 'manifestMissing'],
      ['a pending duplicate', { activeManifestItems: 3, pendingDuplicates: 1, differentDeviceUnresolved: 0 }, 'duplicatesPending'],
      ['a different-device duplicate', { activeManifestItems: 3, pendingDuplicates: 0, differentDeviceUnresolved: 1 }, 'differentDeviceUnresolved'],
    ])('blocks with %s', async (_label, facts, detail) => {
      const decision = await startProcessing(facts)
      expect(decision).toMatchObject({ ok: false, rejection: { code: 'condition_unmet', conditions: ['receivingComplete'] } })
      expect(decision.evaluations).toEqual([
        { key: 'receivingComplete', state: 'unmet', detailKey: `itad.jobs.conditions.detail.${detail}` },
      ])
    })

    it('rejects a manual confirmation of receivingComplete', async () => {
      const decision = await startProcessing(readyToProcess, [{ condition: 'receivingComplete', comment: 'counted by hand' }])
      expect(decision).toMatchObject({ ok: false, rejection: { code: 'confirmation_not_allowed', condition: 'receivingComplete' } })
    })
  })
})

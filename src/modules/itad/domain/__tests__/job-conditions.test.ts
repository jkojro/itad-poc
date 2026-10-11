import { describe, expect, it } from '@jest/globals'
import { decideTransition, type ConditionDeps, type ConditionJob, type ProcessingFacts } from '../job-conditions'
import type { ReceivingFacts } from '../reconciliation'

const readyToProcess: ReceivingFacts = { activeManifestItems: 10, pendingDuplicates: 0, differentDeviceUnresolved: 0, dataBearingUndecided: 0 }
const nothingPending: ProcessingFacts = { sanitizationPending: 0 }
const deps = (
  overrides: Partial<ConditionDeps> = {},
  facts: ReceivingFacts = readyToProcess,
  processing: ProcessingFacts = nothingPending,
): ConditionDeps => ({
  isCustomerValid: async () => true,
  loadReceivingFacts: async () => facts,
  loadProcessingFacts: async () => processing,
  loadExceptionFacts: async () => ({ openExceptions: 0 }),
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

  it('needs the documents confirmation of complete; exceptions come from data (exceptions spec E4-031)', async () => {
    const partial = await decideTransition({ job: job({ status: 'closeout_review' }), action: 'complete', deps: validCustomer })
    expect(partial).toMatchObject({ ok: false, rejection: { code: 'condition_unmet', conditions: ['requiredDocumentsComplete'] } })
    const confirmed = await decideTransition({
      job: job({ status: 'closeout_review' }),
      action: 'complete',
      confirmations: [{ condition: 'requiredDocumentsComplete', comment: 'all documents filed' }],
      deps: validCustomer,
    })
    expect(confirmed).toMatchObject({ ok: true, target: 'completed' })
  })

  it('blocks complete while an exception is open; a manual confirmation is not allowed', async () => {
    const withOpen = deps({ loadExceptionFacts: async () => ({ openExceptions: 2 }) })
    const blocked = await decideTransition({
      job: job({ status: 'closeout_review' }),
      action: 'complete',
      confirmations: [{ condition: 'requiredDocumentsComplete', comment: 'all documents filed' }],
      deps: withOpen,
    })
    expect(blocked).toMatchObject({ ok: false, rejection: { code: 'condition_unmet', conditions: ['noBlockingExceptions'] } })
    expect(blocked.evaluations).toContainEqual({
      key: 'noBlockingExceptions',
      state: 'unmet',
      detailKey: 'itad.jobs.conditions.detail.openExceptions',
    })
    const manual = await decideTransition({
      job: job({ status: 'closeout_review' }),
      action: 'complete',
      confirmations: [{ condition: 'noBlockingExceptions', comment: 'none open' }],
      deps: validCustomer,
    })
    expect(manual).toMatchObject({ ok: false, rejection: { code: 'confirmation_not_allowed', condition: 'noBlockingExceptions' } })
  })

  it.each([
    ['duplicate', [{ condition: 'allAssetsProcessed', comment: 'one' }, { condition: 'allAssetsProcessed', comment: 'two' }], 'confirmation_duplicate'],
    ['not required by the action', [{ condition: 'requiredDocumentsComplete', comment: 'done' }], 'confirmation_not_required'],
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
      ['no manifest', { activeManifestItems: 0, pendingDuplicates: 0, differentDeviceUnresolved: 0, dataBearingUndecided: 0 }, 'manifestMissing'],
      ['a pending duplicate', { activeManifestItems: 3, pendingDuplicates: 1, differentDeviceUnresolved: 0, dataBearingUndecided: 0 }, 'duplicatesPending'],
      ['a different-device duplicate', { activeManifestItems: 3, pendingDuplicates: 0, differentDeviceUnresolved: 1, dataBearingUndecided: 0 }, 'differentDeviceUnresolved'],
      ['an asset not yet classified as carrying data or not', { activeManifestItems: 3, pendingDuplicates: 0, differentDeviceUnresolved: 0, dataBearingUndecided: 2 }, 'dataBearingUndecided'],
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

  describe('allAssetsProcessed with sanitization pending (sanitization spec TEST-303, closeout part)', () => {
    const CONFIRM = [{ condition: 'allAssetsProcessed', comment: 'All graded and packed' }]
    const closeout = (processing: ProcessingFacts, confirmations?: Array<{ condition: string; comment: string }>) =>
      decideTransition({ job: job({ status: 'processing' }), action: 'start_closeout', confirmations, deps: deps({}, readyToProcess, processing) })

    it('is unmet while data-bearing devices are not sanitized, and a confirmation cannot override it', async () => {
      const blocked = await closeout({ sanitizationPending: 2 })
      expect(blocked).toMatchObject({ ok: false, rejection: { code: 'condition_unmet', conditions: ['allAssetsProcessed'] } })
      expect(blocked.evaluations).toEqual([
        { key: 'allAssetsProcessed', state: 'unmet', detailKey: 'itad.jobs.conditions.detail.sanitizationPending' },
      ])
      expect(await closeout({ sanitizationPending: 2 }, CONFIRM)).toMatchObject({
        ok: false,
        rejection: { code: 'condition_unmet', conditions: ['allAssetsProcessed'] },
      })
    })

    it('needs the manual confirmation once everything is sanitized', async () => {
      expect(await closeout(nothingPending)).toMatchObject({ ok: false, rejection: { code: 'condition_unmet' } })
      expect(await closeout(nothingPending, CONFIRM)).toMatchObject({ ok: true, target: 'closeout_review' })
    })
  })
})

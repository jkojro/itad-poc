import { describe, expect, it } from '@jest/globals'
import { buildActions, customerSafeBlockers, messageMatchStatus, orderedIntents, quoteSource, type MatchLevels } from '../inbox-proposals'
import type { InboxExtraction } from '../inbox'

/** ITAD Inbox Ops spec "Validate and propose", "Intents and actions", "Draft reply". */
describe('inbox proposals', () => {
  const parts = {
    currentText: 'Please move the pickup to 3 November at 13:00. The laptop SN-0010 was never shipped, it stayed on site.',
    subject: 'Re: ITAD-2026-00042',
    history: ['Earlier: pickup on 20 October at 10:00'],
  }
  const levels: MatchLevels = {
    customer: { id: 'cust-1', status: 'high' },
    job: { id: 'job-1', status: 'high' },
    jobContext: {
      id: 'job-1',
      updatedAt: '2026-10-24T08:00:00.000Z',
      exceptions: [
        { id: 'ex-1', type: 'missing_from_delivery', status: 'open', serial: 'SN-0010', updatedAt: '2026-10-24T08:00:01.000Z' },
        { id: 'ex-2', type: 'unexpected_asset', status: 'open', serial: 'SN-0099', updatedAt: '2026-10-24T08:00:02.000Z' },
      ],
    },
  }
  const extraction = (intents: InboxExtraction['intents']): InboxExtraction => ({ intents, summary: 's', language: 'en' })

  it('locates a model quote in the current text, only in the history, or nowhere', () => {
    expect(quoteSource(parts, '3  November at 13:00')).toBe('current')
    expect(quoteSource(parts, '20 October at 10:00')).toBe('history')
    expect(quoteSource(parts, 'next Tuesday')).toBeNull()
  })

  it('builds I2 and I3 from one email, each with its own target and version (several intents)', () => {
    const actions = buildActions(
      parts,
      extraction([
        { intent: 'pickup_date_change', confidence: 'high', scheduledPickup: { value: { localDateTime: '2026-11-03T13:00', timeZone: null }, quote: '3 November at 13:00' } },
        {
          intent: 'exception_clarification',
          confidence: 'high',
          serials: [{ value: 'SN-0010', quote: 'SN-0010' }],
          outcome: { value: 'not_shipped', quote: 'was never shipped' },
          reason: { value: 'it stayed on site', quote: 'it stayed on site' },
        },
      ]),
      levels,
    )
    expect(actions).toHaveLength(2)
    expect(actions[0]).toMatchObject({
      type: 'update_pickup',
      target: { jobId: 'job-1' },
      payload: { scheduledPickupAt: '2026-11-03T13:00' },
      fieldSources: { scheduledPickupAt: 'model' },
      missingFields: [],
      matchStatus: 'high',
      targetVersion: '2026-10-24T08:00:00.000Z',
    })
    expect(actions[1]).toMatchObject({
      type: 'resolve_exception',
      target: { jobId: 'job-1', exceptionId: 'ex-1' },
      payload: { outcome: 'not_shipped', reason: 'it stayed on site' },
      matchStatus: 'high',
      targetVersion: '2026-10-24T08:00:01.000Z',
    })
    expect(orderedIntents(extraction([{ intent: 'status_inquiry', confidence: 'high' }, { intent: 'status_inquiry', confidence: 'high' }]))).toEqual(['status_inquiry'])
  })

  it('never executes a value found only in the quoted history, nor an invented one', () => {
    const [historyOnly] = buildActions(
      parts,
      extraction([{ intent: 'pickup_date_change', confidence: 'high', scheduledPickup: { value: { localDateTime: '2026-10-20T10:00', timeZone: null }, quote: '20 October at 10:00' } }]),
      levels,
    )
    expect(historyOnly).toMatchObject({ payload: {}, missingFields: ['scheduledPickupAt'], matchStatus: 'needs_review' })
    const [invented] = buildActions(
      parts,
      extraction([{ intent: 'pickup_date_change', confidence: 'high', scheduledPickup: { value: { localDateTime: '2026-11-10T09:00', timeZone: null }, quote: '10 November' } }]),
      levels,
    )
    expect(invented.missingFields).toEqual(['scheduledPickupAt'])
  })

  it('drops an outcome the exception type does not allow, and leaves an unknown serial for the operator', () => {
    const [wrongOutcome] = buildActions(
      parts,
      extraction([
        { intent: 'exception_clarification', confidence: 'high', serials: [{ value: 'SN-0010', quote: 'SN-0010' }], outcome: { value: 'accepted_into_job', quote: 'was never shipped' }, reason: { value: 'it stayed on site', quote: 'it stayed on site' } },
      ]),
      levels,
    )
    expect(wrongOutcome).toMatchObject({ target: { exceptionId: 'ex-1' }, missingFields: ['outcome'], matchStatus: 'needs_review' })
    const [unknownSerial] = buildActions(parts, extraction([{ intent: 'exception_clarification', confidence: 'high', serials: [{ value: 'XX-1', quote: 'laptop' }] }]), levels)
    expect(unknownSerial.target).toEqual({ jobId: 'job-1' })
    expect(unknownSerial.missingFields).toEqual(expect.arrayContaining(['exceptionId']))
  })

  it('builds I1 with the customer as target and a suggested name; I4 proposes no action', () => {
    const [create] = buildActions(
      { ...parts, currentText: 'We need a pickup of about 40 laptops at Main St 5, Warsaw. Our PO is PO-7781.' },
      extraction([
        {
          intent: 'new_pickup',
          confidence: 'high',
          suggestedName: 'Laptop refresh',
          expectedAssetEstimate: { value: 40, quote: 'about 40 laptops' },
          pickupLocation: { value: 'Main St 5, Warsaw', quote: 'Main St 5, Warsaw' },
          customerReference: { value: 'PO-7781', quote: 'PO-7781' },
        },
      ]),
      levels,
    )
    expect(create).toMatchObject({
      type: 'create_job',
      target: { customerId: 'cust-1' },
      payload: { name: 'Laptop refresh', expectedAssetEstimate: 40, pickupLocation: 'Main St 5, Warsaw', customerReference: 'PO-7781' },
      missingFields: [],
    })
    expect(buildActions(parts, extraction([{ intent: 'status_inquiry', confidence: 'high' }]), levels)).toEqual([])
  })

  it('shows the worst action status on the message, or the job match when there is no action', () => {
    expect(messageMatchStatus([{ matchStatus: 'high' }, { matchStatus: 'ambiguous' }], levels)).toBe('ambiguous')
    expect(messageMatchStatus([], { customer: { id: 'c', status: 'high' }, job: { id: 'j', status: 'needs_review' } })).toBe('needs_review')
    // Two candidate jobs of one customer: the message is ambiguous, not the customer's needs review.
    expect(messageMatchStatus([], { customer: { id: 'c', status: 'needs_review' }, job: { id: null, status: 'ambiguous' } })).toBe('ambiguous')
    expect(messageMatchStatus([], { customer: { id: 'c', status: 'needs_review' }, job: { id: null, status: 'needs_review' } })).toBe('needs_review')
  })

  it('tells the customer only categories and counts', () => {
    const counters = {
      expected: 10, received: 8, missing: 2, unexpected: 0, totalIntake: 8, awaitingWipe: 3, sanitized: 4, failed: 1,
      sanitizationScope: 8, dataBearingUnknown: 0, unresolvedDuplicates: 0, openExceptions: 3, openMissingExceptions: 2,
      openUnexpectedExceptions: 0, certificatesRequired: 4, certificatesIssued: 2, certificatesMissing: 2,
    }
    expect(customerSafeBlockers(counters)).toEqual([
      { key: 'awaiting_devices', count: 2 },
      { key: 'awaiting_erasure', count: 3 },
      { key: 'erasure_failed', count: 1 },
      { key: 'awaiting_certificates', count: 2 },
    ])
  })
})

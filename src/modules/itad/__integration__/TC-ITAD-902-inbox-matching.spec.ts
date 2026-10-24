import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, createPersonFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { createSchedulableJob, getJob, transitionOk, uniqueSuffix } from './itad-job-fixtures'
import { importInboxMessage, postMessageAction, statusInquiry, waitProcessed } from './itad-inbox-fixtures'

/**
 * TC-ITAD-902 (Inbox Ops spec "Match status", PDF §4.3): an explicit job reference in the
 * message is `high` and beats the sender heuristic; sender → customer → exactly one active
 * job is `needs_review` (never `high`); two active jobs of the sender's customer are
 * `ambiguous`; an unknown reference matches nothing. A date the model quotes but the
 * email does not contain is dropped (TC-ITAD-903 part). Reprocess runs a new generation and
 * leaves one set of actions.
 */
test.describe('TC-ITAD-902: Inbox matching', () => {
  test('reference high; sender needs review; two jobs ambiguous; invented date dropped; reprocess', async ({ request }) => {
    test.setTimeout(180_000)
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    const companies: string[] = []
    try {
      const companyA = await createCompanyFixture(request, token, `QA Inbox A ${suffix}`)
      const companyB = await createCompanyFixture(request, token, `QA Inbox B ${suffix}`)
      companies.push(companyA, companyB)
      const senderA = `qa-a-${suffix}@customer-a.example`
      const senderB = `qa-b-${suffix}@customer-b.example`
      await createPersonFixture(request, token, { firstName: 'Anna', lastName: 'A', displayName: `Anna A ${suffix}`, companyEntityId: companyA, primaryEmail: senderA })
      await createPersonFixture(request, token, { firstName: 'Bob', lastName: 'B', displayName: `Bob B ${suffix}`, companyEntityId: companyB, primaryEmail: senderB })
      const jobA = await createSchedulableJob(request, token, companyA, `QA inbox A ${suffix}`)
      const jobB1 = await createSchedulableJob(request, token, companyB, `QA inbox B1 ${suffix}`)
      const jobB2 = await createSchedulableJob(request, token, companyB, `QA inbox B2 ${suffix}`)

      // Explicit reference in the message: high, and it wins over the sender of another customer.
      const byReference = await waitProcessed(
        request,
        token,
        await importInboxMessage(request, token, { fromAddress: senderB, subject: 'Question', bodyText: `How is ${jobA.internalReference} going?`, extraction: statusInquiry() }),
      )
      expect(byReference).toMatchObject({ status: 'proposed', matchStatus: 'high', match: { job: { id: jobA.id, reference: jobA.internalReference } } })

      // Sender → customer → exactly one active job: needs review.
      const bySender = await waitProcessed(
        request,
        token,
        await importInboxMessage(request, token, { fromAddress: senderA, subject: 'Status?', bodyText: 'Hi, how are our devices doing?', extraction: statusInquiry() }),
      )
      expect(bySender).toMatchObject({ matchStatus: 'needs_review', match: { job: { id: jobA.id } } })
      expect(bySender.match.jobCandidates[0].evidence[0]).toMatchObject({ kind: 'sender_email', source: 'sender' })

      // Two active jobs of the sender's customer: ambiguous, no job chosen.
      const ambiguous = await waitProcessed(
        request,
        token,
        await importInboxMessage(request, token, { fromAddress: senderB, subject: 'Status?', bodyText: 'Hi, how are our devices doing?', extraction: statusInquiry() }),
      )
      expect(ambiguous).toMatchObject({ matchStatus: 'ambiguous', match: { job: null } })
      expect(ambiguous.match.jobCandidates.map((candidate: any) => candidate.job.id).sort()).toEqual([jobB1.id, jobB2.id].sort())

      // An unknown reference from an unknown sender matches nothing.
      const unknown = await waitProcessed(
        request,
        token,
        await importInboxMessage(request, token, { fromAddress: `nobody-${suffix}@nowhere.example`, subject: 'ITAD-1999-99999', bodyText: 'Where is ITAD-1999-99999?', extraction: statusInquiry() }),
      )
      expect(unknown.match).toMatchObject({ job: null, customer: null })

      // A date the model quotes but the email does not contain is dropped (never invented).
      await transitionOk(request, token, jobA.id, { action: 'schedule' })
      const pickupBefore = (await getJob(request, token, jobA.id))!.scheduledPickupAt
      const moved = await waitProcessed(
        request,
        token,
        await importInboxMessage(request, token, {
          fromAddress: senderA,
          subject: `Pickup ${jobA.internalReference}`,
          bodyText: `Could you move the pickup of ${jobA.internalReference}? Thanks.`,
          extraction: {
            intents: [{ intent: 'pickup_date_change', confidence: 'high', scheduledPickup: { value: { localDateTime: '2026-12-01T10:00', timeZone: 'Europe/Warsaw' }, quote: '1 December at 10:00' } }],
            summary: 'Move pickup',
            language: 'en',
          },
        }),
      )
      expect(moved.actions).toHaveLength(1)
      expect(moved.actions[0]).toMatchObject({ type: 'update_pickup', matchStatus: 'needs_review', missingFields: ['scheduledPickupAt'], payload: {} })
      expect(moved.actions[0].target.job.id).toBe(jobA.id)
      expect((await getJob(request, token, jobA.id))!.scheduledPickupAt).toBe(pickupBefore)

      // Reprocess: a new generation; the old action is superseded, exactly one set remains.
      const reprocessed = await postMessageAction(request, token, moved.id, 'reprocess', moved.updatedAt)
      expect(reprocessed.status, JSON.stringify(reprocessed.body)).toBe(200)
      const again = await waitProcessed(request, token, moved.id)
      expect(again.generation).toBe(2)
      expect(again.actions).toHaveLength(1)
      expect(again.actions[0].id).not.toBe(moved.actions[0].id)
    } finally {
      for (const id of companies) await deleteEntityIfExists(request, token, '/api/customers/companies', id)
    }
  })
})

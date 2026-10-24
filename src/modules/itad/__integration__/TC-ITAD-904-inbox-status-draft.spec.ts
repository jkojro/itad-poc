import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { createSchedulableJob, uniqueSuffix } from './itad-job-fixtures'
import { currentAssets, processingJobWithDataBearingAssets, recordResult, startRunOk } from './itad-sanitization-fixtures'
import { importInboxMessage, postMessageAction, statusInquiry, waitProcessed } from './itad-inbox-fixtures'

/**
 * TC-ITAD-904 (Inbox Ops spec "Draft reply", US-IN-04, demo step 8): a status inquiry gets a
 * draft from the job's current counts and customer-safe blockers (no internal notes, people
 * or exception reasons); after the job changes, Refresh draft shows the new numbers; a
 * view-only user cannot refresh; nothing is sent.
 */
test.describe('TC-ITAD-904: Inbox status draft', () => {
  test('draft from current facts; refresh after a change; refresh needs manage', async ({ request }) => {
    test.setTimeout(180_000)
    const token = await getAuthToken(request, 'admin')
    const employeeToken = await getAuthToken(request, 'employee')
    const suffix = uniqueSuffix()
    let companyId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA Inbox Draft ${suffix}`)
      const job = await createSchedulableJob(request, token, companyId, `QA inbox draft ${suffix}`)
      const assets = await processingJobWithDataBearingAssets(request, token, job.id, 3)

      const message = await waitProcessed(
        request,
        token,
        await importInboxMessage(request, token, {
          fromAddress: `qa-draft-${suffix}@customer.example`,
          fromName: 'Anna',
          subject: `Status of ${job.internalReference}`,
          bodyText: `Hello, how is ${job.internalReference} going?`,
          extraction: statusInquiry(),
        }),
      )
      expect(message.intents).toEqual(['status_inquiry'])
      expect(message.actions).toEqual([])
      expect(message.draftReply).toContain(job.internalReference)
      expect(message.draftReply).toContain('3 devices are waiting for data erasure.')
      expect(message.draftReply).not.toMatch(/Readable sectors|admin@|employee@/)

      // The job changes: one wipe fails.
      const runId = await startRunOk(request, token, job.id, (await currentAssets(request, token, job.id, assets.map((asset) => asset.serial)))[0])
      expect((await recordResult(request, token, job.id, runId, { result: 'FAIL', verificationMethod: 'full_verification', verificationNotes: 'Readable sectors' })).status()).toBe(200)

      // A view-only user may read the draft but not rebuild it.
      expect((await postMessageAction(request, employeeToken, message.id, 'draft', message.updatedAt)).status).toBe(403)

      const refreshed = await postMessageAction(request, token, message.id, 'draft', message.updatedAt)
      expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200)
      expect(refreshed.body?.draftReply).toContain('2 devices are waiting for data erasure.')
      expect(refreshed.body?.draftReply).toContain('1 devices need another data-erasure attempt.')
      // The internal verification note never reaches the customer draft.
      expect(refreshed.body?.draftReply).not.toContain('Readable sectors')
    } finally {
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { deleteRoleIfExists, deleteUserIfExists } from '@open-mercato/core/helpers/integration/authFixtures'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { getTokenScope } from '@open-mercato/core/helpers/integration/generalFixtures'
import { uniqueSuffix } from './itad-job-fixtures'
import { jobWithOpenReconciliationExceptions, tokenWithFeatures, type Cleanup } from './itad-ai-fixtures'
import { importInboxMessage, inboxDetail, listInbox, waitProcessed } from './itad-inbox-fixtures'

/**
 * TC-ITAD-912 (Inbox Ops spec "Read access"): `itad.inbox.view` grants the email and the
 * proposal's shape, never more. Without `itad.exceptions.view` the reader sees that an
 * action resolves an exception but not which (no serial); without `itad.jobs.view` the job
 * reference, candidates and the draft reply are hidden — in the detail and in the list.
 */
test.describe('TC-ITAD-912: Inbox read access', () => {
  test('inbox.view alone sees the email and the proposal shape, not job or exception details', async ({ request }) => {
    test.setTimeout(180_000)
    const token = await getAuthToken(request, 'admin')
    const { tenantId, organizationId } = getTokenScope(token)
    const suffix = uniqueSuffix()
    const cleanup: Cleanup = { roleIds: [], userIds: [] }
    let companyId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA Inbox Access ${suffix}`)
      const { jobId, reference, missing } = await jobWithOpenReconciliationExceptions(request, token, companyId, `QA inbox access ${suffix}`)
      const id = await importInboxMessage(request, token, {
        fromAddress: `qa-access-${suffix}@customer.example`,
        subject: `About ${reference}`,
        bodyText: `${reference}: the device ${missing.serial} was never shipped, it stayed on site.`,
        extraction: {
          intents: [
            {
              intent: 'exception_clarification',
              confidence: 'high',
              serials: [{ value: missing.serial, quote: missing.serial }],
              outcome: { value: 'not_shipped', quote: 'was never shipped' },
              reason: { value: 'it stayed on site', quote: 'it stayed on site' },
            },
          ],
          summary: 'Missing device not shipped',
          language: 'en',
        },
      })
      const full = await waitProcessed(request, token, id)
      expect(full.actions[0].target).toMatchObject({ job: { id: jobId, reference }, exception: { id: missing.id, serial: missing.serial } })
      expect(full.draftReply).toBeTruthy()

      const inboxOnly = await tokenWithFeatures(request, token, { label: 'inbox', suffix, tenantId, organizationId, features: ['itad.inbox.view'], cleanup })
      const limited = await inboxDetail(request, inboxOnly, id)
      // The email itself and the shape of the proposal are visible.
      expect(limited).toMatchObject({ subject: `About ${reference}`, intents: ['exception_clarification'], status: 'proposed' })
      expect(limited.actions[0]).toMatchObject({ type: 'resolve_exception', payload: { outcome: 'not_shipped' } })
      // ITAD record details are not.
      expect(limited.actions[0].target.exception).toEqual({ kind: 'exception', hidden: true })
      expect(limited.actions[0].target.job).toEqual({ hidden: true })
      expect(limited.match.job).toEqual({ hidden: true })
      expect(limited.draftReply).toBeNull()
      expect(limited.draftHidden).toBe(true)
      expect(JSON.stringify(limited.actions)).not.toContain(missing.id)

      const listed = (await listInbox(request, inboxOnly, 'pageSize=50')).items.find((item) => item.id === id)
      expect(listed?.job).toEqual({ hidden: true })

      // With jobs.view but not exceptions.view: the job is visible, the exception is not.
      const jobsToo = await tokenWithFeatures(request, token, { label: 'inboxjobs', suffix, tenantId, organizationId, features: ['itad.inbox.view', 'itad.jobs.view'], cleanup })
      const partial = await inboxDetail(request, jobsToo, id)
      expect(partial.actions[0].target.job).toMatchObject({ id: jobId, reference })
      expect(partial.actions[0].target.exception).toEqual({ kind: 'exception', hidden: true })
    } finally {
      for (const userId of cleanup.userIds) await deleteUserIfExists(request, token, userId)
      for (const roleId of cleanup.roleIds) await deleteRoleIfExists(request, token, roleId)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

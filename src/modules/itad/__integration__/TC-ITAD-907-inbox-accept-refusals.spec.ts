import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { deleteRoleIfExists, deleteUserIfExists } from '@open-mercato/core/helpers/integration/authFixtures'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { getTokenScope } from '@open-mercato/core/helpers/integration/generalFixtures'
import { advanceToReceiving, createSchedulableJob, getJob, uniqueSuffix } from './itad-job-fixtures'
import { exceptionState, jobWithOpenReconciliationExceptions, tokenWithFeatures, type Cleanup } from './itad-ai-fixtures'
import { resolveExceptionApi } from './itad-exception-fixtures'
import { acceptAction, editAction, importInboxMessage, inboxDetail, movePickup, notShipped, rejectAction, waitProcessed } from './itad-inbox-fixtures'

/**
 * TC-ITAD-907 (Inbox Ops spec "Execute and audit", "Edge cases"): Accept re-validates
 * against the current state. An exception resolved in the UI meanwhile, or a job that
 * moved to receiving, fails the action with the domain reason and writes nothing; missing
 * values block Accept; the command feature AND the target's view feature are both
 * required (`manage` does not imply `view`); a rejected action never runs.
 */
test.describe('TC-ITAD-907: Inbox accept refusals', () => {
  test('stale state fails the action; missing fields; features; reject', async ({ request }) => {
    test.setTimeout(240_000)
    const token = await getAuthToken(request, 'admin')
    const { tenantId, organizationId } = getTokenScope(token)
    const suffix = uniqueSuffix()
    const cleanup: Cleanup = { roleIds: [], userIds: [] }
    let companyId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA Inbox Refuse ${suffix}`)
      const { jobId, reference, missing, unexpected } = await jobWithOpenReconciliationExceptions(request, token, companyId, `QA inbox refuse ${suffix}`)
      const importI3 = async (serial: string) =>
        waitProcessed(
          request,
          token,
          await importInboxMessage(request, token, {
            fromAddress: `qa-refuse-${suffix}@customer.example`,
            subject: `Re: ${reference}`,
            bodyText: `${reference}: ${serial} was never shipped, it stayed on site.`,
            extraction: notShipped(serial),
          }),
        )

      // Resolved in the UI after the proposal: Accept fails the action with the domain reason.
      const stale = await importI3(missing.serial)
      expect((await resolveExceptionApi(request, token, jobId, (await exceptionState(request, token, jobId, missing.id)), 'lost_in_transit', 'Courier confirmed')).status()).toBe(200)
      const refused = await acceptAction(request, token, stale.actions[0])
      expect(refused.status).toBe(409)
      expect(refused.body).toMatchObject({ status: 'failed', error: { code: 'exception_resolved' } })
      expect((await exceptionState(request, token, jobId, missing.id)).resolutionOutcome).toBe('lost_in_transit')
      expect((await inboxDetail(request, token, stale.id)).actions[0].status).toBe('failed')

      // Features: the command's and the target's view, in the record's organization.
      const fresh = await importI3(unexpected.serial)
      // `not_shipped` is not an outcome of an unexpected device: the outcome is missing → Accept blocked.
      expect(fresh.actions[0].missingFields).toEqual(['outcome'])
      expect((await acceptAction(request, token, fresh.actions[0])).status).toBe(400)
      const manageNoView = await tokenWithFeatures(request, token, {
        label: 'inboxmanage',
        suffix,
        tenantId,
        organizationId,
        features: ['itad.inbox.view', 'itad.inbox.manage', 'itad.exceptions.manage'],
        cleanup,
      })
      expect((await acceptAction(request, manageNoView, fresh.actions[0])).status).toBe(400)
      const edited = await editAction(request, token, fresh.actions[0], { outcome: 'accepted_into_job' })
      expect(edited.status, JSON.stringify(edited.body)).toBe(200)
      const ready = (await inboxDetail(request, token, fresh.id)).actions[0]
      expect((await acceptAction(request, manageNoView, ready)).status).toBe(403)
      const viewNoManage = await tokenWithFeatures(request, token, {
        label: 'inboxview',
        suffix,
        tenantId,
        organizationId,
        features: ['itad.inbox.view', 'itad.inbox.manage', 'itad.exceptions.view', 'itad.jobs.view'],
        cleanup,
      })
      expect((await acceptAction(request, viewNoManage, ready)).status).toBe(403)

      // Rejected: never runs, the exception stays open.
      expect((await rejectAction(request, token, ready, 'Not this one')).status).toBe(200)
      expect((await exceptionState(request, token, jobId, unexpected.id)).status).toBe('open')
      expect((await acceptAction(request, token, (await inboxDetail(request, token, fresh.id)).actions[0])).status).toBe(409)

      // A job that moved to receiving after the proposal: the pickup is locked, nothing changes.
      // A draft job: its pickup is editable until receiving starts (advanceToReceiving schedules it).
      const job = await createSchedulableJob(request, token, companyId, `QA inbox refuse pickup ${suffix}`)
      const year = new Date().getUTCFullYear() + 1
      const pickup = await waitProcessed(
        request,
        token,
        await importInboxMessage(request, token, {
          fromAddress: `qa-refuse-${suffix}@customer.example`,
          subject: `Pickup ${job.internalReference}`,
          bodyText: `Move ${job.internalReference} to 3 February ${year} at 10:00 please.`,
          extraction: movePickup(`${year}-02-03T10:00`, `3 February ${year} at 10:00`),
        }),
      )
      const before = (await getJob(request, token, job.id))!.scheduledPickupAt
      await advanceToReceiving(request, token, job.id)
      const locked = await acceptAction(request, token, pickup.actions[0])
      expect(locked.status).toBe(409)
      expect(locked.body).toMatchObject({ status: 'failed', error: { code: 'field_locked' } })
      expect((await getJob(request, token, job.id))!.scheduledPickupAt).toBe(before)
    } finally {
      for (const userId of cleanup.userIds) await deleteUserIfExists(request, token, userId)
      for (const roleId of cleanup.roleIds) await deleteRoleIfExists(request, token, roleId)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

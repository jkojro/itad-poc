import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { getTokenScope } from '@open-mercato/core/helpers/integration/generalFixtures'
import { createSchedulableJob, getJob, transitionOk, uniqueSuffix } from './itad-job-fixtures'
import { latestActionLog } from './itad-ai-fixtures'
import { acceptAction, editAction, importInboxMessage, inboxDetail, movePickup, waitProcessed } from './itad-inbox-fixtures'

/**
 * TC-ITAD-906 (Inbox Ops spec "Target vs fields", US-IN-02, PDF §4.3 "edit changes the
 * payload"): the operator edits the pickup time of an I2 action and accepts it — the
 * EDITED time runs (provenance `operator`), read in the action's time zone; a target key in
 * an edit is refused (`target_not_editable`) so an action built for one job can never run
 * on another; a local time without a zone takes the operator's zone sent with Accept.
 */
test.describe('TC-ITAD-906: Inbox edit and accept the pickup change', () => {
  test('edit the time, accept → job pickup changed to the edited instant; target keys refused', async ({ request }) => {
    test.setTimeout(180_000)
    const token = await getAuthToken(request, 'admin')
    const { userId } = getTokenScope(token)
    const suffix = uniqueSuffix()
    let companyId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA Inbox Pickup ${suffix}`)
      const job = await createSchedulableJob(request, token, companyId, `QA inbox pickup ${suffix}`)
      const other = await createSchedulableJob(request, token, companyId, `QA inbox pickup other ${suffix}`)
      await transitionOk(request, token, job.id, { action: 'schedule' })
      const year = new Date().getUTCFullYear() + 1
      const message = await waitProcessed(
        request,
        token,
        await importInboxMessage(request, token, {
          fromAddress: `qa-pickup-${suffix}@customer.example`,
          subject: `Pickup ${job.internalReference}`,
          bodyText: `Please move the pickup of ${job.internalReference} to 12 January ${year} at 10:00.`,
          extraction: movePickup(`${year}-01-12T10:00`, `12 January ${year} at 10:00`),
        }),
      )
      const [action] = message.actions
      expect(action).toMatchObject({ type: 'update_pickup', matchStatus: 'high', payload: { scheduledPickupAt: `${year}-01-12T10:00`, timeZone: 'Europe/Warsaw' } })

      // A target key is never an editable field.
      const retarget = await editAction(request, token, action, { jobId: other.id })
      expect(retarget.status).toBe(400)
      expect(retarget.body?.code).toBe('target_not_editable')

      const edited = await editAction(request, token, action, { scheduledPickupAt: `${year}-01-14T09:30` })
      expect(edited.status, JSON.stringify(edited.body)).toBe(200)
      const afterEdit = await inboxDetail(request, token, message.id)
      expect(afterEdit.actions[0]).toMatchObject({ payload: { scheduledPickupAt: `${year}-01-14T09:30` }, fieldSources: { scheduledPickupAt: 'operator' } })

      // The stale (pre-edit) version is refused.
      expect((await acceptAction(request, token, action)).status).toBe(409)

      const accepted = await acceptAction(request, token, afterEdit.actions[0])
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200)
      // 09:30 in Warsaw in January (UTC+1) is 08:30 UTC.
      expect((await getJob(request, token, job.id))!.scheduledPickupAt).toBe(`${year}-01-14T08:30:00.000Z`)
      expect((await getJob(request, token, other.id))!.scheduledPickupAt).not.toBe(`${year}-01-14T08:30:00.000Z`)
      const log = await latestActionLog(request, token, job.id)
      expect(log).toMatchObject({ actorUserId: userId, commandId: 'itad.jobs.update' })
      expect(log?.context).toMatchObject({ channel: 'email', toolName: 'inbox.update_pickup', proposalId: message.id })

      // A local time without a zone takes the operator's zone sent with Accept.
      const noZone = await waitProcessed(
        request,
        token,
        await importInboxMessage(request, token, {
          fromAddress: `qa-pickup-${suffix}@customer.example`,
          subject: `Pickup again ${job.internalReference}`,
          bodyText: `Sorry, please make it ${year}-01-20 at 11:00 for ${job.internalReference}.`,
          extraction: movePickup(`${year}-01-20T11:00`, `${year}-01-20 at 11:00`, null),
        }),
      )
      const zoneAccepted = await acceptAction(request, token, noZone.actions[0], { timeZone: 'America/New_York' })
      expect(zoneAccepted.status, JSON.stringify(zoneAccepted.body)).toBe(200)
      expect((await getJob(request, token, job.id))!.scheduledPickupAt).toBe(`${year}-01-20T16:00:00.000Z`)
    } finally {
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

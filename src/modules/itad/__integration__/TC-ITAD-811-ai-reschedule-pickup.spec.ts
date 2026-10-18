import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { getTokenScope } from '@open-mercato/core/helpers/integration/generalFixtures'
import { advanceToReceiving, createSchedulableJob, getJob, transitionOk, uniqueSuffix } from './itad-job-fixtures'
import { confirmAction, deletePendingActions, seedPendingAction } from './itad-ai-fixtures'

/**
 * TC-ITAD-811 (AI assistant spec AC-AI-09, AI-REQ-15): a confirmed reschedule changes only
 * the pickup of a scheduled job; once receiving started, or when the time has passed,
 * the preview is blocked and Confirm changes nothing.
 */
test.describe('TC-ITAD-811: AI reschedule pickup', () => {
  test('changes only the pickup of a scheduled job; blocked in receiving or in the past', async ({ request }) => {
    test.setTimeout(120_000)
    const token = await getAuthToken(request, 'admin')
    const { tenantId, organizationId, userId } = getTokenScope(token)
    const suffix = uniqueSuffix()
    const actions: string[] = []
    let companyId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA AI Pickup ${suffix}`)
      const job = await createSchedulableJob(request, token, companyId, `QA AI pickup ${suffix}`)
      await transitionOk(request, token, job.id, { action: 'schedule' })
      const before = (await getJob(request, token, job.id))!
      const target = new Date(Date.now() + 3 * 86_400_000)
      target.setUTCHours(9, 0, 0, 0)
      const seed = async (jobId: string, scheduledPickupAt: string, recordVersion: string | null) => {
        const id = await seedPendingAction({
          tenantId,
          organizationId,
          createdByUserId: userId,
          toolName: 'itad.reschedule_pickup',
          normalizedInput: { jobId, scheduledPickupAt, timeZone: 'Europe/Warsaw' },
          recordVersion,
          targetEntityType: 'itad.job',
          targetRecordId: jobId,
        })
        actions.push(id)
        return id
      }

      const confirmed = await confirmAction(request, token, await seed(job.id, target.toISOString(), before.updatedAt))
      expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200)
      expect(confirmed.body).toMatchObject({ ok: true, mutationResult: { recordId: job.id, commandName: 'itad.jobs.update' } })
      const after = (await getJob(request, token, job.id))!
      expect(after).toMatchObject({ scheduledPickupAt: target.toISOString(), name: before.name, status: 'scheduled', customerReference: before.customerReference })

      // Receiving started: the preview stores a blocked version and Confirm changes nothing.
      const receiving = await createSchedulableJob(request, token, companyId, `QA AI pickup receiving ${suffix}`)
      await advanceToReceiving(request, token, receiving.id)
      const receivingBefore = (await getJob(request, token, receiving.id))!
      const locked = await confirmAction(request, token, await seed(receiving.id, target.toISOString(), 'ineligible:field_locked'))
      expect(locked.body).toMatchObject({ ok: false, pendingAction: { status: 'failed' } })
      expect(locked.body?.mutationResult?.error?.message).toContain('can no longer be rescheduled')
      expect((await getJob(request, token, receiving.id))!.scheduledPickupAt).toBe(receivingBefore.scheduledPickupAt)

      // A time in the past is refused at execute, whatever the preview said.
      const past = await confirmAction(request, token, await seed(job.id, new Date(Date.now() - 3_600_000).toISOString(), 'ineligible:time_in_past'))
      expect(past.body?.ok).toBe(false)
      expect(past.body?.mutationResult?.error?.message).toContain('in the past')
      expect((await getJob(request, token, job.id))!.scheduledPickupAt).toBe(target.toISOString())
    } finally {
      await deletePendingActions(actions)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

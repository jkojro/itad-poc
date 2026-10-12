import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { createSchedulableJob, transitionOk, uniqueSuffix } from './itad-job-fixtures'
import { waitForPickupTasks } from './itad-pickup-fixtures'

/**
 * TC-ITAD-403 (pickup calendar spec REQ-504): unschedule, hold from scheduled and cancel
 * cancel the planned task; deleting the unscheduled draft leaves it cancelled.
 */
test.describe('TC-ITAD-403: pickup task cancelled', () => {
  const cases: Array<{ label: string; actions: Array<{ action: string; reason?: string }> }> = [
    { label: 'unschedule', actions: [{ action: 'unschedule', reason: 'customer moved the date' }] },
    { label: 'hold', actions: [{ action: 'hold', reason: 'site closed' }] },
    { label: 'cancel', actions: [{ action: 'cancel', reason: 'customer withdrew' }] },
  ]
  for (const { label, actions } of cases) {
    test(`${label} cancels the planned task`, async ({ request }) => {
      const token = await getAuthToken(request, 'admin')
      const suffix = uniqueSuffix()
      let companyId: string | null = null
      try {
        companyId = await createCompanyFixture(request, token, `QA ITAD Pickup ${label} ${suffix}`)
        const job = await createSchedulableJob(request, token, companyId, `QA pickup ${label} ${suffix}`)
        await transitionOk(request, token, job.id, { action: 'schedule' })
        await waitForPickupTasks(request, token, companyId, (tasks) => tasks.length === 1, 'task after schedule')
        for (const body of actions) await transitionOk(request, token, job.id, body)
        await waitForPickupTasks(
          request,
          token,
          companyId,
          (tasks) => tasks.length === 1 && tasks[0].status === 'canceled',
          `task cancelled after ${label}`,
        )
        if (label === 'unschedule') {
          const deleted = await apiRequest(request, 'DELETE', '/api/itad/jobs', { token, data: { id: job.id } })
          expect(deleted.status()).toBe(200)
          await waitForPickupTasks(
            request,
            token,
            companyId,
            (tasks) => tasks.length === 1 && tasks[0].status === 'canceled',
            'task still cancelled after the draft is deleted',
          )
        }
      } finally {
        await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
      }
    })
  }
})

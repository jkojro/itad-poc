import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { createSchedulableJob, transitionOk, uniqueSuffix } from './itad-job-fixtures'
import { sameInstant, updateJob, waitForPickupTasks } from './itad-pickup-fixtures'

/**
 * TC-ITAD-402 (pickup calendar spec REQ-502, REQ-503): a new pickup date or job name
 * updates the same task; dispatch completes it.
 */
test.describe('TC-ITAD-402: pickup task follows the job', () => {
  test('date and name changes update the task; dispatch completes it', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    let companyId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD Pickup Sync ${suffix}`)
      const job = await createSchedulableJob(request, token, companyId, `QA pickup sync ${suffix}`)
      await transitionOk(request, token, job.id, { action: 'schedule' })
      const [created] = await waitForPickupTasks(request, token, companyId, (tasks) => tasks.length === 1, 'task after schedule')

      const moved = new Date(Date.now() + 3 * 86_400_000).toISOString()
      await updateJob(request, token, job.id, { scheduledPickupAt: moved, name: `QA pickup moved ${suffix}` })
      await waitForPickupTasks(
        request,
        token,
        companyId,
        (tasks) =>
          tasks.length === 1 &&
          tasks[0].id === created.id &&
          sameInstant(tasks[0].scheduledAt, moved) &&
          Boolean(tasks[0].title?.includes(`QA pickup moved ${suffix}`)),
        'task moved and renamed',
      )

      await transitionOk(request, token, job.id, { action: 'dispatch' })
      await waitForPickupTasks(
        request,
        token,
        companyId,
        (tasks) => tasks.length === 1 && tasks[0].id === created.id && tasks[0].status === 'done',
        'task completed on dispatch',
      )
    } finally {
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

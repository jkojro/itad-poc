import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { login } from '@open-mercato/core/helpers/integration/auth'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { createSchedulableJob, getJob, transitionOk, uniqueSuffix } from './itad-job-fixtures'
import { recordPickupSyncError, waitForPickupTasks } from './itad-pickup-fixtures'

/**
 * TC-ITAD-409 (pickup calendar spec "UI/UX", REQ-508): the job page shows the pickup task
 * section — empty before scheduling, planned after — and a recorded sync failure offers
 * "Retry calendar sync", which runs the sync and clears the warning.
 */
test.describe('TC-ITAD-409: pickup task on the job page', () => {
  test('section states and retry after a failed sync', async ({ page, request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    let companyId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD Pickup Page ${suffix}`)
      const job = await createSchedulableJob(request, token, companyId, `QA pickup page ${suffix}`)

      await login(page, 'admin')
      await page.goto(`/backend/itad/jobs/${job.id}`)
      const section = page.getByTestId('itad-pickup-task')
      await expect(section.getByText('Pickup task', { exact: true })).toBeVisible()
      await expect(section.getByText('A pickup task is created in the calendar when the job is scheduled.')).toBeVisible()

      await transitionOk(request, token, job.id, { action: 'schedule' })
      await waitForPickupTasks(request, token, companyId, (tasks) => tasks.length === 1, 'task after schedule')
      await expect.poll(async () => (await getJob(request, token, job.id))?.pickupTask?.state).toBe('planned')

      await recordPickupSyncError(job.id, 'QA forced failure')
      await page.reload()
      await expect(section.getByText('Planned')).toBeVisible()
      await expect(section.getByText('Not assigned')).toBeVisible()
      await expect(section.getByRole('link', { name: 'Open calendar' })).toHaveAttribute('href', '/backend/calendar')
      await expect(section.getByText('Calendar sync failed')).toBeVisible()
      await expect(section.getByText('QA forced failure')).toBeVisible()

      await section.getByRole('button', { name: 'Retry calendar sync' }).click()
      await expect(page.getByText('Calendar sync completed')).toBeVisible()
      await expect(section.getByText('Calendar sync failed')).toHaveCount(0)
      expect((await getJob(request, token, job.id))?.pickupTask?.lastError).toBeNull()
    } finally {
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

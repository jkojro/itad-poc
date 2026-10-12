import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { login } from '@open-mercato/core/helpers/integration/auth'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { createSchedulableJob, transitionOk, uniqueSuffix } from './itad-job-fixtures'
import { waitForPickupTasks } from './itad-pickup-fixtures'

/**
 * TC-ITAD-410 (pickup calendar spec "Go to job" widget): the calendar's event editor of a
 * pickup task shows the job reference and "Go to job" opens the job; the editor of an
 * ordinary interaction shows no widget.
 */
test.describe('TC-ITAD-410: calendar event editor links to the job', () => {
  test('pickup task editor has Go to job; an ordinary event has no widget', async ({ page, request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    let companyId: string | null = null
    let ordinaryId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD Calendar ${suffix}`)
      const soon = new Date(Date.now() + 2 * 3_600_000).toISOString()
      const job = await createSchedulableJob(request, token, companyId, `QA calendar ${suffix}`, { scheduledPickupAt: soon })
      await transitionOk(request, token, job.id, { action: 'schedule' })
      await waitForPickupTasks(request, token, companyId, (tasks) => tasks.length === 1, 'task after schedule')
      const ordinaryTitle = `QA ordinary event ${suffix}`
      const ordinary = await apiRequest(request, 'POST', '/api/customers/interactions', {
        token,
        data: { entityId: companyId, interactionType: 'meeting', title: ordinaryTitle, scheduledAt: soon, durationMinutes: 30 },
      })
      expect(ordinary.status(), await ordinary.text()).toBe(201)
      ordinaryId = (await readJsonSafe<{ id?: string }>(ordinary))?.id ?? null

      await login(page, 'admin')
      await page.goto('/backend/calendar')
      await page.getByRole('radio', { name: 'Agenda' }).click()

      await page.getByText(ordinaryTitle).last().click()
      await expect(page.getByRole('dialog')).toBeVisible()
      await expect(page.getByTestId('itad-pickup-task-job-link')).toHaveCount(0)
      await page.getByRole('button', { name: 'Cancel' }).click()
      await expect(page.getByRole('dialog')).toHaveCount(0)

      await page.getByText(job.internalReference).last().click()
      const widget = page.getByTestId('itad-pickup-task-job-link')
      await expect(widget).toBeVisible()
      await expect(widget.getByText(`ITAD pickup ${job.internalReference}`)).toBeVisible()
      await widget.getByRole('link', { name: 'Go to job' }).click()
      await expect(page).toHaveURL(new RegExp(`/backend/itad/jobs/${job.id}$`))
    } finally {
      if (ordinaryId) await apiRequest(request, 'DELETE', `/api/customers/interactions?id=${ordinaryId}`, { token }).catch(() => undefined)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { createSchedulableJob, transitionOk, uniqueSuffix } from './itad-job-fixtures'
import { waitForPickupTasks } from './itad-pickup-fixtures'

/**
 * TC-ITAD-404 (pickup calendar spec REQ-505, REQ-509): going back to scheduled creates a
 * new task; the completed one stays as history and is still protected.
 */
test.describe('TC-ITAD-404: pickup task history', () => {
  test('return_to_scheduled creates a second task; the first stays locked', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    let companyId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD Pickup History ${suffix}`)
      const job = await createSchedulableJob(request, token, companyId, `QA pickup history ${suffix}`)
      await transitionOk(request, token, job.id, { action: 'schedule' })
      const [first] = await waitForPickupTasks(request, token, companyId, (tasks) => tasks.length === 1, 'first task')
      await transitionOk(request, token, job.id, { action: 'dispatch' })
      await waitForPickupTasks(request, token, companyId, (tasks) => tasks[0]?.status === 'done', 'first task completed')

      await transitionOk(request, token, job.id, { action: 'return_to_scheduled', reason: 'truck broke down' })
      const tasks = await waitForPickupTasks(
        request,
        token,
        companyId,
        (all) => all.length === 2 && all.some((task) => task.id !== first.id && task.status === 'planned'),
        'second planned task',
      )
      expect(tasks.find((task) => task.id === first.id)?.status).toBe('done')

      const editOld = await apiRequest(request, 'PUT', '/api/customers/interactions', { token, data: { id: first.id, title: 'edited' } })
      expect(editOld.status()).toBe(422)
      const cancelOld = await apiRequest(request, 'POST', '/api/customers/interactions/cancel', { token, data: { id: first.id } })
      expect(cancelOld.status()).toBe(422)
      const deleteOld = await apiRequest(request, 'DELETE', `/api/customers/interactions?id=${first.id}`, { token })
      expect(deleteOld.status()).toBe(422)
    } finally {
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

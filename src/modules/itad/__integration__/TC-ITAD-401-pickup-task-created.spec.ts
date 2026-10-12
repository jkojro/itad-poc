import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { createSchedulableJob, getJob, transitionOk, uniqueSuffix } from './itad-job-fixtures'
import { PICKUP_TYPE, listPickupTasks, sameInstant, waitForPickupTasks } from './itad-pickup-fixtures'

/**
 * TC-ITAD-401 (pickup calendar spec REQ-501): scheduling a job creates exactly one planned
 * pickup task on the job's company, at the pickup time, for 60 minutes, titled with the
 * job reference. A draft job has none.
 */
test.describe('TC-ITAD-401: pickup task created on schedule', () => {
  test('schedule creates one planned itad-pickup task at the pickup time', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    let companyId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD Pickup ${suffix}`)
      const job = await createSchedulableJob(request, token, companyId, `QA pickup ${suffix}`, { customerReference: `PU-${suffix}` })
      expect(await listPickupTasks(request, token, companyId)).toEqual([])

      await transitionOk(request, token, job.id, { action: 'schedule' })
      const pickupAt = (await getJob(request, token, job.id))?.scheduledPickupAt ?? null
      const [task] = await waitForPickupTasks(request, token, companyId, (tasks) => tasks.length === 1, 'one pickup task after schedule')
      expect(task).toMatchObject({ interactionType: PICKUP_TYPE, status: 'planned', durationMinutes: 60, ownerUserId: null })
      expect(sameInstant(task.scheduledAt, pickupAt)).toBe(true)
      expect(task.title).toContain(job.internalReference)
      expect(task.title).toContain(`QA pickup ${suffix}`)
    } finally {
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

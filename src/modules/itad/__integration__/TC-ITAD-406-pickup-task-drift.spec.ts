import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { createSchedulableJob, getJob, transitionOk, uniqueSuffix } from './itad-job-fixtures'
import { changeTaskOutsideApi, sameInstant, updateJob, waitForPickupTasks } from './itad-pickup-fixtures'

/**
 * TC-ITAD-406 (pickup calendar spec REQ-507): a pickup task changed around the API is
 * corrected by the next job change — date restored, completed or cancelled task
 * reopened, deleted task replaced by a new one.
 */
test.describe('TC-ITAD-406: pickup task drift is corrected', () => {
  const cases = [
    { label: 'date change', change: { scheduledAt: '2030-01-01T10:00:00.000Z' } },
    { label: 'external complete', change: { status: 'done' } },
    { label: 'external cancel', change: { status: 'canceled' } },
  ]
  for (const { label, change } of cases) {
    test(`${label} is reverted`, async ({ request }) => {
      const token = await getAuthToken(request, 'admin')
      const suffix = uniqueSuffix()
      let companyId: string | null = null
      try {
        companyId = await createCompanyFixture(request, token, `QA ITAD Pickup Drift ${suffix}`)
        const job = await createSchedulableJob(request, token, companyId, `QA pickup drift ${suffix}`)
        await transitionOk(request, token, job.id, { action: 'schedule' })
        const [task] = await waitForPickupTasks(request, token, companyId, (tasks) => tasks.length === 1, 'task after schedule')
        const pickupAt = (await getJob(request, token, job.id))?.scheduledPickupAt ?? null

        await changeTaskOutsideApi(task.id, change)
        await updateJob(request, token, job.id, { name: `QA pickup drift touched ${suffix}` })
        await waitForPickupTasks(
          request,
          token,
          companyId,
          (tasks) =>
            tasks.length === 1 &&
            tasks[0].id === task.id &&
            tasks[0].status === 'planned' &&
            sameInstant(tasks[0].scheduledAt, pickupAt),
          `task restored after ${label}`,
        )
      } finally {
        await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
      }
    })
  }

  test('a deleted task is replaced by a new one', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    let companyId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD Pickup Drift Del ${suffix}`)
      const job = await createSchedulableJob(request, token, companyId, `QA pickup drift del ${suffix}`)
      await transitionOk(request, token, job.id, { action: 'schedule' })
      const [task] = await waitForPickupTasks(request, token, companyId, (tasks) => tasks.length === 1, 'task after schedule')

      await changeTaskOutsideApi(task.id, { deleted: true })
      await updateJob(request, token, job.id, { name: `QA pickup drift del touched ${suffix}` })
      const [replacement] = await waitForPickupTasks(
        request,
        token,
        companyId,
        (tasks) => tasks.length === 1 && tasks[0].id !== task.id && tasks[0].status === 'planned',
        'replacement task',
      )
      expect(replacement.title).toContain(`QA pickup drift del touched ${suffix}`)
    } finally {
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

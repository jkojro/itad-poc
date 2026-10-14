import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { createSchedulableJob, transitionOk, uniqueSuffix } from './itad-job-fixtures'
import { PICKUP_TYPE, waitForPickupTasks } from './itad-pickup-fixtures'

/**
 * TC-ITAD-405 (pickup calendar spec REQ-509, REQ-510): the customers API rejects edits,
 * cancels and deletes of a pickup task with 422 naming the job, and reserves the
 * `itad-pickup` type; an ordinary interaction on the same company still saves.
 */
test.describe('TC-ITAD-405: pickup task locked in the customers API', () => {
  test('PUT, DELETE and the reserved type get 422; other interactions still work', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    let companyId: string | null = null
    let ordinaryId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD Pickup Lock ${suffix}`)
      const job = await createSchedulableJob(request, token, companyId, `QA pickup lock ${suffix}`)
      await transitionOk(request, token, job.id, { action: 'schedule' })
      const [task] = await waitForPickupTasks(request, token, companyId, (tasks) => tasks.length === 1, 'task after schedule')

      const edit = await apiRequest(request, 'PUT', '/api/customers/interactions', { token, data: { id: task.id, title: 'moved by hand' } })
      expect(edit.status()).toBe(422)
      expect(JSON.stringify(await readJsonSafe(edit))).toContain(job.internalReference)
      // The calendar editor re-sends the interaction type with every save.
      const editorSave = await apiRequest(request, 'PUT', '/api/customers/interactions', {
        token,
        data: { id: task.id, interactionType: PICKUP_TYPE, title: 'moved in the calendar' },
      })
      expect(editorSave.status()).toBe(422)
      expect(JSON.stringify(await readJsonSafe(editorSave))).toContain(job.internalReference)
      const cancel = await apiRequest(request, 'PUT', '/api/customers/interactions', { token, data: { id: task.id, status: 'canceled' } })
      expect(cancel.status()).toBe(422)
      const remove = await apiRequest(request, 'DELETE', `/api/customers/interactions?id=${encodeURIComponent(task.id)}`, { token })
      expect(remove.status()).toBe(422)
      const reserved = await apiRequest(request, 'POST', '/api/customers/interactions', {
        token,
        data: { entityId: companyId, interactionType: PICKUP_TYPE, title: 'fake pickup', scheduledAt: new Date().toISOString() },
      })
      expect(reserved.status()).toBe(422)

      const ordinary = await apiRequest(request, 'POST', '/api/customers/interactions', {
        token,
        data: { entityId: companyId, interactionType: 'task', title: `QA ordinary ${suffix}`, scheduledAt: new Date().toISOString() },
      })
      expect(ordinary.status(), await ordinary.text()).toBe(201)
      ordinaryId = (await readJsonSafe<{ id?: string }>(ordinary))?.id ?? null
      const ordinaryEdit = await apiRequest(request, 'PUT', '/api/customers/interactions', {
        token,
        data: { id: ordinaryId, title: `QA ordinary edited ${suffix}` },
      })
      expect(ordinaryEdit.status(), await ordinaryEdit.text()).toBe(200)

      const [unchanged] = await waitForPickupTasks(request, token, companyId, (tasks) => tasks.length === 1, 'pickup task untouched')
      expect(unchanged).toMatchObject({ id: task.id, status: 'planned', title: task.title })
    } finally {
      if (ordinaryId) await apiRequest(request, 'DELETE', `/api/customers/interactions?id=${ordinaryId}`, { token }).catch(() => undefined)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

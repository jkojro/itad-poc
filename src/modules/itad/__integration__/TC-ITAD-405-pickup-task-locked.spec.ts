import { expect, test, type APIRequestContext } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { createSchedulableJob, transitionOk, uniqueSuffix } from './itad-job-fixtures'
import { PICKUP_TYPE, waitForPickupTasks } from './itad-pickup-fixtures'

/**
 * TC-ITAD-405 (pickup calendar spec REQ-509, REQ-510, TODO-501): the pickup task guard
 * runs on the `customers` interaction commands, so every route is covered — the calendar's
 * PUT and DELETE and the company page's complete and cancel. Each answers 422 with a stable
 * code and the job reference; the reserved type is refused on create and on retyping; an
 * ordinary interaction still goes through every route.
 */
type Body = { error?: string; code?: string; reference?: string }

async function expectLocked(response: Awaited<ReturnType<typeof apiRequest>>, reference: string) {
  expect(response.status(), await response.text()).toBe(422)
  const body = await readJsonSafe<Body>(response)
  expect(body).toMatchObject({ code: 'itad_pickup_task_locked', reference })
  expect(body?.error).toContain(reference)
}

async function expectReserved(response: Awaited<ReturnType<typeof apiRequest>>) {
  expect(response.status(), await response.text()).toBe(422)
  expect(await readJsonSafe<Body>(response)).toMatchObject({ code: 'itad_pickup_type_reserved' })
}

const routes = (request: APIRequestContext, token: string) => ({
  put: (data: Record<string, unknown>) => apiRequest(request, 'PUT', '/api/customers/interactions', { token, data }),
  remove: (id: string) => apiRequest(request, 'DELETE', `/api/customers/interactions?id=${encodeURIComponent(id)}`, { token }),
  complete: (id: string) => apiRequest(request, 'POST', '/api/customers/interactions/complete', { token, data: { id } }),
  cancel: (id: string) => apiRequest(request, 'POST', '/api/customers/interactions/cancel', { token, data: { id } }),
  create: (data: Record<string, unknown>) => apiRequest(request, 'POST', '/api/customers/interactions', { token, data }),
})

test.describe('TC-ITAD-405: pickup task locked on every customers route', () => {
  test('PUT, DELETE, complete and cancel get 422; the reserved type is refused; ordinary interactions still work', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const api = routes(request, token)
    const suffix = uniqueSuffix()
    let companyId: string | null = null
    const ordinaryIds: string[] = []
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD Pickup Lock ${suffix}`)
      const job = await createSchedulableJob(request, token, companyId, `QA pickup lock ${suffix}`)
      await transitionOk(request, token, job.id, { action: 'schedule' })
      const [task] = await waitForPickupTasks(request, token, companyId, (tasks) => tasks.length === 1, 'task after schedule')

      // Calendar editor: a plain edit, and a save that re-sends the pickup type.
      await expectLocked(await api.put({ id: task.id, title: 'moved by hand' }), job.internalReference)
      await expectLocked(await api.put({ id: task.id, interactionType: PICKUP_TYPE, title: 'moved in the calendar' }), job.internalReference)
      await expectLocked(await api.put({ id: task.id, status: 'canceled' }), job.internalReference)
      // Company page activities: mark as done, cancel.
      await expectLocked(await api.complete(task.id), job.internalReference)
      await expectLocked(await api.cancel(task.id), job.internalReference)
      // Delete.
      await expectLocked(await api.remove(task.id), job.internalReference)

      // Reserved type: create, and retyping an ordinary interaction.
      await expectReserved(await api.create({ entityId: companyId, interactionType: PICKUP_TYPE, title: 'fake pickup', scheduledAt: new Date().toISOString() }))

      const createOrdinary = async (title: string) => {
        const response = await api.create({ entityId: companyId, interactionType: 'task', title, scheduledAt: new Date().toISOString() })
        expect(response.status(), await response.text()).toBe(201)
        const id = (await readJsonSafe<{ id?: string }>(response))?.id ?? ''
        ordinaryIds.push(id)
        return id
      }
      const ordinary = await createOrdinary(`QA ordinary ${suffix}`)
      await expectReserved(await api.put({ id: ordinary, interactionType: PICKUP_TYPE }))
      const edited = await api.put({ id: ordinary, title: `QA ordinary edited ${suffix}` })
      expect(edited.status(), await edited.text()).toBe(200)
      const completed = await api.complete(ordinary)
      expect(completed.status(), await completed.text()).toBe(200)
      const toCancel = await createOrdinary(`QA ordinary cancel ${suffix}`)
      const cancelled = await api.cancel(toCancel)
      expect(cancelled.status(), await cancelled.text()).toBe(200)
      const toDelete = await createOrdinary(`QA ordinary delete ${suffix}`)
      const removed = await api.remove(toDelete)
      expect(removed.status(), await removed.text()).toBe(200)

      const [unchanged] = await waitForPickupTasks(request, token, companyId, (tasks) => tasks.length === 1, 'pickup task untouched')
      expect(unchanged).toMatchObject({ id: task.id, status: 'planned', title: task.title })
    } finally {
      for (const id of ordinaryIds) await apiRequest(request, 'DELETE', `/api/customers/interactions?id=${id}`, { token }).catch(() => undefined)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

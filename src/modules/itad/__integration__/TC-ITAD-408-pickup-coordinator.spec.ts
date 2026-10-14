import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import {
  createRoleFixture,
  createUserFixture,
  deleteRoleIfExists,
  deleteUserIfExists,
  setRoleAclFeatures,
} from '@open-mercato/core/helpers/integration/authFixtures'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { getTokenScope, readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { createSchedulableJob, errorCode, getJob, transitionOk, uniqueSuffix } from './itad-job-fixtures'
import { updateJob, waitForPickupTasks } from './itad-pickup-fixtures'

/**
 * TC-ITAD-408 (pickup calendar spec REQ-513, REQ-502, lookup API): the pickup coordinator
 * is validated, becomes the task owner and follows editability; the job read model shows
 * the pickup task; the lookup API maps a task to its job, 404 for anything else and 403
 * without `itad.jobs.view`.
 */
test.describe('TC-ITAD-408: pickup coordinator and pickup task read model', () => {
  test('coordinator owns the task; job detail and lookup show the task', async ({ request }) => {
    const adminToken = await getAuthToken(request, 'admin')
    const employeeToken = await getAuthToken(request, 'employee')
    const admin = getTokenScope(adminToken)
    const employee = getTokenScope(employeeToken)
    const suffix = uniqueSuffix()
    const safe = suffix.replace(/[^a-z0-9]/gi, '_')
    let companyId: string | null = null
    let ordinaryId: string | null = null
    let roleId: string | null = null
    let userId: string | null = null
    try {
      companyId = await createCompanyFixture(request, adminToken, `QA ITAD Coordinator ${suffix}`)

      const invalid = await apiRequest(request, 'POST', '/api/itad/jobs', {
        token: adminToken,
        data: { customerId: companyId, name: `QA bad coordinator ${suffix}`, pickupCoordinatorUserId: '00000000-0000-4000-8000-000000000000' },
      })
      expect(invalid.status()).toBe(400)
      expect(await errorCode(invalid)).toBe('itad.jobs.errors.pickup_coordinator_invalid')

      const coordinators = await readJsonSafe<{ items?: Array<{ id: string }> }>(
        await apiRequest(request, 'GET', '/api/itad/pickup-coordinators', { token: adminToken }),
      )
      expect(coordinators?.items?.map((user) => user.id)).toContain(admin.userId)

      const job = await createSchedulableJob(request, adminToken, companyId, `QA coordinator ${suffix}`, {
        pickupCoordinatorUserId: admin.userId,
      })
      expect((await getJob(request, adminToken, job.id))?.pickupTask ?? null).toBeNull()
      await transitionOk(request, adminToken, job.id, { action: 'schedule' })
      const [task] = await waitForPickupTasks(
        request,
        adminToken,
        companyId,
        (tasks) => tasks.length === 1 && tasks[0].ownerUserId === admin.userId,
        'task owned by the coordinator',
      )

      await updateJob(request, adminToken, job.id, { pickupCoordinatorUserId: employee.userId })
      await waitForPickupTasks(
        request,
        adminToken,
        companyId,
        (tasks) => tasks.length === 1 && tasks[0].id === task.id && tasks[0].ownerUserId === employee.userId,
        'owner follows the new coordinator',
      )
      await expect
        .poll(async () => (await getJob(request, adminToken, job.id))?.pickupTask?.state)
        .toBe('planned')
      const detail = await getJob(request, adminToken, job.id)
      expect(detail).toMatchObject({
        pickupCoordinatorUserId: employee.userId,
        pickupTask: { interactionId: task.id, lastError: null },
        pickupTaskHistoryCount: 1,
      })
      expect(detail?.pickupCoordinator?.id).toBe(employee.userId)

      const lookup = await apiRequest(request, 'GET', `/api/itad/pickup-tasks/lookup?interactionId=${task.id}`, { token: adminToken })
      expect(lookup.status()).toBe(200)
      expect(await readJsonSafe(lookup)).toEqual({ jobId: job.id, reference: job.internalReference })

      const ordinary = await apiRequest(request, 'POST', '/api/customers/interactions', {
        token: adminToken,
        data: { entityId: companyId, interactionType: 'task', title: `QA ordinary ${suffix}`, scheduledAt: new Date().toISOString() },
      })
      ordinaryId = (await readJsonSafe<{ id?: string }>(ordinary))?.id ?? null
      const notPickup = await apiRequest(request, 'GET', `/api/itad/pickup-tasks/lookup?interactionId=${ordinaryId}`, { token: adminToken })
      expect(notPickup.status()).toBe(404)

      const roleName = `qa_itad_noview_${safe}`
      roleId = await createRoleFixture(request, adminToken, { name: roleName, tenantId: admin.tenantId })
      await setRoleAclFeatures(request, adminToken, { roleId, features: ['customers.interactions.view'] })
      const email = `qa-itad-noview-${suffix}@example.test`
      const password = `Qa-${suffix}-Secret!`
      userId = await createUserFixture(request, adminToken, { email, password, organizationId: admin.organizationId, roles: [roleName] })
      const noView = await getAuthToken(request, email, password)
      const forbidden = await apiRequest(request, 'GET', `/api/itad/pickup-tasks/lookup?interactionId=${task.id}`, { token: noView })
      expect(forbidden.status()).toBe(403)

      await transitionOk(request, adminToken, job.id, { action: 'dispatch' })
      const locked = await apiRequest(request, 'PUT', '/api/itad/jobs', {
        token: adminToken,
        data: { id: job.id, pickupCoordinatorUserId: admin.userId },
      })
      expect(await errorCode(locked)).toBe('itad.jobs.errors.field_locked')
    } finally {
      if (ordinaryId) await apiRequest(request, 'DELETE', `/api/customers/interactions?id=${ordinaryId}`, { token: adminToken }).catch(() => undefined)
      await deleteUserIfExists(request, adminToken, userId)
      await deleteRoleIfExists(request, adminToken, roleId)
      await deleteEntityIfExists(request, adminToken, '/api/customers/companies', companyId)
    }
  })
})

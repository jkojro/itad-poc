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
import { getTokenContext } from '@open-mercato/core/helpers/integration/generalFixtures'
import { createJob, deleteJobIfExists, uniqueSuffix } from './itadJobFixtures'

/**
 * TC-ITAD-005 (spec TEST-009b, CRUD part): a user granted only `itad.jobs.view` can
 * list jobs but every write returns exactly 403 and changes nothing. Transition gates
 * (`itad.jobs.transition`, `itad.jobs.confirm_conditions`) are covered with Phase 2.
 */
test.describe('TC-ITAD-005: ITAD job writes require itad.jobs.manage', () => {
  test('view-only user gets 403 on create, update and delete', async ({ request }) => {
    const adminToken = await getAuthToken(request, 'admin')
    const { tenantId, organizationId } = getTokenContext(adminToken)
    const suffix = uniqueSuffix()
    const email = `qa-itad-viewer-${suffix}@example.test`
    const password = `Qa-${suffix}-Secret!`
    let companyId: string | null = null
    let jobId: string | null = null
    let roleId: string | null = null
    let userId: string | null = null
    try {
      companyId = await createCompanyFixture(request, adminToken, `QA ITAD Gate ${suffix}`)
      jobId = (await createJob(request, adminToken, { customerId: companyId, name: `QA gate ${suffix}` })).id

      const roleName = `qa_itad_viewer_${suffix.replace(/[^a-z0-9]/gi, '_')}`
      roleId = await createRoleFixture(request, adminToken, { name: roleName, tenantId })
      await setRoleAclFeatures(request, adminToken, { roleId, features: ['itad.jobs.view'] })
      userId = await createUserFixture(request, adminToken, { email, password, organizationId, roles: [roleName] })
      const viewerToken = await getAuthToken(request, email, password)

      const list = await apiRequest(request, 'GET', `/api/itad/jobs?id=${encodeURIComponent(jobId)}`, { token: viewerToken })
      expect(list.status()).toBe(200)

      const create = await apiRequest(request, 'POST', '/api/itad/jobs', {
        token: viewerToken,
        data: { customerId: companyId, name: `QA forbidden ${suffix}` },
      })
      expect(create.status()).toBe(403)
      const update = await apiRequest(request, 'PUT', '/api/itad/jobs', {
        token: viewerToken,
        data: { id: jobId, name: 'forbidden rename' },
      })
      expect(update.status()).toBe(403)
      const remove = await apiRequest(request, 'DELETE', '/api/itad/jobs', { token: viewerToken, data: { id: jobId } })
      expect(remove.status()).toBe(403)

      const after = await apiRequest(request, 'GET', `/api/itad/jobs?id=${encodeURIComponent(jobId)}`, { token: adminToken })
      const body = (await after.json()) as { items?: Array<{ name?: string }> }
      expect(body.items?.[0]?.name).toBe(`QA gate ${suffix}`)
    } finally {
      await deleteUserIfExists(request, adminToken, userId)
      await deleteRoleIfExists(request, adminToken, roleId)
      await deleteJobIfExists(request, adminToken, jobId)
      await deleteEntityIfExists(request, adminToken, '/api/customers/companies', companyId)
    }
  })
})

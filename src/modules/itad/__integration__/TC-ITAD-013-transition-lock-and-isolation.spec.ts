import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import {
  apiRequestWithSelectedOrg,
  createOrganizationFixture,
  deleteOrganizationIfExists,
} from '@open-mercato/core/helpers/integration/authFixtures'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { getTokenContext } from '@open-mercato/core/helpers/integration/generalFixtures'
import { LOCK_HEADER, createSchedulableJob, getJob, postTransition, uniqueSuffix } from './itad-job-fixtures'

/**
 * TC-ITAD-013 (spec TEST-010 transition part, TEST-009a transition part): a transition
 * with a stale expected version returns 409 and changes nothing; another organization
 * gets exactly 404 on the transition, transitions-read and history routes.
 */
test.describe('TC-ITAD-013: transition optimistic lock and organization isolation', () => {
  test('stale version 409 and foreign organization 404', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const { tenantId } = getTokenContext(token)
    const suffix = uniqueSuffix()
    let companyId: string | null = null
    let jobId: string | null = null
    let orgBId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD Lock2 ${suffix}`)
      jobId = (await createSchedulableJob(request, token, companyId, `QA lock2 ${suffix}`)).id
      const stale = (await getJob(request, token, jobId))!.updatedAt!

      const fresh = await postTransition(request, token, jobId, { action: 'schedule' }, { [LOCK_HEADER]: stale })
      expect(fresh.status()).toBe(200)
      const staleMove = await postTransition(request, token, jobId, { action: 'dispatch' }, { [LOCK_HEADER]: stale })
      expect(staleMove.status()).toBe(409)
      expect((await getJob(request, token, jobId))?.status).toBe('scheduled')

      orgBId = await createOrganizationFixture(request, token, { name: `QA ITAD Org B2 ${suffix}`, tenantId })
      const asOrgB = (method: string, path: string, data?: unknown) =>
        apiRequestWithSelectedOrg(request, method, path, { token, selectedOrgId: orgBId!, data })
      expect((await asOrgB('POST', `/api/itad/jobs/${jobId}/transitions`, { action: 'dispatch' })).status()).toBe(404)
      expect((await asOrgB('GET', `/api/itad/jobs/${jobId}/transitions`)).status()).toBe(404)
      expect((await asOrgB('GET', `/api/itad/jobs/${jobId}/history`)).status()).toBe(404)
      expect((await getJob(request, token, jobId))?.status).toBe('scheduled')

      const unknown = await apiRequest(request, 'GET', `/api/itad/jobs/00000000-0000-4000-8000-000000000000/history`, { token })
      expect(unknown.status()).toBe(404)
    } finally {
      if (jobId) await postTransition(request, token, jobId, { action: 'cancel', reason: 'QA cleanup' }).catch(() => undefined)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
      await deleteOrganizationIfExists(request, token, orgBId)
    }
  })
})

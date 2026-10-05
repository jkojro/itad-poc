import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { createJob, deleteJobIfExists, getJob, uniqueSuffix } from './itad-job-fixtures'

const LOCK_HEADER = 'x-om-ext-optimistic-lock-expected-updated-at'

/**
 * TC-ITAD-007 (spec TEST-010, CRUD part): update and delete carrying a stale expected
 * version return 409 and leave the job unchanged; the current version succeeds.
 */
test.describe('TC-ITAD-007: optimistic locking on ITAD job update and delete', () => {
  test('stale version is rejected with 409, current version succeeds', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    let companyId: string | null = null
    let jobId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD Lock ${suffix}`)
      jobId = (await createJob(request, token, { customerId: companyId, name: `QA lock ${suffix}` })).id
      const loaded = await getJob(request, token, jobId)
      const staleVersion = loaded!.updatedAt!

      const firstEdit = await apiRequest(request, 'PUT', '/api/itad/jobs', {
        token,
        data: { id: jobId, name: `QA lock edited ${suffix}` },
        headers: { [LOCK_HEADER]: staleVersion },
      })
      expect(firstEdit.status()).toBe(200)

      const staleEdit = await apiRequest(request, 'PUT', '/api/itad/jobs', {
        token,
        data: { id: jobId, name: 'stale overwrite' },
        headers: { [LOCK_HEADER]: staleVersion },
      })
      expect(staleEdit.status()).toBe(409)
      const staleDelete = await apiRequest(request, 'DELETE', '/api/itad/jobs', {
        token,
        data: { id: jobId },
        headers: { [LOCK_HEADER]: staleVersion },
      })
      expect(staleDelete.status()).toBe(409)

      const current = await getJob(request, token, jobId)
      expect(current?.name).toBe(`QA lock edited ${suffix}`)

      const freshDelete = await apiRequest(request, 'DELETE', '/api/itad/jobs', {
        token,
        data: { id: jobId },
        headers: { [LOCK_HEADER]: current!.updatedAt! },
      })
      expect(freshDelete.status()).toBe(200)
      jobId = null
    } finally {
      await deleteJobIfExists(request, token, jobId)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

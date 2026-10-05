import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { createJob, deleteJobIfExists, getJob, uniqueSuffix } from './itad-job-fixtures'

/**
 * TC-ITAD-006 (spec TEST-009c): status, references and lifecycle timestamps are never
 * writable through CRUD — POST and PUT carrying them return exactly
 * `400 itad.jobs.errors.field_not_writable` and change nothing.
 */
test.describe('TC-ITAD-006: system fields are not writable through CRUD', () => {
  test('POST and PUT with status or startedAt are rejected', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    let companyId: string | null = null
    let jobId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD System ${suffix}`)

      const createWithStatus = await apiRequest(request, 'POST', '/api/itad/jobs', {
        token,
        data: { customerId: companyId, name: `QA status ${suffix}`, status: 'completed' },
      })
      expect(createWithStatus.status()).toBe(400)
      expect((await readJsonSafe<{ code?: string }>(createWithStatus))?.code).toBe('itad.jobs.errors.field_not_writable')

      const job = await createJob(request, token, { customerId: companyId, name: `QA system ${suffix}` })
      jobId = job.id

      for (const patch of [{ status: 'completed' }, { startedAt: new Date().toISOString() }, { internalReference: 'ITAD-1999-00001' }]) {
        const response = await apiRequest(request, 'PUT', '/api/itad/jobs', { token, data: { id: job.id, ...patch } })
        expect(response.status(), JSON.stringify(patch)).toBe(400)
        expect((await readJsonSafe<{ code?: string }>(response))?.code).toBe('itad.jobs.errors.field_not_writable')
      }

      const current = await getJob(request, token, job.id)
      expect(current?.status).toBe('draft')
      expect(current?.internalReference).toBe(job.internalReference)
    } finally {
      await deleteJobIfExists(request, token, jobId)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

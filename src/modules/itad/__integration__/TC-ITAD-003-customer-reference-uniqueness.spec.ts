import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { createJob, deleteJobIfExists, uniqueSuffix } from './itadJobFixtures'

type ErrorBody = { code?: string; fieldErrors?: Record<string, string> }

/**
 * TC-ITAD-003 (spec TEST-005, Phase 1 part): `customerReference` is unique per
 * organization case-insensitively; deleting the draft releases it. The "cancelled job
 * keeps it reserved" case needs the cancel transition and lands with Phase 2.
 */
test.describe('TC-ITAD-003: customer reference uniqueness', () => {
  test('rejects a case-insensitive duplicate and releases it on draft delete', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    const reference = `NB-RET-${suffix}`
    let companyId: string | null = null
    const jobIds: string[] = []
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD Ref ${suffix}`)
      const first = await createJob(request, token, {
        customerId: companyId,
        name: `QA ref first ${suffix}`,
        customerReference: reference,
      })
      jobIds.push(first.id)

      const duplicate = await apiRequest(request, 'POST', '/api/itad/jobs', {
        token,
        data: { customerId: companyId, name: `QA ref dup ${suffix}`, customerReference: reference.toLowerCase() },
      })
      expect(duplicate.status()).toBe(409)
      const duplicateBody = await readJsonSafe<ErrorBody>(duplicate)
      expect(duplicateBody?.code).toBe('itad.jobs.errors.customer_reference_taken')
      expect(typeof duplicateBody?.fieldErrors?.customerReference).toBe('string')

      const removed = await apiRequest(request, 'DELETE', '/api/itad/jobs', { token, data: { id: first.id } })
      expect(removed.status()).toBe(200)

      const reused = await createJob(request, token, {
        customerId: companyId,
        name: `QA ref reuse ${suffix}`,
        customerReference: reference,
      })
      jobIds.push(reused.id)
      expect(reused.internalReference).not.toBe(first.internalReference)
    } finally {
      for (const id of jobIds) await deleteJobIfExists(request, token, id)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

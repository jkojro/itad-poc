import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { createJob, errorCode, transitionOk, uniqueSuffix } from './itadJobFixtures'

/**
 * TC-ITAD-014 (spec TEST-005, cancellation part; REQ-003): a cancelled job keeps its
 * customer reference reserved — only deleting a draft releases it.
 */
test.describe('TC-ITAD-014: cancelled jobs keep their customer reference', () => {
  test('reusing the reference of a cancelled job returns 409', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    const reference = `CXL-${suffix}`
    let companyId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD Cancel ${suffix}`)
      const job = await createJob(request, token, { customerId: companyId, name: `QA cancel ${suffix}`, customerReference: reference })
      expect(await transitionOk(request, token, job.id, { action: 'cancel', reason: 'customer withdrew' })).toBe('cancelled')

      const reuse = await apiRequest(request, 'POST', '/api/itad/jobs', {
        token,
        data: { customerId: companyId, name: `QA cancel reuse ${suffix}`, customerReference: reference },
      })
      expect(reuse.status()).toBe(409)
      expect(await errorCode(reuse)).toBe('itad.jobs.errors.customer_reference_taken')
    } finally {
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

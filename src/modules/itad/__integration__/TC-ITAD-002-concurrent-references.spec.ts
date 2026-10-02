import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { createJob, deleteJobIfExists, referenceNumber, uniqueSuffix } from './itadJobFixtures'

/**
 * TC-ITAD-002 (spec TEST-004): parallel creates in one organization serialize on the
 * sequence row and receive distinct, gap-free numbers — never a duplicate or a 5xx.
 */
test.describe('TC-ITAD-002: concurrent ITAD job creates get distinct references', () => {
  test('parallel POSTs yield consecutive unique references', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    let companyId: string | null = null
    const jobIds: string[] = []
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD Parallel ${suffix}`)
      const customerId = companyId
      const created = await Promise.all(
        Array.from({ length: 5 }, (_, index) =>
          createJob(request, token, { customerId, name: `QA parallel ${index} ${suffix}` }),
        ),
      )
      jobIds.push(...created.map((job) => job.id))

      const numbers = created.map((job) => referenceNumber(job.internalReference)).sort((a, b) => a - b)
      expect(new Set(numbers).size).toBe(numbers.length)
      expect(numbers[numbers.length - 1] - numbers[0]).toBe(numbers.length - 1)
    } finally {
      for (const id of jobIds) await deleteJobIfExists(request, token, id)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

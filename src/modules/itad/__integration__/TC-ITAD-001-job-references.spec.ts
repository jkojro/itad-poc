import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import {
  JOB_REFERENCE_PATTERN,
  createJob,
  deleteJobIfExists,
  getJob,
  referenceNumber,
  uniqueSuffix,
} from './itadJobFixtures'

/**
 * TC-ITAD-001 (spec TEST-003): consecutive creates issue consecutive references in the
 * current UTC year, every job starts as a draft, and the customer name is resolved.
 */
test.describe('TC-ITAD-001: ITAD job create issues consecutive references', () => {
  test('creates draft jobs with ITAD-{year}-{NNNNN} references', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    let companyId: string | null = null
    const jobIds: string[] = []
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD Bank ${suffix}`)
      const year = new Date().getUTCFullYear()

      const created = []
      for (let index = 0; index < 3; index += 1) {
        const job = await createJob(request, token, { customerId: companyId, name: `QA job ${index} ${suffix}` })
        jobIds.push(job.id)
        created.push(job)
      }

      for (const job of created) {
        const match = JOB_REFERENCE_PATTERN.exec(job.internalReference)
        expect(match?.[1]).toBe(String(year))
      }
      const numbers = created.map((job) => referenceNumber(job.internalReference))
      expect(numbers[1]).toBe(numbers[0] + 1)
      expect(numbers[2]).toBe(numbers[1] + 1)

      const first = await getJob(request, token, created[0].id)
      expect(first?.status).toBe('draft')
      expect(first?.internalReference).toBe(created[0].internalReference)
      expect(first?.customerName).toBe(`QA ITAD Bank ${suffix}`)
      expect(typeof first?.updatedAt).toBe('string')
      expect(first?.editableFields).toEqual([
        'customerId',
        'name',
        'customerReference',
        'scheduledPickupAt',
        'expectedAssetEstimate',
      ])
    } finally {
      for (const id of jobIds) await deleteJobIfExists(request, token, id)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

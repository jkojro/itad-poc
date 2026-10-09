import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { advanceToReceiving, createSchedulableJob, deleteJobIfExists, uniqueSuffix } from './itad-job-fixtures'
import { listAssets, listScans, postScan } from './itad-receiving-fixtures'

/**
 * TC-ITAD-110 (spec TEST-111): 20 concurrent scans of 10 serials (each twice) are
 * serialized by the job row lock — exactly one asset and one duplicate scan per serial,
 * and no server errors.
 */
test.describe('TC-ITAD-110: concurrent scans', () => {
  test('two parallel scans per serial yield one asset and one duplicate each', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    const tag = suffix.slice(-6).toUpperCase()
    let companyId: string | null = null
    let jobId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD Parallel ${suffix}`)
      jobId = (await createSchedulableJob(request, token, companyId, `QA parallel ${suffix}`)).id
      await advanceToReceiving(request, token, jobId)

      const serials = Array.from({ length: 10 }, (_, index) => `P${index}-${tag}`)
      const responses = await Promise.all([...serials, ...serials].map((serial) => postScan(request, token, jobId!, serial)))
      expect(responses.map((response) => response.status())).toEqual(Array(20).fill(201))

      expect((await listAssets(request, token, jobId, 'pageSize=100')).total).toBe(10)
      const scans = await listScans(request, token, jobId, 'pageSize=100')
      expect(scans.total).toBe(20)
      expect(scans.items.filter((scan) => scan.result === 'duplicate')).toHaveLength(10)
      const duplicatesPerSerial = new Map<string, number>()
      for (const scan of scans.items.filter((entry) => entry.result === 'duplicate')) {
        duplicatesPerSerial.set(scan.asset.serial, (duplicatesPerSerial.get(scan.asset.serial) ?? 0) + 1)
      }
      expect([...duplicatesPerSerial.values()]).toEqual(Array(10).fill(1))
    } finally {
      await deleteJobIfExists(request, token, jobId)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

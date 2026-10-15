import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { createSchedulableJob, uniqueSuffix } from './itad-job-fixtures'
import { classifyAssets } from './itad-receiving-fixtures'
import { processingJobWithDataBearingAssets } from './itad-sanitization-fixtures'
import { assetCertificatesOk, issueCertificateOk, passAsset } from './itad-certificate-fixtures'

/**
 * TC-ITAD-508 (certificates spec REQ-614, AC-605): reclassifying a certified device as not
 * carrying data voids its certificate in the same operation, with the system reason code
 * and the classifying user; the certificate stays in the history and the device no longer
 * requires one.
 */
test.describe('TC-ITAD-508: reclassification voids the certificate', () => {
  test('true → false voids with reclassified_non_data_bearing', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    let companyId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA Cert Reclassify ${suffix}`)
      const job = await createSchedulableJob(request, token, companyId, `QA cert reclassify ${suffix}`)
      const [asset] = await processingJobWithDataBearingAssets(request, token, job.id, 1)
      await passAsset(request, token, job.id, asset)
      const issued = await issueCertificateOk(request, token, job.id, asset.id)

      const classified = await classifyAssets(request, token, job.id, [asset.id], false, 'Chassis only, drive was removed by the customer')
      expect(classified.status(), JSON.stringify(await readJsonSafe(classified))).toBe(200)

      const listed = await assetCertificatesOk(request, token, job.id, asset.id)
      expect(listed.currentCertificateId).toBeNull()
      expect(listed.items).toHaveLength(1)
      expect(listed.items[0]).toMatchObject({
        id: issued.id,
        status: 'void',
        voidReasonCode: 'reclassified_non_data_bearing',
        voidReason: 'Chassis only, drive was removed by the customer',
      })
      expect(listed.items[0].voidedBy?.id).toBeTruthy()
      expect(listed.issue).toMatchObject({ allowed: false, detail: 'not_data_bearing' })
    } finally {
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

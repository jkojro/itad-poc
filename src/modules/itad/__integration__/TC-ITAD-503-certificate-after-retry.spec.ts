import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { createSchedulableJob, uniqueSuffix } from './itad-job-fixtures'
import { approveRetry, processingJobWithDataBearingAssets, recordResult, startRunOk } from './itad-sanitization-fixtures'
import { assetCertificatesOk, issueCertificateOk, passAsset, refreshAsset } from './itad-certificate-fixtures'

/**
 * TC-ITAD-503 (certificates spec REQ-605, AC-602): after FAIL → approved retry → PASS the
 * certificate's source is the PASS run, never the failed one.
 */
test.describe('TC-ITAD-503: certificate after a retry', () => {
  test('the PASS run is the source', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    let companyId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD Cert Retry ${suffix}`)
      const job = await createSchedulableJob(request, token, companyId, `QA cert retry ${suffix}`)
      const [asset] = await processingJobWithDataBearingAssets(request, token, job.id, 1)
      const failRun = await startRunOk(request, token, job.id, asset)
      expect((await recordResult(request, token, job.id, failRun, { result: 'FAIL', verificationMethod: 'none', verificationNotes: 'Bad sectors' })).status()).toBe(200)
      const retried = await approveRetry(request, token, job.id, await refreshAsset(request, token, job.id, asset), 'Replaced the cable')
      expect(retried.status(), await retried.text()).toBe(200)
      const passRun = await passAsset(request, token, job.id, await refreshAsset(request, token, job.id, asset))

      const issued = await issueCertificateOk(request, token, job.id, asset.id)
      const { items } = await assetCertificatesOk(request, token, job.id, asset.id)
      expect(items[0]).toMatchObject({ id: issued.id, sourceRun: { id: passRun } })
      expect(items[0].sourceRun.id).not.toBe(failRun)
    } finally {
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

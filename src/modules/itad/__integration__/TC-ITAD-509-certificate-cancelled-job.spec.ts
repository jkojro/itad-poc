import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { createSchedulableJob, transitionOk, uniqueSuffix } from './itad-job-fixtures'
import { processingJobWithDataBearingAssets } from './itad-sanitization-fixtures'
import { assetCertificatesOk, downloadPdfOk, issueCertificateOk, passAsset } from './itad-certificate-fixtures'

/**
 * TC-ITAD-509 (certificates spec REQ-615, "Job status"): cancelling a job changes no
 * certificate; the issued one stays valid with the same PDF and can still be corrected.
 */
test.describe('TC-ITAD-509: cancelled job keeps its certificates', () => {
  test('cancel leaves the issued certificate untouched', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    let companyId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA Cert Cancel ${suffix}`)
      const job = await createSchedulableJob(request, token, companyId, `QA cert cancel ${suffix}`)
      const [asset] = await processingJobWithDataBearingAssets(request, token, job.id, 1)
      await passAsset(request, token, job.id, asset)
      const issued = await issueCertificateOk(request, token, job.id, asset.id)
      const before = await assetCertificatesOk(request, token, job.id, asset.id)
      const pdf = await downloadPdfOk(request, token, job.id, issued.id)

      await transitionOk(request, token, job.id, { action: 'cancel', reason: 'customer withdrew' })

      const after = await assetCertificatesOk(request, token, job.id, asset.id)
      expect(after.jobStatus).toBe('cancelled')
      expect(after.currentCertificateId).toBe(issued.id)
      expect(after.items).toEqual(before.items)
      expect((await downloadPdfOk(request, token, job.id, issued.id)).equals(pdf)).toBe(true)
      // A cancelled job takes no new issue, but its certificate can still be corrected.
      expect(after.reissue.allowed).toBe(true)
      expect(after.void.allowed).toBe(true)
    } finally {
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

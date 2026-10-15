import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { createSchedulableJob, uniqueSuffix } from './itad-job-fixtures'
import { processingJobWithDataBearingAssets } from './itad-sanitization-fixtures'
import { downloadPdfOk, issueCertificateOk, passAsset, pdfText } from './itad-certificate-fixtures'

/**
 * TC-ITAD-505 (certificates spec REQ-616, REQ-619, REQ-620): renaming the customer company
 * and the job after issue changes nothing on the certificate; the PDF bytes stay identical.
 */
test.describe('TC-ITAD-505: an issued certificate does not change', () => {
  test('later customer and job changes leave the stored PDF untouched', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    let companyId: string | null = null
    try {
      const originalName = `QA ACME Bank ${suffix}`
      companyId = await createCompanyFixture(request, token, originalName)
      const job = await createSchedulableJob(request, token, companyId, `QA cert immutable ${suffix}`)
      const [asset] = await processingJobWithDataBearingAssets(request, token, job.id, 1)
      await passAsset(request, token, job.id, asset)
      const issued = await issueCertificateOk(request, token, job.id, asset.id)
      const before = await downloadPdfOk(request, token, job.id, issued.id)

      const renamedCompany = await apiRequest(request, 'PUT', '/api/customers/companies', {
        token,
        data: { id: companyId, displayName: `QA ACME Financial Group ${suffix}` },
      })
      expect(renamedCompany.status(), await renamedCompany.text()).toBe(200)
      const renamedJob = await apiRequest(request, 'PUT', '/api/itad/jobs', { token, data: { id: job.id, name: `QA renamed ${suffix}` } })
      expect(renamedJob.status(), await renamedJob.text()).toBe(200)

      const after = await downloadPdfOk(request, token, job.id, issued.id)
      expect(after.equals(before)).toBe(true)
      const text = pdfText(after)
      expect(text).toContain(originalName)
      expect(text).not.toContain('ACME Financial Group')
      expect(text).toContain(`QA cert immutable ${suffix}`)
    } finally {
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

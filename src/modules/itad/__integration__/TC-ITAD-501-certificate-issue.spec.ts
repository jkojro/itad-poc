import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { createSchedulableJob, uniqueSuffix } from './itad-job-fixtures'
import { processingJobWithDataBearingAssets } from './itad-sanitization-fixtures'
import {
  assetCertificatesOk,
  downloadPdfOk,
  issueCertificateOk,
  passAsset,
  pdfText,
} from './itad-certificate-fixtures'

/**
 * TC-ITAD-501 (certificates spec REQ-601…604, REQ-619, AC-601): a sanitized data-bearing
 * device gets a certificate with a CDS number; the asset lists it as current; the PDF is
 * stored once and shows the run's facts, including the media identifiers.
 */
test.describe('TC-ITAD-501: issue a certificate of data sanitization', () => {
  test('issue, list and download the stored PDF', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    let companyId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA Müller & Söhne ${suffix}`)
      const job = await createSchedulableJob(request, token, companyId, `QA certificate ${suffix}`)
      const [asset] = await processingJobWithDataBearingAssets(request, token, job.id, 1)
      const runId = await passAsset(request, token, job.id, asset, ['NVME-AAA-1', 'NVME-BBB-2'])

      const before = await assetCertificatesOk(request, token, job.id, asset.id)
      expect(before).toMatchObject({ items: [], currentCertificateId: null, issue: { allowed: true } })

      const issued = await issueCertificateOk(request, token, job.id, asset.id, 'en')
      const after = await assetCertificatesOk(request, token, job.id, asset.id)
      expect(after.currentCertificateId).toBe(issued.id)
      expect(after.items).toHaveLength(1)
      expect(after.items[0]).toMatchObject({
        certificateNumber: issued.certificateNumber,
        status: 'issued',
        locale: 'en',
        sourceRun: { id: runId, method: 'purge', tool: 'Blancco Drive Eraser', toolVersion: '7.9' },
      })
      expect(after.issue).toMatchObject({ allowed: false, code: 'certificate_already_issued' })

      const pdf = await downloadPdfOk(request, token, job.id, issued.id)
      const text = pdfText(pdf)
      for (const value of [
        issued.certificateNumber,
        `QA Müller & Söhne ${suffix}`,
        job.internalReference,
        asset.serial,
        'NVME-AAA-1',
        'NVME-BBB-2',
        'Blancco Drive Eraser 7.9',
        'PASS',
        'Sanitization started by',
        'Result recorded by',
      ]) {
        expect(text).toContain(value)
      }
      const again = await downloadPdfOk(request, token, job.id, issued.id)
      expect(again.equals(pdf)).toBe(true)
    } finally {
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

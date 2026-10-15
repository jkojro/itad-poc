import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { createSchedulableJob, uniqueSuffix } from './itad-job-fixtures'
import { processingJobWithDataBearingAssets } from './itad-sanitization-fixtures'
import {
  assetCertificatesOk,
  certificateById,
  downloadPdfOk,
  errorBody,
  issueCertificateOk,
  passAsset,
  voidCertificate,
} from './itad-certificate-fixtures'

/**
 * TC-ITAD-507 (certificates spec "Void", Q11, REQ-608): a void needs a reason and the
 * current version; the certificate stays with its PDF; the asset needs a certificate
 * again; a void certificate cannot be voided twice.
 */
test.describe('TC-ITAD-507: certificate void', () => {
  test('reason, version, history and the asset missing again', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    let companyId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA Cert Void ${suffix}`)
      const job = await createSchedulableJob(request, token, companyId, `QA cert void ${suffix}`)
      const [asset] = await processingJobWithDataBearingAssets(request, token, job.id, 1)
      await passAsset(request, token, job.id, asset)
      const issued = await issueCertificateOk(request, token, job.id, asset.id)
      const before = await downloadPdfOk(request, token, job.id, issued.id)
      const current = await certificateById(request, token, job.id, asset.id, issued.id)

      const noReason = await voidCertificate(request, token, job.id, current, null)
      expect(noReason.status()).toBe(400)
      expect(await errorBody(noReason)).toMatchObject({ code: 'itad.certificates.errors.reason_required' })

      const staleVersion = await voidCertificate(request, token, job.id, { id: issued.id, updatedAt: '2000-01-01T00:00:00.000Z' }, 'Wrong device')
      expect(staleVersion.status()).toBe(409)

      const voided = await voidCertificate(request, token, job.id, current, 'Issued for the wrong device')
      expect(voided.status(), await voided.text()).toBe(200)

      const listed = await assetCertificatesOk(request, token, job.id, asset.id)
      expect(listed.currentCertificateId).toBeNull()
      expect(listed.items).toHaveLength(1)
      expect(listed.items[0]).toMatchObject({ status: 'void', voidReason: 'Issued for the wrong device', voidReasonCode: 'manual' })
      expect(listed.items[0].voidedBy?.id).toBeTruthy()
      // The asset still requires a certificate, so it can get one again.
      expect(listed.issue).toMatchObject({ allowed: true })
      expect((await downloadPdfOk(request, token, job.id, issued.id)).equals(before)).toBe(true)

      const twice = await voidCertificate(request, token, job.id, listed.items[0], 'Again')
      expect(twice.status()).toBe(409)
      expect(await errorBody(twice)).toMatchObject({ code: 'itad.certificates.errors.certificate_not_issued' })

      const replacement = await issueCertificateOk(request, token, job.id, asset.id)
      expect(replacement.certificateNumber).not.toBe(issued.certificateNumber)
    } finally {
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { CONFIRM, createSchedulableJob, transitionOk, uniqueSuffix } from './itad-job-fixtures'
import { processingJobWithDataBearingAssets } from './itad-sanitization-fixtures'
import {
  CERTIFICATE_NUMBER,
  assetCertificatesOk,
  certificateById,
  downloadPdfOk,
  errorBody,
  issueCertificateOk,
  passAsset,
  pdfText,
  reissueCertificate,
  reissuePreviewOk,
} from './itad-certificate-fixtures'

/**
 * TC-ITAD-506 (certificates spec "Reissue", REQ-607, AC-604): the preview writes nothing
 * and has no number of its own; a reissue needs a reason, supersedes the old certificate
 * and issues a new number linked to it; a stale preview is refused with
 * `certificate_preview_stale`; a superseded certificate cannot be reissued; a completed
 * job can still get a corrected certificate.
 */
test.describe('TC-ITAD-506: certificate reissue', () => {
  test('preview, reason, supersede, stale preview and reissue after completion', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    let companyId: string | null = null
    const renameCompany = async (displayName: string) => {
      const response = await apiRequest(request, 'PUT', '/api/customers/companies', { token, data: { id: companyId, displayName } })
      expect(response.status(), await response.text()).toBe(200)
    }
    try {
      companyId = await createCompanyFixture(request, token, `QA Reissue Original ${suffix}`)
      const job = await createSchedulableJob(request, token, companyId, `QA cert reissue ${suffix}`)
      const [asset] = await processingJobWithDataBearingAssets(request, token, job.id, 1)
      await passAsset(request, token, job.id, asset)
      const first = await issueCertificateOk(request, token, job.id, asset.id, 'en')

      // The preview writes nothing and carries no new number, issue time or issuer.
      const unchanged = await reissuePreviewOk(request, token, job.id, first.id)
      expect(unchanged).toMatchObject({ certificateId: first.id, certificateNumber: first.certificateNumber, differences: [] })
      expect(unchanged.previewHash).toMatch(/^[0-9a-f]{64}$/)
      expect(unchanged.source).not.toHaveProperty('issuedAt')
      expect(unchanged.source).not.toHaveProperty('issuedBy')
      expect((await assetCertificatesOk(request, token, job.id, asset.id)).items).toHaveLength(1)

      // The customer name is corrected; the preview shows the difference.
      await renameCompany(`QA Reissue Corrected ${suffix}`)
      const preview = await reissuePreviewOk(request, token, job.id, first.id)
      expect(preview.differences).toEqual([
        { field: 'customerName', from: `QA Reissue Original ${suffix}`, to: `QA Reissue Corrected ${suffix}` },
      ])
      const current = await certificateById(request, token, job.id, asset.id, first.id)

      const noReason = await reissueCertificate(request, token, job.id, current, { reason: ' ', locale: 'en', previewHash: preview.previewHash })
      expect(noReason.status()).toBe(400)
      expect(await errorBody(noReason)).toMatchObject({ code: 'itad.certificates.errors.reason_required' })

      const reissued = await reissueCertificate(request, token, job.id, current, {
        reason: 'Customer name corrected',
        locale: 'pl',
        previewHash: preview.previewHash,
      })
      const reissuedBody = (await reissued.json()) as { id: string; certificateNumber: string; supersededCertificateId: string }
      expect(reissued.status(), JSON.stringify(reissuedBody)).toBe(201)
      expect(reissuedBody.certificateNumber).toMatch(CERTIFICATE_NUMBER)
      expect(reissuedBody.certificateNumber).not.toBe(first.certificateNumber)
      expect(reissuedBody.supersededCertificateId).toBe(first.id)

      const listed = await assetCertificatesOk(request, token, job.id, asset.id)
      expect(listed.currentCertificateId).toBe(reissuedBody.id)
      expect(listed.items.find((item) => item.id === first.id)).toMatchObject({
        status: 'superseded',
        supersededByCertificateId: reissuedBody.id,
        supersedeReason: 'Customer name corrected',
      })
      expect(listed.items.find((item) => item.id === reissuedBody.id)).toMatchObject({
        status: 'issued',
        locale: 'pl',
        supersedesCertificateId: first.id,
      })
      const newText = pdfText(await downloadPdfOk(request, token, job.id, reissuedBody.id))
      expect(newText).toContain(`QA Reissue Corrected ${suffix}`)
      expect(newText).toContain(first.certificateNumber)
      expect(pdfText(await downloadPdfOk(request, token, job.id, first.id))).toContain(`QA Reissue Original ${suffix}`)

      // A superseded certificate cannot be reissued.
      const superseded = await certificateById(request, token, job.id, asset.id, first.id)
      const again = await reissueCertificate(request, token, job.id, superseded, { reason: 'Again', locale: 'en', previewHash: preview.previewHash })
      expect(again.status()).toBe(409)
      expect(await errorBody(again)).toMatchObject({ code: 'itad.certificates.errors.certificate_not_issued' })

      // Data changes between preview and reissue: the preview is stale (AC-604).
      const stalePreview = await reissuePreviewOk(request, token, job.id, reissuedBody.id)
      await renameCompany(`QA Reissue Renamed Again ${suffix}`)
      const latest = await certificateById(request, token, job.id, asset.id, reissuedBody.id)
      const stale = await reissueCertificate(request, token, job.id, latest, { reason: 'Stale', locale: 'en', previewHash: stalePreview.previewHash })
      expect(stale.status()).toBe(409)
      expect(await errorBody(stale)).toMatchObject({ code: 'itad.certificates.errors.certificate_preview_stale' })
      expect((await assetCertificatesOk(request, token, job.id, asset.id)).items).toHaveLength(2)

      // Correcting a certificate after completion is a normal case.
      await transitionOk(request, token, job.id, { action: 'start_closeout', confirmations: [CONFIRM('allAssetsProcessed')] })
      await transitionOk(request, token, job.id, { action: 'complete' })
      const afterCompletion = await reissuePreviewOk(request, token, job.id, reissuedBody.id)
      const completed = await reissueCertificate(request, token, job.id, latest, {
        reason: 'Corrected after completion',
        locale: 'en',
        previewHash: afterCompletion.previewHash,
      })
      expect(completed.status(), await completed.text()).toBe(201)
    } finally {
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

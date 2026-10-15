import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { CONFIRM, createSchedulableJob, postTransition, transitionOk, uniqueSuffix } from './itad-job-fixtures'
import { approveRetry, currentAssets, processingJobWithDataBearingAssets, recordResult, startRunOk } from './itad-sanitization-fixtures'
import { downloadPdfOk, issueMissingOk, jobCertificatesOk, passAsset, pdfText } from './itad-certificate-fixtures'

/**
 * TC-ITAD-513 (certificates spec AC-601): a job from sanitization to completion. One device
 * fails and passes on retry, the others pass; "Issue all missing" gives every device a
 * Polish certificate from its PASS run; closeout completes on data alone; after
 * completion every certificate still downloads unchanged.
 */
test.describe('TC-ITAD-513: certificates end to end', () => {
  test('sanitize, certify, complete, download', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    let companyId: string | null = null
    let jobId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA Zakład Łódź ${suffix}`)
      jobId = (await createSchedulableJob(request, token, companyId, `QA cert e2e ${suffix}`)).id
      const assets = await processingJobWithDataBearingAssets(request, token, jobId, 3)

      const failRun = await startRunOk(request, token, jobId, assets[0])
      expect((await recordResult(request, token, jobId, failRun, { result: 'FAIL', verificationMethod: 'full_verification', verificationNotes: 'Readable sectors' })).status()).toBe(200)
      expect((await approveRetry(request, token, jobId, (await currentAssets(request, token, jobId, [assets[0].serial]))[0], 'Re-run with purge')).status()).toBe(200)
      const passRun = await passAsset(request, token, jobId, (await currentAssets(request, token, jobId, [assets[0].serial]))[0], ['NVME-E2E-1'])
      for (const asset of assets.slice(1)) await passAsset(request, token, jobId, asset)
      expect(await transitionOk(request, token, jobId, { action: 'start_closeout', confirmations: [CONFIRM('allAssetsProcessed')] })).toBe('closeout_review')

      const blocked = await postTransition(request, token, jobId, { action: 'complete' })
      expect(blocked.status()).toBe(400)

      const bulk = await issueMissingOk(request, token, jobId, 'pl')
      expect(bulk.failed).toEqual([])
      expect(bulk.issued).toHaveLength(3)
      expect(await transitionOk(request, token, jobId, { action: 'complete' })).toBe('completed')

      const documents = await jobCertificatesOk(request, token, jobId)
      expect(documents.counts).toEqual({ dataBearing: 3, sanitized: 3, required: 3, issued: 3, missing: 0 })
      expect(documents.issue).toEqual({ allowed: true })
      const retried = documents.items.find((item) => item.sourceRun.id === passRun)
      expect(retried).toMatchObject({ status: 'issued', locale: 'pl' })

      const text = pdfText(await downloadPdfOk(request, token, jobId, retried!.id))
      for (const value of ['Certyfikat usunięcia danych', retried!.certificateNumber, `QA Zakład Łódź ${suffix}`, assets[0].serial, 'NVME-E2E-1', 'PASS']) {
        expect(text).toContain(value)
      }
      jobId = null
    } finally {
      if (jobId) await postTransition(request, token, jobId, { action: 'cancel', reason: 'QA cleanup' }).catch(() => undefined)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

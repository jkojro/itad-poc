import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { advanceToReceiving, CONFIRM, createSchedulableJob, postTransition, transitionOk, uniqueSuffix } from './itad-job-fixtures'
import { issueMissingOk } from './itad-certificate-fixtures'
import { csv, importManifestOk } from './itad-manifest-fixtures'
import { getReconciliation, listAssets, scanOk } from './itad-receiving-fixtures'
import { resolveExceptionApi } from './itad-exception-fixtures'
import {
  approveRetry,
  assetSanitization,
  bulkResult,
  bulkStart,
  currentAssets,
  getSanitization,
  recordResult,
  startRunOk,
} from './itad-sanitization-fixtures'

/**
 * TC-ITAD-210 — Epic 3 E2E acceptance (sanitization spec TEST-310): a laptop job with
 * the default "carries data"; the manifest marks one device as not data-bearing; all
 * devices plus one unexpected are scanned and nothing is left to classify; in processing
 * one device fails, gets a manager retry and passes, the rest pass in bulk; closeout review
 * is reached. Since the exceptions spec, the unexpected device is an open exception that
 * blocks `complete` until a manager accepts it; then the job completes.
 */
test.describe('TC-ITAD-210: Epic 3 acceptance — from scan to sanitized closeout', () => {
  test('laptop job end to end', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    const tag = suffix.slice(-5).toUpperCase().replace(/[^A-Z0-9]/g, 'X')
    let companyId: string | null = null
    let jobId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD Laptops ${suffix}`)
      jobId = (await createSchedulableJob(request, token, companyId, `QA laptops ${suffix}`, { defaultDataBearing: true })).id
      const serials = Array.from({ length: 10 }, (_, index) => `LT${String(index + 1).padStart(2, '0')}${tag}`)
      const docking = serials[9]
      await importManifestOk(
        request,
        token,
        jobId,
        {
          name: `laptops-${tag}.csv`,
          content: csv([['Serial', 'Model', 'Carries data'], ...serials.map((serial) => [serial, serial === docking ? 'Dock WD19' : 'Latitude 5420', serial === docking ? 'no' : ''])]),
        },
        { serial: 'Serial', model: 'Model', dataBearing: 'Carries data' },
      )
      await advanceToReceiving(request, token, jobId)
      for (const serial of serials) await scanOk(request, token, jobId, serial)
      const unexpected = `UX${tag}`
      await scanOk(request, token, jobId, unexpected)

      // Nothing left to classify: blanks and the unexpected device take the job default.
      expect((await getReconciliation(request, token, jobId)).dataBearingUndecided).toBe(0)
      expect((await listAssets(request, token, jobId, 'dataBearing=false')).items.map((asset) => asset.serial)).toEqual([docking])
      expect((await listAssets(request, token, jobId, 'status=sanitization_required')).total).toBe(10)
      expect(await transitionOk(request, token, jobId, { action: 'start_processing' })).toBe('processing')

      // One laptop fails, a manager approves a retry, the second run passes.
      const [first] = await currentAssets(request, token, jobId, [serials[0]])
      const failedRun = await startRunOk(request, token, jobId, first)
      expect((await recordResult(request, token, jobId, failedRun, { result: 'FAIL', verificationMethod: 'full_verification', verificationNotes: 'Verification found data' })).status()).toBe(200)
      expect((await approveRetry(request, token, jobId, (await currentAssets(request, token, jobId, [serials[0]]))[0], 'Re-run with purge')).status()).toBe(200)
      const secondRun = await startRunOk(request, token, jobId, (await currentAssets(request, token, jobId, [serials[0]]))[0])
      expect((await recordResult(request, token, jobId, secondRun, { result: 'PASS', verificationMethod: 'full_verification' })).status()).toBe(200)

      // The rest of the data-bearing devices pass in bulk.
      const rest = await currentAssets(request, token, jobId, [...serials.slice(1, 9), unexpected])
      expect((await bulkStart(request, token, jobId, rest.map((asset) => asset.id))).status()).toBe(201)
      expect((await bulkResult(request, token, jobId, rest.map((asset) => asset.id), { result: 'PASS', verificationMethod: 'sample_verification' })).status()).toBe(200)
      const counts = (await readJsonSafe<{ counts: Record<string, number> }>(await getSanitization(request, token, jobId, '/sanitization')))?.counts
      expect(counts).toEqual({ required: 0, inProgress: 0, sanitized: 10, reviewRequired: 0 })
      expect((await assetSanitization(request, token, jobId, first.id)).runs.map((run) => run.result)).toEqual(['PASS', 'FAIL'])

      // Closeout review is reached once every data-bearing device is sanitized.
      expect(await transitionOk(request, token, jobId, { action: 'start_closeout', confirmations: [CONFIRM('allAssetsProcessed')] })).toBe('closeout_review')
      // Since the exceptions spec the unexpected device is an OPEN UNEXPECTED_ASSET exception,
      // and the FAIL was resolved by the retry; `complete` waits for the open one.
      const exceptions = await apiRequest(request, 'GET', `/api/itad/jobs/${jobId}/exceptions`, { token })
      const list = (await readJsonSafe<{ items: Array<{ type: string; status: string; serial: string; resolutionOutcome: string | null }> }>(exceptions))?.items ?? []
      expect(list.map((entry) => [entry.type, entry.status, entry.resolutionOutcome]).sort()).toEqual([
        ['sanitization_failed', 'resolved', 'retry_approved'],
        ['unexpected_asset', 'open', null],
      ])
      // Since the certificates spec the ten sanitized devices also need certificates.
      const blocked = await postTransition(request, token, jobId, { action: 'complete' })
      expect(blocked.status()).toBe(400)
      expect(await readJsonSafe(blocked)).toMatchObject({
        code: 'itad.jobs.errors.condition_unmet',
        conditions: ['noBlockingExceptions', 'requiredDocumentsComplete'],
      })
      // A manager accepts the unexpected device; then the job completes.
      const unexpectedException = (await readJsonSafe<{ items: Array<{ id: string; type: string; updatedAt: string }> }>(
        await apiRequest(request, 'GET', `/api/itad/jobs/${jobId}/exceptions?status=open`, { token }),
      ))!.items[0]
      expect((await resolveExceptionApi(request, token, jobId, unexpectedException, 'accepted_into_job', 'Customer asked to wipe it too')).status()).toBe(200)
      const certificates = await issueMissingOk(request, token, jobId)
      expect(certificates).toMatchObject({ failed: [] })
      expect(certificates.issued).toHaveLength(10)
      expect(await transitionOk(request, token, jobId, { action: 'complete' })).toBe('completed')
      jobId = null
    } finally {
      if (jobId) await postTransition(request, token, jobId, { action: 'cancel', reason: 'QA cleanup' }).catch(() => undefined)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

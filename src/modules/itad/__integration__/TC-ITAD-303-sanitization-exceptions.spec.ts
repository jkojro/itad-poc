import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { createSchedulableJob, postTransition, transitionOk, uniqueSuffix } from './itad-job-fixtures'
import { classifyAssets } from './itad-receiving-fixtures'
import {
  approveRetry,
  bulkResult,
  bulkStart,
  currentAssets,
  processingJobWithDataBearingAssets,
  recordResult,
  startRunOk,
} from './itad-sanitization-fixtures'
import { exceptionDetail, listExceptions } from './itad-exception-fixtures'

/**
 * TC-ITAD-303 (exceptions spec TEST-405; AC-405): every FAIL run opens its own
 * SANITIZATION_FAILED exception (single and bulk); the manager retry resolves it as
 * `retry_approved`; a second FAIL opens a new one; re-classifying a device in review as
 * not data-bearing resolves it as `not_data_bearing`; cancelling resolves the rest.
 */
test.describe('TC-ITAD-303: sanitization failures as exceptions', () => {
  test('FAIL, retry, second FAIL, bulk FAIL, re-classification and cancel', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    let companyId: string | null = null
    let jobId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD Exc San ${suffix}`)
      jobId = (await createSchedulableJob(request, token, companyId, `QA exc san ${suffix}`)).id
      const assets = await processingJobWithDataBearingAssets(request, token, jobId, 4)
      const serials = assets.map((asset) => asset.serial)
      const failOf = async (index: number, notes: string) => {
        const runId = await startRunOk(request, token, jobId!, (await currentAssets(request, token, jobId!, serials))[index])
        expect((await recordResult(request, token, jobId!, runId, { result: 'FAIL', verificationMethod: 'full_verification', verificationNotes: notes })).status()).toBe(200)
        return runId
      }

      // Run 1 FAIL → exception; retry resolves it; run 2 FAIL → a new exception.
      const run1 = await failOf(0, 'Readable sectors')
      let open = await listExceptions(request, token, jobId, 'status=open&type=sanitization_failed')
      expect(open.items.map((entry) => [entry.sanitizationRunId, entry.assetId])).toEqual([[run1, assets[0].id]])
      const firstException = open.items[0].id
      expect((await approveRetry(request, token, jobId, (await currentAssets(request, token, jobId, serials))[0], 'Replaced the cable')).status()).toBe(200)
      expect(await exceptionDetail(request, token, jobId, firstException)).toMatchObject({
        status: 'resolved',
        resolutionOutcome: 'retry_approved',
        resolutionReason: 'Replaced the cable',
      })
      expect((await currentAssets(request, token, jobId, serials))[0].status).toBe('sanitization_required')
      const run2 = await failOf(0, 'Still readable')
      open = await listExceptions(request, token, jobId, 'status=open&type=sanitization_failed')
      expect(open.items.map((entry) => entry.sanitizationRunId)).toEqual([run2])

      // Bulk FAIL: one exception per run.
      const bulkIds = [assets[1].id, assets[2].id]
      expect((await bulkStart(request, token, jobId, bulkIds)).status()).toBe(201)
      expect((await bulkResult(request, token, jobId, bulkIds, { result: 'FAIL', verificationMethod: 'none', verificationNotes: 'Rack power loss' })).status()).toBe(200)
      open = await listExceptions(request, token, jobId, 'status=open&type=sanitization_failed')
      expect(open.total).toBe(3)

      // Re-classified as not data-bearing: the failure no longer matters (Q8).
      expect((await classifyAssets(request, token, jobId, [assets[1].id], false, 'Tablet without storage')).status()).toBe(200)
      const reclassified = (await listExceptions(request, token, jobId, `assetId=${assets[1].id}`)).items[0]
      expect(reclassified).toMatchObject({ status: 'resolved', resolutionOutcome: 'not_data_bearing', resolutionReason: 'Tablet without storage' })

      // Cancel resolves the remaining ones; the history of resolved ones is untouched.
      expect(await transitionOk(request, token, jobId, { action: 'cancel', reason: 'Contract terminated' })).toBe('cancelled')
      const all = await listExceptions(request, token, jobId)
      expect(all.items.filter((entry) => entry.status === 'open')).toEqual([])
      expect(all.items.map((entry) => entry.resolutionOutcome).sort()).toEqual(['job_cancelled', 'job_cancelled', 'not_data_bearing', 'retry_approved'])
      jobId = null
    } finally {
      if (jobId) await postTransition(request, token, jobId, { action: 'cancel', reason: 'QA cleanup' }).catch(() => undefined)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

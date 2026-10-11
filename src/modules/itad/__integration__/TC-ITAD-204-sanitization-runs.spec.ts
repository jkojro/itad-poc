import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { createSchedulableJob, postTransition, uniqueSuffix } from './itad-job-fixtures'
import {
  abortRun,
  approveRetry,
  assetSanitization,
  attachEvidence,
  currentAssets,
  getSanitization,
  processingJobWithDataBearingAssets,
  recordResult,
  startRun,
  startRunOk,
} from './itad-sanitization-fixtures'

/**
 * TC-ITAD-204 (sanitization spec TEST-306): PASS with all fields; FAIL needs notes and
 * records `sanitization_failed` then `review_required`; a manager retry and a second run
 * that passes keep both runs; abort returns the device to `sanitization_required`; a run
 * is completed only once; evidence links to runs and downloads; cancelling the job
 * aborts an open run with reason `job_cancelled`.
 */
test.describe('TC-ITAD-204: sanitization runs, PASS/FAIL, retry, abort and cancel', () => {
  test('full single-asset lifecycle', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    let companyId: string | null = null
    let jobId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD Runs ${suffix}`)
      jobId = (await createSchedulableJob(request, token, companyId, `QA runs ${suffix}`)).id
      const [first, second, third] = await processingJobWithDataBearingAssets(request, token, jobId, 3)
      const serials = [first.serial, second.serial, third.serial]

      // PASS with all fields.
      const run1 = await startRunOk(request, token, jobId, first)
      expect((await currentAssets(request, token, jobId, serials))[0].status).toBe('sanitization_in_progress')
      const stale = await startRun(request, token, jobId, (await currentAssets(request, token, jobId, serials))[0])
      expect(stale.status()).toBe(409)
      expect((await readJsonSafe<{ code?: string }>(stale))?.code).toBe('itad.sanitization.errors.asset_transition_not_allowed')
      const pass = await recordResult(request, token, jobId, run1, { result: 'PASS', verificationMethod: 'full_verification', verificationNotes: 'Report #4411' })
      expect(pass.status()).toBe(200)
      expect(await readJsonSafe(pass)).toMatchObject({ result: 'PASS', assetStatus: 'sanitized' })
      const again = await recordResult(request, token, jobId, run1, { result: 'FAIL', verificationMethod: 'none', verificationNotes: 'late' })
      expect(again.status()).toBe(409)
      expect((await readJsonSafe<{ code?: string }>(again))?.code).toBe('itad.sanitization.errors.run_closed')
      const firstHistory = await assetSanitization(request, token, jobId, first.id)
      expect(firstHistory.runs[0]).toMatchObject({
        id: run1,
        result: 'PASS',
        method: 'purge',
        tool: 'Blancco Drive Eraser',
        toolVersion: '7.9',
        verificationMethod: 'full_verification',
        verificationNotes: 'Report #4411',
      })

      // Evidence: one file linked to the run, downloadable.
      const evidence = await attachEvidence(request, token, jobId, [run1], { name: `report-${suffix}.txt`, content: 'erasure report' })
      expect(evidence.status(), JSON.stringify(await readJsonSafe(evidence))).toBe(201)
      const { attachmentId } = (await readJsonSafe<{ attachmentId: string }>(evidence))!
      const download = await getSanitization(request, token, jobId, `/sanitization/evidence/${attachmentId}/file`)
      expect(download.status()).toBe(200)
      expect(await download.text()).toBe('erasure report')
      expect((await assetSanitization(request, token, jobId, first.id)).runs[0].evidence).toEqual([
        expect.objectContaining({ attachmentId, fileName: `report-${suffix}.txt` }),
      ])

      // FAIL: notes required; two history rows; then a manager retry and a passing second run.
      const run2 = await startRunOk(request, token, jobId, second)
      const noNotes = await recordResult(request, token, jobId, run2, { result: 'FAIL', verificationMethod: 'full_verification' })
      expect(noNotes.status()).toBe(400)
      expect((await readJsonSafe<{ code?: string }>(noNotes))?.code).toBe('itad.sanitization.errors.verification_notes_required')
      const fail = await recordResult(request, token, jobId, run2, { result: 'FAIL', verificationMethod: 'full_verification', verificationNotes: 'Bad sectors' })
      expect(await readJsonSafe(fail)).toMatchObject({ result: 'FAIL', assetStatus: 'review_required' })
      const failedHistory = (await assetSanitization(request, token, jobId, second.id)).history
      expect(failedHistory.slice(-2)).toEqual([
        expect.objectContaining({ action: 'record_fail', fromStatus: 'sanitization_in_progress', toStatus: 'sanitization_failed', runId: run2 }),
        expect.objectContaining({ action: 'record_fail', fromStatus: 'sanitization_failed', toStatus: 'review_required', runId: run2 }),
      ])
      const reviewAsset = (await currentAssets(request, token, jobId, serials))[1]
      expect((await approveRetry(request, token, jobId, reviewAsset, null)).status()).toBe(400)
      const retry = await approveRetry(request, token, jobId, reviewAsset, 'Replaced the cable, try again')
      expect(retry.status()).toBe(200)
      const run3 = await startRunOk(request, token, jobId, (await currentAssets(request, token, jobId, serials))[1])
      expect((await recordResult(request, token, jobId, run3, { result: 'PASS', verificationMethod: 'sample_verification' })).status()).toBe(200)
      const secondHistory = await assetSanitization(request, token, jobId, second.id)
      expect(secondHistory.asset.status).toBe('sanitized')
      expect(secondHistory.runs.map((run) => [run.id, run.result])).toEqual([[run3, 'PASS'], [run2, 'FAIL']])
      expect(secondHistory.history.map((entry) => entry.action)).toEqual([
        'classify',
        'start_run',
        'record_fail',
        'record_fail',
        'approve_retry',
        'start_run',
        'record_pass',
      ])
      expect(secondHistory.history.find((entry) => entry.action === 'approve_retry')?.reason).toBe('Replaced the cable, try again')

      // Abort: reason required; the asset waits for a new run.
      const run4 = await startRunOk(request, token, jobId, third)
      expect((await abortRun(request, token, jobId, run4, '')).status()).toBe(400)
      const aborted = await abortRun(request, token, jobId, run4, 'Wrong device on the rack')
      expect(await readJsonSafe(aborted)).toMatchObject({ result: 'ABORTED', assetStatus: 'sanitization_required' })

      // Counters on the tab.
      const list = await getSanitization(request, token, jobId, '/sanitization')
      expect((await readJsonSafe<{ counts: unknown }>(list))?.counts).toEqual({ required: 1, inProgress: 0, sanitized: 2, reviewRequired: 0 })

      // Cancelling the job aborts the open run with `job_cancelled`.
      const run5 = await startRunOk(request, token, jobId, (await currentAssets(request, token, jobId, serials))[2])
      const cancel = await postTransition(request, token, jobId, { action: 'cancel', reason: 'Customer withdrew' })
      expect(cancel.status()).toBe(200)
      const thirdHistory = await assetSanitization(request, token, jobId, third.id)
      expect(thirdHistory.asset.status).toBe('sanitization_required')
      expect(thirdHistory.runs[0]).toMatchObject({ id: run5, result: 'ABORTED', abortReason: 'job_cancelled' })
      expect(thirdHistory.runs[1]).toMatchObject({ id: run4, result: 'ABORTED', abortReason: 'Wrong device on the rack' })
      expect(thirdHistory.history.at(-1)).toMatchObject({ action: 'abort_run', toStatus: 'sanitization_required', reason: 'job_cancelled', runId: run5 })
      jobId = null
    } finally {
      if (jobId) await postTransition(request, token, jobId, { action: 'cancel', reason: 'QA cleanup' }).catch(() => undefined)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

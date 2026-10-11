import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { createSchedulableJob, postTransition, uniqueSuffix } from './itad-job-fixtures'
import {
  assetSanitization,
  attachEvidence,
  bulkResult,
  bulkStart,
  currentAssets,
  getSanitization,
  processingJobWithDataBearingAssets,
  startRunOk,
} from './itad-sanitization-fixtures'

/**
 * TC-ITAD-208 (sanitization spec TEST-308): bulk start of 20 devices is all-or-nothing
 * (one device already running blocks the request and is named); a bulk PASS closes every
 * open run; one evidence file is linked to all 20 runs and downloads once per run.
 */
test.describe('TC-ITAD-208: bulk sanitization and shared evidence', () => {
  test('20 devices: blocked bulk start, bulk start, bulk PASS, one report for all', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    let companyId: string | null = null
    let jobId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD Bulk ${suffix}`)
      jobId = (await createSchedulableJob(request, token, companyId, `QA bulk ${suffix}`)).id
      const assets = await processingJobWithDataBearingAssets(request, token, jobId, 21)
      const [extra, ...rack] = assets
      const rackIds = rack.map((asset) => asset.id)

      // One device of the selection is already running: nothing starts.
      await startRunOk(request, token, jobId, extra)
      const blocked = await bulkStart(request, token, jobId, [...rackIds.slice(0, 19), extra.id])
      expect(blocked.status()).toBe(409)
      expect(await readJsonSafe(blocked)).toMatchObject({ code: 'itad.sanitization.errors.asset_transition_not_allowed', blockingAssetIds: [extra.id] })
      expect((await currentAssets(request, token, jobId, rack.map((asset) => asset.serial))).every((asset) => asset.status === 'sanitization_required')).toBe(true)

      // FAIL in bulk needs notes; a result for devices without an open run is refused.
      expect((await bulkResult(request, token, jobId, rackIds, { result: 'FAIL', verificationMethod: 'none' })).status()).toBe(400)
      const noRuns = await bulkResult(request, token, jobId, rackIds, { result: 'PASS', verificationMethod: 'full_verification' })
      expect(noRuns.status()).toBe(409)

      const started = await bulkStart(request, token, jobId, rackIds, { method: 'clear', tool: 'QA Rack Eraser', toolVersion: '3.0' })
      expect(started.status(), JSON.stringify(await readJsonSafe(started))).toBe(201)
      const startedBody = (await readJsonSafe<{ bulkBatchId: string; runs: Array<{ runId: string; assetId: string }> }>(started))!
      expect(startedBody.runs).toHaveLength(20)

      const passed = await bulkResult(request, token, jobId, rackIds, { result: 'PASS', verificationMethod: 'sample_verification', verificationNotes: 'Rack report R-7' })
      expect(passed.status()).toBe(200)
      const list = await readJsonSafe<{ counts: Record<string, number> }>(await getSanitization(request, token, jobId, '/sanitization'))
      expect(list?.counts).toEqual({ required: 0, inProgress: 1, sanitized: 20, reviewRequired: 0 })

      // One rack report for all 20 runs.
      const runIds = startedBody.runs.map((run) => run.runId)
      const evidence = await attachEvidence(request, token, jobId, runIds, { name: `rack-${suffix}.txt`, content: 'rack report' })
      expect(evidence.status(), JSON.stringify(await readJsonSafe(evidence))).toBe(201)
      const { attachmentId } = (await readJsonSafe<{ attachmentId: string }>(evidence))!
      for (const asset of [rack[0], rack[19]]) {
        const history = await assetSanitization(request, token, jobId, asset.id)
        expect(history.runs[0]).toMatchObject({ result: 'PASS', method: 'clear', tool: 'QA Rack Eraser', verificationNotes: 'Rack report R-7' })
        expect(history.runs[0].evidence.map((entry) => entry.attachmentId)).toEqual([attachmentId])
      }
      const download = await getSanitization(request, token, jobId, `/sanitization/evidence/${attachmentId}/file`)
      expect(await download.text()).toBe('rack report')
      // A run of another job cannot be linked.
      const unknownRun = await attachEvidence(request, token, jobId, ['00000000-0000-4000-8000-000000000000'], { name: 'x.txt', content: 'x' })
      expect(unknownRun.status()).toBe(409)
    } finally {
      if (jobId) await postTransition(request, token, jobId, { action: 'cancel', reason: 'QA cleanup' }).catch(() => undefined)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

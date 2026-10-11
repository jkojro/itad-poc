import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { CONFIRM, createSchedulableJob, postTransition, transitionOk, uniqueSuffix } from './itad-job-fixtures'
import { classifyAssets } from './itad-receiving-fixtures'
import { assetSanitization, currentAssets, processingJobWithDataBearingAssets, recordResult, startRunOk } from './itad-sanitization-fixtures'

const errorCode = async (response: { json: () => Promise<unknown> }) => ((await response.json()) as { code?: string }).code

/**
 * TC-ITAD-206 (sanitization spec TEST-305, processing and closeout part): after
 * receiving, classification needs `itad.sanitization.manage` and a reason, is recorded
 * in the history, and is refused during an open run; in closeout review only
 * `true → false` is allowed.
 */
test.describe('TC-ITAD-206: classification changes after receiving', () => {
  test('manager with reason in processing; closeout review only true → false', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const employeeToken = await getAuthToken(request, 'employee')
    const suffix = uniqueSuffix()
    let companyId: string | null = null
    let jobId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD Reclass ${suffix}`)
      jobId = (await createSchedulableJob(request, token, companyId, `QA reclass ${suffix}`)).id
      const [first, second, third] = await processingJobWithDataBearingAssets(request, token, jobId, 3)
      const serials = [first.serial, second.serial, third.serial]

      const asEmployee = await classifyAssets(request, employeeToken, jobId, [first.id], false, 'No disk inside')
      expect(asEmployee.status()).toBe(403)
      const noReason = await classifyAssets(request, token, jobId, [first.id], false)
      expect(noReason.status()).toBe(400)
      expect(await errorCode(noReason)).toBe('itad.assets.errors.reason_required')
      const corrected = await classifyAssets(request, token, jobId, [first.id], false, 'No disk inside')
      expect(corrected.status()).toBe(200)
      const firstHistory = await assetSanitization(request, token, jobId, first.id)
      expect(firstHistory.asset.status).toBe('received')
      expect(firstHistory.history.at(-1)).toMatchObject({ action: 'classify', fromStatus: 'sanitization_required', toStatus: 'received', reason: 'No disk inside' })
      // Back to true in processing: sanitization required again.
      expect((await classifyAssets(request, token, jobId, [first.id], true, 'Found an SSD after all')).status()).toBe(200)
      expect((await currentAssets(request, token, jobId, serials))[0].status).toBe('sanitization_required')

      // Refused while a run is open.
      const runId = await startRunOk(request, token, jobId, second)
      const during = await classifyAssets(request, token, jobId, [second.id], false, 'Mistake')
      expect(during.status()).toBe(409)
      expect(await readJsonSafe(during)).toMatchObject({ code: 'itad.assets.errors.sanitization_in_progress', assetIds: [second.id] })
      expect((await recordResult(request, token, jobId, runId, { result: 'PASS', verificationMethod: 'full_verification' })).status()).toBe(200)

      // Closeout review: true → false accepted, → true refused.
      expect((await classifyAssets(request, token, jobId, [first.id, third.id], false, 'Batch had no storage')).status()).toBe(200)
      await transitionOk(request, token, jobId, { action: 'start_closeout', confirmations: [CONFIRM('allAssetsProcessed')] })
      const toFalse = await classifyAssets(request, token, jobId, [second.id], false, 'Tablet with removed storage')
      expect(toFalse.status()).toBe(200)
      const toTrue = await classifyAssets(request, token, jobId, [first.id], true, 'Found an SSD')
      expect(toTrue.status()).toBe(409)
      expect(await readJsonSafe(toTrue)).toMatchObject({ code: 'itad.assets.errors.sanitization_not_possible', assetIds: [first.id] })
      // The sanitized device's run stays in the history after it left sanitization.
      const secondHistory = await assetSanitization(request, token, jobId, second.id)
      expect(secondHistory.asset.status).toBe('received')
      expect(secondHistory.runs.map((run) => run.result)).toEqual(['PASS'])
    } finally {
      if (jobId) await postTransition(request, token, jobId, { action: 'cancel', reason: 'QA cleanup' }).catch(() => undefined)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

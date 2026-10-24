import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { getTokenScope } from '@open-mercato/core/helpers/integration/generalFixtures'
import { createSchedulableJob, uniqueSuffix } from './itad-job-fixtures'
import { assetSanitization, currentAssets, processingJobWithDataBearingAssets, recordResult, startRunOk } from './itad-sanitization-fixtures'
import { assignExceptionApi, exceptionDetail, listExceptions } from './itad-exception-fixtures'
import { confirmAction, deletePendingActions, latestActionLog, seedPendingAction } from './itad-ai-fixtures'

/**
 * TC-ITAD-813 (AI assistant spec AC-AI-07, AC-AI-08, AI-REQ-13): a confirmed retry moves
 * the device from review back to sanitization required, resolves its failure as
 * `retry_approved`, keeps the failed run and audits the AI source. The record version
 * covers the device AND its open failure: a failure changed after the preview makes the
 * action stale with the device unchanged. A device not in review is refused at execute.
 * (Refusals at prepare — no preview for a device not in review — are unit tests: a
 * proposal is created only during a model turn.)
 */
test.describe('TC-ITAD-813: AI approve sanitization retry', () => {
  test('confirm approves the retry; a changed failure is stale; a device not in review is refused', async ({ request }) => {
    test.setTimeout(180_000)
    const token = await getAuthToken(request, 'admin')
    const { tenantId, organizationId, userId } = getTokenScope(token)
    const suffix = uniqueSuffix()
    const actions: string[] = []
    let companyId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA AI Retry ${suffix}`)
      const job = await createSchedulableJob(request, token, companyId, `QA AI retry ${suffix}`)
      const assets = await processingJobWithDataBearingAssets(request, token, job.id, 3)
      const serials = assets.map((asset) => asset.serial)
      const fail = async (index: number) => {
        const runId = await startRunOk(request, token, job.id, (await currentAssets(request, token, job.id, serials))[index])
        expect((await recordResult(request, token, job.id, runId, { result: 'FAIL', verificationMethod: 'full_verification', verificationNotes: 'Readable sectors' })).status()).toBe(200)
        return runId
      }
      const openFailure = async (assetId: string) =>
        (await listExceptions(request, token, job.id, `status=open&type=sanitization_failed&assetId=${assetId}`)).items[0]
      const seed = async (assetId: string, recordVersion: string, reason = 'Drive reseated, retry') => {
        const id = await seedPendingAction({
          tenantId,
          organizationId,
          createdByUserId: userId,
          toolName: 'itad.approve_sanitization_retry',
          normalizedInput: { jobId: job.id, assetId, reason },
          recordVersion,
          targetEntityType: 'itad.asset',
          targetRecordId: assetId,
        })
        actions.push(id)
        return id
      }

      // Confirmed: review → sanitization required, the failure resolved, the failed run kept.
      const failedRun = await fail(0)
      const reviewed = (await currentAssets(request, token, job.id, serials))[0]
      expect(reviewed.status).toBe('review_required')
      const failure = await openFailure(reviewed.id)
      const confirmed = await confirmAction(request, token, await seed(reviewed.id, `${reviewed.updatedAt}|${failure.id}@${failure.updatedAt}`))
      expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200)
      expect(confirmed.body).toMatchObject({ ok: true, mutationResult: { recordId: reviewed.id, commandName: 'itad.sanitization.approve_retry' } })
      const history = await assetSanitization(request, token, job.id, reviewed.id)
      expect(history.asset.status).toBe('sanitization_required')
      expect(history.runs.map((run) => [run.id, run.result])).toEqual([[failedRun, 'FAIL']])
      expect(await exceptionDetail(request, token, job.id, failure.id)).toMatchObject({ status: 'resolved', resolutionOutcome: 'retry_approved' })
      const log = await latestActionLog(request, token, reviewed.id)
      expect(log).toMatchObject({ actorUserId: userId, commandId: 'itad.sanitization.approve_retry' })
      expect(log?.context).toMatchObject({ source: 'ai', channel: 'chat', toolName: 'itad.approve_sanitization_retry', origin: { type: 'user', userId } })

      // The failure changed after the preview (here: assigned) → stale, nothing written.
      await fail(1)
      const second = (await currentAssets(request, token, job.id, serials))[1]
      const secondFailure = await openFailure(second.id)
      const staleAction = await seed(second.id, `${second.updatedAt}|${secondFailure.id}@${secondFailure.updatedAt}`)
      expect((await assignExceptionApi(request, token, job.id, secondFailure, userId)).status()).toBe(200)
      const stale = await confirmAction(request, token, staleAction)
      expect(stale.status, JSON.stringify(stale.body)).toBe(412)
      expect(stale.body?.code).toBe('stale_version')
      expect((await currentAssets(request, token, job.id, serials))[1]).toMatchObject({ status: 'review_required', updatedAt: second.updatedAt })
      expect((await exceptionDetail(request, token, job.id, secondFailure.id)).status).toBe('open')

      // A device not in review (never failed): the preview was blocked; Confirm writes nothing.
      const fresh = (await currentAssets(request, token, job.id, serials))[2]
      const refused = await confirmAction(request, token, await seed(fresh.id, 'ineligible:asset_not_in_review'))
      expect(refused.body).toMatchObject({ ok: false, pendingAction: { status: 'failed' } })
      expect(refused.body?.mutationResult?.error?.message).toContain('not waiting for a retry decision')
      expect((await currentAssets(request, token, job.id, serials))[2]).toMatchObject({ status: 'sanitization_required', updatedAt: fresh.updatedAt })

      // An empty reason never satisfies the tool schema, whatever was stored.
      const noReason = await confirmAction(request, token, await seed(second.id, 'x', ' '))
      expect(noReason.status).toBe(412)
      expect(noReason.body?.code).toBe('schema_drift')
    } finally {
      await deletePendingActions(actions)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

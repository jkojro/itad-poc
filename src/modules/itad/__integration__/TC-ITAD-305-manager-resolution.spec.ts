import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { advanceToReceiving, CONFIRM, createSchedulableJob, postTransition, transitionOk, uniqueSuffix } from './itad-job-fixtures'
import { csv, importManifestOk, listManifestItems } from './itad-manifest-fixtures'
import { classifyUndecided, listAssets, scanOk } from './itad-receiving-fixtures'
import { exceptionDetail, listExceptions, resolveExceptionApi } from './itad-exception-fixtures'

const errorCode = async (response: { json: () => Promise<unknown> }) => ((await response.json()) as { code?: string }).code

/**
 * TC-ITAD-305 (exceptions spec TEST-402 completion, TEST-403; AC-401, AC-403, AC-406): a
 * manager resolves MISSING (`not_shipped`) and UNEXPECTED (`accepted_into_job`) with a
 * reason; outcomes of another type, a missing reason and a stale version are refused;
 * manifest and asset data stay unchanged; once nothing is OPEN, `complete` passes
 * without any manual exception confirmation.
 */
test.describe('TC-ITAD-305: manager resolution of missing and unexpected', () => {
  test('resolve both, then complete the job', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    const tag = suffix.slice(-5).toUpperCase().replace(/[^A-Z0-9]/g, 'X')
    let companyId: string | null = null
    let jobId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD Exc Resolve ${suffix}`)
      jobId = (await createSchedulableJob(request, token, companyId, `QA exc resolve ${suffix}`, { defaultDataBearing: false })).id
      await importManifestOk(request, token, jobId, { name: `r-${tag}.csv`, content: csv([['Serial'], [`RA${tag}`], [`RB${tag}`]]) }, { serial: 'Serial' })
      await advanceToReceiving(request, token, jobId)
      await scanOk(request, token, jobId, `RA${tag}`)
      await scanOk(request, token, jobId, `RU${tag}`)
      await classifyUndecided(request, token, jobId, false)
      expect(await transitionOk(request, token, jobId, { action: 'start_processing' })).toBe('processing')
      expect(await transitionOk(request, token, jobId, { action: 'start_closeout', confirmations: [CONFIRM('allAssetsProcessed')] })).toBe('closeout_review')

      const open = await listExceptions(request, token, jobId, 'status=open')
      const missing = open.items.find((entry) => entry.type === 'missing_from_delivery')!
      const unexpected = open.items.find((entry) => entry.type === 'unexpected_asset')!
      expect([missing.serial, unexpected.serial]).toEqual([`RB${tag}`, `RU${tag}`])

      const wrongOutcome = await resolveExceptionApi(request, token, jobId, missing, 'accepted_into_job', 'Not for this type')
      expect(wrongOutcome.status()).toBe(400)
      expect(await errorCode(wrongOutcome)).toBe('itad.exceptions.errors.outcome_invalid')
      const noReason = await resolveExceptionApi(request, token, jobId, missing, 'not_shipped', null)
      expect(noReason.status()).toBe(400)
      expect(await errorCode(noReason)).toBe('itad.exceptions.errors.reason_required')
      const stale = await resolveExceptionApi(request, token, jobId, { id: missing.id, updatedAt: '2000-01-01T00:00:00.000Z' }, 'not_shipped', 'Customer kept it')
      expect(stale.status()).toBe(409)

      expect((await resolveExceptionApi(request, token, jobId, missing, 'not_shipped', 'Customer confirmed it was not sent')).status()).toBe(200)
      expect((await resolveExceptionApi(request, token, jobId, unexpected, 'accepted_into_job', 'Customer asked to process it too')).status()).toBe(200)
      const again = await resolveExceptionApi(request, token, jobId, (await exceptionDetail(request, token, jobId, missing.id)), 'lost_in_transit', 'Second try')
      expect(again.status()).toBe(409)
      expect(await errorCode(again)).toBe('itad.exceptions.errors.exception_resolved')

      const resolved = await exceptionDetail(request, token, jobId, missing.id)
      expect(resolved).toMatchObject({ status: 'resolved', resolutionOutcome: 'not_shipped', resolutionReason: 'Customer confirmed it was not sent' })
      expect(resolved.resolvedBy?.id).toBeTruthy()
      expect(resolved.events.map((event) => event.kind)).toEqual(['created', 'resolved'])
      // No data rewrite: the manifest item and the unexpected asset are as they were.
      expect((await listManifestItems(request, token, jobId, 'reconciliation=missing')).items.map((item) => item.serial)).toEqual([`RB${tag}`])
      expect((await listAssets(request, token, jobId, 'reconciliation=unexpected')).items.map((asset) => asset.serial)).toEqual([`RU${tag}`])

      // Nothing OPEN → complete passes with only the documents confirmation (AC-406).
      const complete = await postTransition(request, token, jobId, { action: 'complete', confirmations: [CONFIRM('requiredDocumentsComplete')] })
      expect(complete.status(), JSON.stringify(await readJsonSafe(complete))).toBe(200)
      jobId = null
    } finally {
      if (jobId) await postTransition(request, token, jobId, { action: 'cancel', reason: 'QA cleanup' }).catch(() => undefined)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

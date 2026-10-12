import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { advanceToReceiving, CONFIRM, createSchedulableJob, postTransition, transitionOk, uniqueSuffix } from './itad-job-fixtures'
import { csv, importManifestOk } from './itad-manifest-fixtures'
import { scanAction, scanOk } from './itad-receiving-fixtures'
import { approveRetry, bulkResult, bulkStart, currentAssets, recordResult, startRunOk } from './itad-sanitization-fixtures'
import { exceptionDetail, listExceptions, resolveExceptionApi, timelineOf } from './itad-exception-fixtures'

/**
 * TC-ITAD-310 — Epic 4 E2E demo (exceptions spec TEST-410; AC-401 … AC-406, AC-408). One
 * job, data-bearing by default:
 * - manifest LT1…LT5; LT5 never arrives (AC-401 → MISSING);
 * - CX is scanned unexpected, then covered by a manifest correction (AC-402 → none);
 * - UX stays unexpected (AC-403 → UNEXPECTED);
 * - LT1 is scanned twice, "same device" by the receiving role (AC-404);
 * - LT2 fails, gets a retry and passes (AC-405); the rest pass in bulk;
 * - `complete` is refused while anything is OPEN (AC-406), then passes with no manual
 *   exception confirmation; the device timeline tells the story (AC-408).
 */
test.describe('TC-ITAD-310: Epic 4 acceptance — exceptions from receiving to completion', () => {
  test('one job through all four exception types to completion', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const employeeToken = await getAuthToken(request, 'employee')
    const suffix = uniqueSuffix()
    const tag = suffix.slice(-5).toUpperCase().replace(/[^A-Z0-9]/g, 'X')
    let companyId: string | null = null
    let jobId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD Epic4 ${suffix}`)
      jobId = (await createSchedulableJob(request, token, companyId, `QA epic 4 ${suffix}`, { defaultDataBearing: true })).id
      const items = [1, 2, 3, 4, 5].map((index) => `LT${index}${tag}`)
      const corrected = `CX${tag}`
      const stray = `UX${tag}`
      await importManifestOk(request, token, jobId, { name: `e4-${tag}.csv`, content: csv([['Serial'], ...items.map((s) => [s])]) }, { serial: 'Serial' })
      await advanceToReceiving(request, token, jobId)
      for (const serial of items.slice(0, 4)) await scanOk(request, token, jobId, serial)
      await scanOk(request, token, jobId, corrected)
      await importManifestOk(request, token, jobId, { name: `fix-${tag}.csv`, content: csv([['Serial'], [corrected]]) }, { serial: 'Serial' })
      await scanOk(request, token, jobId, stray)
      const duplicate = await scanOk(request, token, jobId, items[0])
      expect((await listExceptions(request, token, jobId, 'status=open')).items.map((entry) => entry.type)).toEqual(['duplicate_serial'])
      expect((await scanAction(request, employeeToken, jobId, duplicate.scan.id, 'resolve', 'Scanned twice')).status()).toBe(200)

      expect(await transitionOk(request, token, jobId, { action: 'start_processing' })).toBe('processing')
      let open = await listExceptions(request, token, jobId, 'status=open')
      expect(open.items.map((entry) => [entry.type, entry.serial]).sort()).toEqual([
        ['missing_from_delivery', items[4]],
        ['unexpected_asset', stray],
      ])

      // Sanitization: LT2 fails, retry, passes; everything else passes in bulk.
      const serials = [...items.slice(0, 4), corrected, stray]
      const assets = await currentAssets(request, token, jobId, serials)
      const failRun = await startRunOk(request, token, jobId, assets[1])
      expect((await recordResult(request, token, jobId, failRun, { result: 'FAIL', verificationMethod: 'full_verification', verificationNotes: 'Readable sectors' })).status()).toBe(200)
      expect((await approveRetry(request, token, jobId, (await currentAssets(request, token, jobId, [items[1]]))[0], 'Re-run with purge')).status()).toBe(200)
      const ids = assets.map((asset) => asset.id)
      expect((await bulkStart(request, token, jobId, ids)).status()).toBe(201)
      expect((await bulkResult(request, token, jobId, ids, { result: 'PASS', verificationMethod: 'sample_verification' })).status()).toBe(200)
      expect(await transitionOk(request, token, jobId, { action: 'start_closeout', confirmations: [CONFIRM('allAssetsProcessed')] })).toBe('closeout_review')

      // Blocked while MISSING and UNEXPECTED are OPEN (AC-406).
      const blocked = await postTransition(request, token, jobId, { action: 'complete', confirmations: [CONFIRM('requiredDocumentsComplete')] })
      expect(await readJsonSafe(blocked)).toMatchObject({ code: 'itad.jobs.errors.condition_unmet', conditions: ['noBlockingExceptions'] })
      open = await listExceptions(request, token, jobId, 'status=open')
      for (const entry of open.items) {
        const outcome = entry.type === 'missing_from_delivery' ? 'lost_in_transit' : 'accepted_into_job'
        expect((await resolveExceptionApi(request, token, jobId, entry, outcome, 'Agreed with the customer')).status()).toBe(200)
      }
      expect(await transitionOk(request, token, jobId, { action: 'complete', confirmations: [CONFIRM('requiredDocumentsComplete')] })).toBe('completed')

      const all = await listExceptions(request, token, jobId)
      expect(all.items.map((entry) => [entry.type, entry.resolutionOutcome]).sort()).toEqual([
        ['duplicate_serial', 'same_device'],
        ['missing_from_delivery', 'lost_in_transit'],
        ['sanitization_failed', 'retry_approved'],
        ['unexpected_asset', 'accepted_into_job'],
      ])
      const history = await apiRequest(request, 'GET', `/api/itad/jobs/${jobId}/history`, { token })
      const completed = (await readJsonSafe<{ items: Array<{ action: string; confirmations: Array<{ condition: string }> }> }>(history))!.items[0]
      expect(completed.action).toBe('complete')
      expect(completed.confirmations.map((entry) => entry.condition)).toEqual(['requiredDocumentsComplete'])
      const failed = all.items.find((entry) => entry.type === 'sanitization_failed')!
      expect((await exceptionDetail(request, token, jobId, failed.id)).events.map((event) => event.kind)).toEqual(['created', 'resolved'])

      // AC-408: the failed device's timeline, from receiving to the completed job.
      const timeline = await timelineOf(request, token, jobId, assets[1].id)
      expect(timeline.map((entry) => entry.kind)).toEqual([
        'received',
        'data_bearing_decided',
        'reconciled',
        'sanitization_started',
        'sanitization_failed',
        'exception_opened',
        'retry_approved',
        'exception_resolved',
        'sanitization_started',
        'sanitization_passed',
        'job_completed',
      ])
      jobId = null
    } finally {
      if (jobId) await postTransition(request, token, jobId, { action: 'cancel', reason: 'QA cleanup' }).catch(() => undefined)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

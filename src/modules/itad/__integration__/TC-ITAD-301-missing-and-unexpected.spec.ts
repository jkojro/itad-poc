import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { advanceToReceiving, CONFIRM, createSchedulableJob, getJob, postTransition, transitionOk, uniqueSuffix } from './itad-job-fixtures'
import { csv, importManifestOk } from './itad-manifest-fixtures'
import { classifyUndecided, scanOk } from './itad-receiving-fixtures'
import { exceptionDetail, listExceptions } from './itad-exception-fixtures'

/**
 * TC-ITAD-301 (exceptions spec TEST-402, API part; AC-401, AC-402, AC-403, AC-406): a
 * 10-item manifest with 9 devices received and one unexpected device that the manifest
 * covered after a correction during receiving, plus one that stays unexpected. Leaving
 * receiving creates exactly one MISSING and one UNEXPECTED exception (system-created);
 * `complete` is refused while they are OPEN, and a manual confirmation is not allowed.
 */
test.describe('TC-ITAD-301: missing and unexpected become exceptions at start_processing', () => {
  test('one MISSING, one UNEXPECTED, none for the corrected device; complete blocked', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    const tag = suffix.slice(-5).toUpperCase().replace(/[^A-Z0-9]/g, 'X')
    let companyId: string | null = null
    let jobId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD Exc Missing ${suffix}`)
      jobId = (await createSchedulableJob(request, token, companyId, `QA exc missing ${suffix}`, { defaultDataBearing: false })).id
      const serials = Array.from({ length: 10 }, (_, index) => `MS${String(index + 1).padStart(2, '0')}${tag}`)
      await importManifestOk(request, token, jobId, { name: `m-${tag}.csv`, content: csv([['Serial'], ...serials.map((s) => [s])]) }, { serial: 'Serial' })
      await advanceToReceiving(request, token, jobId)
      for (const serial of serials.slice(0, 9)) await scanOk(request, token, jobId, serial)
      // Unexpected at the scan, then the manifest is corrected during receiving (AC-402).
      const corrected = `CR${tag}`
      await scanOk(request, token, jobId, corrected)
      await importManifestOk(request, token, jobId, { name: `fix-${tag}.csv`, content: csv([['Serial'], [corrected]]) }, { serial: 'Serial' })
      // This one stays unexpected (AC-403).
      const stray = `UX${tag}`
      await scanOk(request, token, jobId, stray)
      await classifyUndecided(request, token, jobId, false)

      expect((await listExceptions(request, token, jobId)).total).toBe(0)
      expect(await transitionOk(request, token, jobId, { action: 'start_processing' })).toBe('processing')

      const all = await listExceptions(request, token, jobId)
      expect(all.items.map((entry) => [entry.type, entry.serial, entry.status]).sort()).toEqual([
        ['missing_from_delivery', serials[9], 'open'],
        ['unexpected_asset', stray, 'open'],
      ])
      expect(all.openCounts).toMatchObject({ missing_from_delivery: 1, unexpected_asset: 1, duplicate_serial: 0, sanitization_failed: 0 })
      const missing = all.items.find((entry) => entry.type === 'missing_from_delivery')!
      expect(missing.assetId).toBeNull()
      expect(missing.manifestItemId).toBeTruthy()
      expect((await exceptionDetail(request, token, jobId, missing.id)).events).toEqual([
        expect.objectContaining({ kind: 'created', actor: null }),
      ])
      expect(((await getJob(request, token, jobId)) as unknown as { openExceptionCount: number }).openExceptionCount).toBe(2)
      expect((await listExceptions(request, token, jobId, 'type=unexpected_asset')).items.map((entry) => entry.serial)).toEqual([stray])

      // Closeout review is reachable; completing is not while exceptions are OPEN (AC-406).
      expect(await transitionOk(request, token, jobId, { action: 'start_closeout', confirmations: [CONFIRM('allAssetsProcessed')] })).toBe('closeout_review')
      const blocked = await postTransition(request, token, jobId, { action: 'complete', confirmations: [CONFIRM('requiredDocumentsComplete')] })
      expect(blocked.status()).toBe(400)
      expect(await readJsonSafe(blocked)).toMatchObject({ code: 'itad.jobs.errors.condition_unmet', conditions: ['noBlockingExceptions'] })
      const manual = await postTransition(request, token, jobId, {
        action: 'complete',
        confirmations: [CONFIRM('noBlockingExceptions'), CONFIRM('requiredDocumentsComplete')],
      })
      expect(await readJsonSafe(manual)).toMatchObject({ code: 'itad.jobs.errors.confirmation_not_allowed', condition: 'noBlockingExceptions' })

      // Cancelling closes the open exceptions as job_cancelled (Q9).
      expect(await transitionOk(request, token, jobId, { action: 'cancel', reason: 'Customer withdrew the order' })).toBe('cancelled')
      const closed = await listExceptions(request, token, jobId)
      expect(closed.items.every((entry) => entry.status === 'resolved' && entry.resolutionOutcome === 'job_cancelled')).toBe(true)
      expect(closed.items[0].resolutionReason).toBe('Customer withdrew the order')
      jobId = null
    } finally {
      if (jobId) await postTransition(request, token, jobId, { action: 'cancel', reason: 'QA cleanup' }).catch(() => undefined)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

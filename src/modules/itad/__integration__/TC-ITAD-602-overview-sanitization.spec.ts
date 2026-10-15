import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { advanceToReceiving, createSchedulableJob, uniqueSuffix } from './itad-job-fixtures'
import { csv, importManifestOk } from './itad-manifest-fixtures'
import { scanAction, scanOk } from './itad-receiving-fixtures'
import { approveRetry, currentAssets, processingJobWithDataBearingAssets, recordResult, startRunOk } from './itad-sanitization-fixtures'
import { listExceptions } from './itad-exception-fixtures'
import { passAsset } from './itad-certificate-fixtures'
import { jobOverviewOk } from './itad-overview-fixtures'

/**
 * TC-ITAD-602 (operations dashboard spec AC-702, AC-703, REQ-707 … REQ-710, REQ-718):
 * counters follow the current state of devices and exceptions. A FAIL is Failed (red)
 * until a retry passes; a resolved duplicate leaves Open exceptions while its history stays.
 */
test.describe('TC-ITAD-602: overview sanitization and exception counters', () => {
  test('awaiting wipe, failed, sanitized after a retry', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    let companyId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA Overview Sanit ${suffix}`)
      const job = await createSchedulableJob(request, token, companyId, `QA overview sanit ${suffix}`)
      const assets = await processingJobWithDataBearingAssets(request, token, job.id, 3)
      expect((await jobOverviewOk(request, token, job.id)).counters).toMatchObject({ awaitingWipe: 3, sanitized: 0, failed: 0, sanitizationScope: 3 })

      const failRun = await startRunOk(request, token, job.id, assets[0])
      expect((await recordResult(request, token, job.id, failRun, { result: 'FAIL', verificationMethod: 'full_verification', verificationNotes: 'Readable sectors' })).status()).toBe(200)
      const failed = await jobOverviewOk(request, token, job.id)
      expect(failed.counters).toMatchObject({ awaitingWipe: 2, failed: 1, sanitized: 0 })
      expect(failed).toMatchObject({ severity: 'red', group: 'attention_red' })
      expect(failed.signals[0]).toMatchObject({ key: 'failed', severity: 'red', count: 1, href: `/backend/itad/jobs/${job.id}?tab=sanitization&status=review_required` })

      expect((await approveRetry(request, token, job.id, (await currentAssets(request, token, job.id, [assets[0].serial]))[0], 'Re-run with purge')).status()).toBe(200)
      await passAsset(request, token, job.id, (await currentAssets(request, token, job.id, [assets[0].serial]))[0])
      const retried = await jobOverviewOk(request, token, job.id)
      expect(retried.counters).toMatchObject({ awaitingWipe: 2, failed: 0, sanitized: 1, sanitizationScope: 3 })
      expect(retried.severity).toBe('none')
    } finally {
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })

  test('a resolved duplicate leaves the open exceptions and the attention', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    const tag = suffix.slice(-6).toUpperCase().replace(/[^A-Z0-9]/g, 'X')
    let companyId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA Overview Dup ${suffix}`)
      const job = await createSchedulableJob(request, token, companyId, `QA overview dup ${suffix}`)
      await importManifestOk(
        request,
        token,
        job.id,
        { name: `dup-${tag}.csv`, content: csv([['Serial', 'Carries data'], [`DP${tag}`, 'no']]) },
        { serial: 'Serial', dataBearing: 'Carries data' },
      )
      await advanceToReceiving(request, token, job.id)
      await scanOk(request, token, job.id, `DP${tag}`)
      const duplicate = await scanOk(request, token, job.id, `DP${tag}`)

      const open = await jobOverviewOk(request, token, job.id)
      expect(open.counters).toMatchObject({ unresolvedDuplicates: 1, openExceptions: 1 })
      expect(open.severity).toBe('red')

      expect((await scanAction(request, token, job.id, duplicate.scan.id, 'resolve', 'Scanned twice')).status()).toBe(200)
      const resolved = await jobOverviewOk(request, token, job.id)
      expect(resolved.counters).toMatchObject({ unresolvedDuplicates: 0, openExceptions: 0 })
      expect(resolved.severity).toBe('none')
      // The history stays: the exception is resolved, not deleted.
      expect((await listExceptions(request, token, job.id, 'status=resolved')).items.map((entry) => entry.type)).toEqual(['duplicate_serial'])
    } finally {
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

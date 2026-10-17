import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { advanceToReceiving, createSchedulableJob, uniqueSuffix } from './itad-job-fixtures'
import { csv, importManifestOk } from './itad-manifest-fixtures'
import { scanOk } from './itad-receiving-fixtures'
import { processingJobWithDataBearingAssets, recordResult, startRunOk } from './itad-sanitization-fixtures'
import { issueCertificateOk, passAsset } from './itad-certificate-fixtures'
import { aiToolOk } from './itad-ai-fixtures'

/**
 * TC-ITAD-803 (AI assistant spec AC-AI-11, AI-REQ-11, US "What happened to ABC123?"): a
 * serial in two jobs is ambiguous and lists both; an asset's history joins intake,
 * sanitization runs, exceptions and its certificate.
 */
test.describe('TC-ITAD-803: AI asset lookup and history', () => {
  test('ambiguous serial lists every match; history covers the device lifecycle', async ({ request }) => {
    test.setTimeout(120_000)
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    const tag = suffix.slice(-6).toUpperCase().replace(/[^A-Z0-9]/g, 'X')
    let companyId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA AI Assets ${suffix}`)
      const serial = `AIDUP${tag}`
      const jobIds: string[] = []
      for (const index of [1, 2]) {
        const job = await createSchedulableJob(request, token, companyId, `QA AI dup ${index} ${suffix}`)
        await importManifestOk(request, token, job.id, { name: `dup-${index}-${tag}.csv`, content: csv([['Serial', 'Carries data'], [serial, 'no']]) }, { serial: 'Serial', dataBearing: 'Carries data' })
        await advanceToReceiving(request, token, job.id)
        await scanOk(request, token, job.id, serial)
        jobIds.push(job.id)
      }
      const ambiguous = await aiToolOk(request, token, 'itad.find_asset', { q: serial })
      expect(ambiguous.status).toBe('ambiguous')
      expect(ambiguous.candidates.items.map((candidate: { jobId: string }) => candidate.jobId).sort()).toEqual([...jobIds].sort())
      expect((await aiToolOk(request, token, 'itad.find_asset', { q: `NOPE${tag}` })).status).toBe('none')

      const job = await createSchedulableJob(request, token, companyId, `QA AI history ${suffix}`)
      const [failed, passed] = await processingJobWithDataBearingAssets(request, token, job.id, 2)
      const run = await startRunOk(request, token, job.id, failed)
      await recordResult(request, token, job.id, run, { result: 'FAIL', verificationMethod: 'full_verification', verificationNotes: 'Readable sectors' })
      await passAsset(request, token, job.id, passed)
      await issueCertificateOk(request, token, job.id, passed.id)

      const unique = await aiToolOk(request, token, 'itad.find_asset', { q: failed.serial })
      expect(unique).toMatchObject({ status: 'unique', candidates: { items: [expect.objectContaining({ assetId: failed.id, status: 'review_required' })] } })

      const failedHistory = await aiToolOk(request, token, 'itad.get_asset_history', { jobId: job.id, assetId: failed.id })
      const failedEvents = failedHistory.timeline.items.map((entry: { event: string }) => entry.event)
      expect(failedEvents).toEqual(expect.arrayContaining(['received', 'sanitization_started', 'sanitization_failed', 'exception_opened']))
      expect(failedHistory.asset).toMatchObject({ serial: failed.serial, status: 'review_required' })

      const passedHistory = await aiToolOk(request, token, 'itad.get_asset_history', { jobId: job.id, assetId: passed.id })
      expect(passedHistory.timeline.items.map((entry: { event: string }) => entry.event)).toContain('sanitization_passed')
      expect(passedHistory.certificates).toMatchObject({ total: 1, items: [expect.objectContaining({ status: 'issued' })] })
    } finally {
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

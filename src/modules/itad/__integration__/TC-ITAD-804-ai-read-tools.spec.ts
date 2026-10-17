import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { advanceToReceiving, createSchedulableJob, transitionOk, uniqueSuffix } from './itad-job-fixtures'
import { csv, importManifestOk } from './itad-manifest-fixtures'
import { scanOk } from './itad-receiving-fixtures'
import { currentAssets, recordResult, startRunOk } from './itad-sanitization-fixtures'
import { passAsset } from './itad-certificate-fixtures'
import { aiToolOk } from './itad-ai-fixtures'

/**
 * TC-ITAD-804 (AI assistant spec AI-REQ-01, AI-REQ-05, AI-REQ-11): the remaining read
 * tools return live, structured job facts — job search, summary, reconciliation meaning,
 * sanitization picture, open exceptions, certificates — and the customer status is a draft
 * that is never sent. (List capping is covered by the composer unit tests.)
 */
test.describe('TC-ITAD-804: AI read tools', () => {
  test('job search, summaries, exceptions, certificates and the customer draft', async ({ request }) => {
    test.setTimeout(150_000)
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    const tag = suffix.slice(-6).toUpperCase().replace(/[^A-Z0-9]/g, 'X')
    let companyId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA AI Read ${suffix}`)

      // Processing job: awaiting, in progress, sanitized, failed (data-bearing) and one not data-bearing.
      const job = await createSchedulableJob(request, token, companyId, `QA AI read ${suffix}`)
      const serials = [1, 2, 3, 4].map((index) => `RD${index}${tag}`)
      const plain = `RDN${tag}`
      await importManifestOk(
        request,
        token,
        job.id,
        { name: `rd-${tag}.csv`, content: csv([['Serial', 'Carries data'], ...serials.map((serial) => [serial, 'yes']), [plain, 'no']]) },
        { serial: 'Serial', dataBearing: 'Carries data' },
      )
      await advanceToReceiving(request, token, job.id)
      for (const serial of [...serials, plain]) await scanOk(request, token, job.id, serial)
      await transitionOk(request, token, job.id, { action: 'start_processing' })
      const [, inProgress, sanitized, failed] = await currentAssets(request, token, job.id, serials)
      await startRunOk(request, token, job.id, inProgress)
      await passAsset(request, token, job.id, sanitized)
      const failedRun = await startRunOk(request, token, job.id, failed)
      await recordResult(request, token, job.id, failedRun, { result: 'FAIL', verificationMethod: 'full_verification', verificationNotes: 'Readable' })

      const reference = (await aiToolOk(request, token, 'itad.get_job_summary', { jobId: job.id })).reference
      const found = await aiToolOk(request, token, 'itad.find_jobs', { query: reference })
      expect(found).toMatchObject({ status: 'unique', candidates: { items: [expect.objectContaining({ jobId: job.id })] } })
      expect((await aiToolOk(request, token, 'itad.find_jobs', { query: `no such job ${tag}` })).status).toBe('none')

      const summary = await aiToolOk(request, token, 'itad.get_job_summary', { jobId: job.id })
      expect(summary).toMatchObject({ found: true, status: 'processing', counters: { totalIntake: 5, failed: 1, sanitized: 1 } })

      const sanitization = await aiToolOk(request, token, 'itad.get_sanitization_summary', { jobId: job.id })
      expect(sanitization).toMatchObject({ awaitingWipe: 1, inProgress: 1, sanitized: 1, failedNeedsReview: 1, notDataBearing: 1, undecided: 0 })

      const exceptions = await aiToolOk(request, token, 'itad.list_open_exceptions', { jobId: job.id, type: 'sanitization_failed', assignee: 'unassigned' })
      expect(exceptions.exceptions).toMatchObject({ total: 1, items: [expect.objectContaining({ type: 'sanitization_failed', serial: failed.serial })] })

      const certificates = await aiToolOk(request, token, 'itad.find_certificate', { jobId: job.id })
      expect(certificates).toMatchObject({ found: true, scope: 'job', missing: { total: 1 } })
      expect(certificates.missing.items[0].serial).toBe(sanitized.serial)

      const draft = await aiToolOk(request, token, 'itad.generate_customer_status_summary', { jobId: job.id })
      expect(draft).toMatchObject({ found: true, sent: false })
      expect(draft.draft).toContain(reference)

      // Receiving job: missing devices are progress; undecided devices are counted.
      const receiving = await createSchedulableJob(request, token, companyId, `QA AI receiving ${suffix}`)
      const receivingSerials = [1, 2, 3].map((index) => `RV${index}${tag}`)
      await importManifestOk(request, token, receiving.id, { name: `rv-${tag}.csv`, content: csv([['Serial'], ...receivingSerials.map((serial) => [serial])]) }, { serial: 'Serial' })
      await advanceToReceiving(request, token, receiving.id)
      await scanOk(request, token, receiving.id, receivingSerials[0])
      const reconciliation = await aiToolOk(request, token, 'itad.get_reconciliation_summary', { jobId: receiving.id })
      expect(reconciliation).toMatchObject({ expected: 3, received: 1, missing: 2, meaning: { missingIsReceivingProgress: true, attentionFromOpenExceptionsOnly: false } })
      expect((await aiToolOk(request, token, 'itad.get_sanitization_summary', { jobId: receiving.id })).undecided).toBe(1)
    } finally {
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

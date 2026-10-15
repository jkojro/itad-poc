import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { advanceToReceiving, createSchedulableJob, transitionOk, uniqueSuffix } from './itad-job-fixtures'
import { csv, importManifestOk } from './itad-manifest-fixtures'
import { classifyUndecided, scanOk } from './itad-receiving-fixtures'
import { processingJobWithDataBearingAssets, recordResult, startRunOk } from './itad-sanitization-fixtures'
import { errorBody, issueCertificate, issueCertificateOk, passAsset } from './itad-certificate-fixtures'

/**
 * TC-ITAD-502 (certificates spec "Eligibility", REQ-601, REQ-605, REQ-621): a certificate
 * is refused with a precise reason before sanitization, after a FAIL, twice for the same
 * asset, with an invalid language, on a cancelled job, for a device that carries no data
 * and for one whose classification is not yet determined.
 */
test.describe('TC-ITAD-502: certificate eligibility', () => {
  test('refusals carry a code and detail; nothing is issued', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    let companyId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD Cert Elig ${suffix}`)
      const job = await createSchedulableJob(request, token, companyId, `QA cert elig ${suffix}`)
      const [waiting, failed, passed] = await processingJobWithDataBearingAssets(request, token, job.id, 3)

      const notSanitized = await issueCertificate(request, token, job.id, waiting.id)
      expect(notSanitized.status()).toBe(409)
      expect(await errorBody(notSanitized)).toMatchObject({ code: 'itad.certificates.errors.certificate_not_eligible', detail: 'not_sanitized' })

      const failRun = await startRunOk(request, token, job.id, failed)
      expect((await recordResult(request, token, job.id, failRun, { result: 'FAIL', verificationMethod: 'none', verificationNotes: 'Locked drive' })).status()).toBe(200)
      const afterFail = await issueCertificate(request, token, job.id, failed.id)
      expect(await errorBody(afterFail)).toMatchObject({ detail: 'not_sanitized' })

      await passAsset(request, token, job.id, passed)
      const badLocale = await issueCertificate(request, token, job.id, passed.id, 'de')
      expect(badLocale.status()).toBe(400)
      expect(await errorBody(badLocale)).toMatchObject({ code: 'itad.certificates.errors.locale_invalid' })

      await issueCertificateOk(request, token, job.id, passed.id, 'pl')
      const twice = await issueCertificate(request, token, job.id, passed.id)
      expect(twice.status()).toBe(409)
      expect(await errorBody(twice)).toMatchObject({ code: 'itad.certificates.errors.certificate_already_issued' })

      await transitionOk(request, token, job.id, { action: 'cancel', reason: 'customer withdrew' })
      const cancelled = await issueCertificate(request, token, job.id, failed.id)
      expect(await errorBody(cancelled)).toMatchObject({ detail: 'job_status' })
    } finally {
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })

  test('a device without data or with an undetermined classification gets none', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    const tag = suffix.slice(-6).toUpperCase().replace(/[^A-Z0-9]/g, 'X')
    let companyId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD Cert NoData ${suffix}`)
      const job = await createSchedulableJob(request, token, companyId, `QA cert no data ${suffix}`)
      await importManifestOk(
        request,
        token,
        job.id,
        { name: `nd-${tag}.csv`, content: csv([['Serial', 'Carries data'], [`ND${tag}`, 'no'], [`UK${tag}`, '']]) },
        { serial: 'Serial', dataBearing: 'Carries data' },
      )
      await advanceToReceiving(request, token, job.id)
      const noData = (await scanOk(request, token, job.id, `ND${tag}`)).asset
      const unknown = (await scanOk(request, token, job.id, `UK${tag}`)).asset
      expect(unknown).toMatchObject({ dataBearing: null })

      // An undetermined device blocks processing, so the job status is the first reason.
      const undetermined = await issueCertificate(request, token, job.id, unknown.id)
      expect(undetermined.status()).toBe(409)
      expect(await errorBody(undetermined)).toMatchObject({ code: 'itad.certificates.errors.certificate_not_eligible', detail: 'job_status' })

      await classifyUndecided(request, token, job.id, false)
      await transitionOk(request, token, job.id, { action: 'start_processing' })
      for (const asset of [noData, unknown]) {
        const refused = await issueCertificate(request, token, job.id, asset.id)
        expect(refused.status()).toBe(409)
        expect(await errorBody(refused)).toMatchObject({ code: 'itad.certificates.errors.certificate_not_eligible', detail: 'not_data_bearing' })
      }
    } finally {
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { advanceToReceiving, createSchedulableJob, transitionOk, uniqueSuffix } from './itad-job-fixtures'
import { csv, importManifestOk } from './itad-manifest-fixtures'
import { scanOk } from './itad-receiving-fixtures'
import { currentAssets } from './itad-sanitization-fixtures'
import { errorBody, issueCertificateOk, issueMissing, issueMissingOk, jobCertificatesOk, passAsset } from './itad-certificate-fixtures'

/**
 * TC-ITAD-510 (certificates spec "Required certificates", REQ-610, REQ-613, Q6): a mixed
 * job counts data-bearing, sanitized, required, issued and missing; a device that carries
 * no data needs none; "Issue all missing" issues one certificate per missing device, and
 * a second run has nothing left to do.
 */
test.describe('TC-ITAD-510: job documents and "Issue all missing"', () => {
  test('counts, missing devices and bulk issue on a mixed job', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const employeeToken = await getAuthToken(request, 'employee')
    const suffix = uniqueSuffix()
    const tag = suffix.slice(-6).toUpperCase().replace(/[^A-Z0-9]/g, 'X')
    let companyId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA Cert Documents ${suffix}`)
      const job = await createSchedulableJob(request, token, companyId, `QA cert documents ${suffix}`)
      const dataSerials = [`DA${tag}`, `DB${tag}`, `DC${tag}`]
      const noData = `ND${tag}`
      await importManifestOk(
        request,
        token,
        job.id,
        { name: `docs-${tag}.csv`, content: csv([['Serial', 'Carries data'], ...dataSerials.map((serial) => [serial, 'yes']), [noData, 'no']]) },
        { serial: 'Serial', dataBearing: 'Carries data' },
      )
      await advanceToReceiving(request, token, job.id)
      for (const serial of [...dataSerials, noData]) await scanOk(request, token, job.id, serial)
      await transitionOk(request, token, job.id, { action: 'start_processing' })
      const assets = await currentAssets(request, token, job.id, dataSerials)

      // Nothing sanitized yet: nothing is required.
      const before = await jobCertificatesOk(request, token, job.id)
      expect(before.counts).toEqual({ dataBearing: 3, sanitized: 0, required: 0, issued: 0, missing: 0 })

      for (const asset of assets) await passAsset(request, token, job.id, asset)
      const first = await issueCertificateOk(request, token, job.id, assets[0].id)

      const mixed = await jobCertificatesOk(request, token, job.id)
      expect(mixed.counts).toEqual({ dataBearing: 3, sanitized: 3, required: 3, issued: 1, missing: 2 })
      expect(mixed.missingAssets.map((asset) => asset.serial)).toEqual([dataSerials[1], dataSerials[2]])
      expect(mixed.items.map((item) => item.id)).toEqual([first.id])
      expect(mixed.issue).toEqual({ allowed: true })

      // Viewing is not issuing.
      expect((await issueMissing(request, employeeToken, job.id)).status()).toBe(403)
      const badLocale = await issueMissing(request, token, job.id, 'de')
      expect(badLocale.status()).toBe(400)
      expect(await errorBody(badLocale)).toMatchObject({ code: 'itad.certificates.errors.locale_invalid' })

      const bulk = await issueMissingOk(request, token, job.id, 'pl')
      expect(bulk.failed).toEqual([])
      expect(bulk.issued.map((entry) => entry.serial)).toEqual([dataSerials[1], dataSerials[2]])
      expect(new Set(bulk.issued.map((entry) => entry.certificateNumber)).size).toBe(2)

      const after = await jobCertificatesOk(request, token, job.id)
      expect(after.counts).toEqual({ dataBearing: 3, sanitized: 3, required: 3, issued: 3, missing: 0 })
      expect(after.missingAssets).toEqual([])
      expect(after.items).toHaveLength(3)
      expect((await jobCertificatesOk(request, token, job.id, 'status=void')).items).toEqual([])
      expect((await jobCertificatesOk(request, token, job.id, 'status=issued')).items).toHaveLength(3)

      expect(await issueMissingOk(request, token, job.id)).toEqual({ issued: [], failed: [] })
    } finally {
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

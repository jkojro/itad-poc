import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { CONFIRM, createSchedulableJob, postTransition, transitionOk, uniqueSuffix } from './itad-job-fixtures'
import { bulkResult, bulkStart, processingJobWithDataBearingAssets } from './itad-sanitization-fixtures'
import { issueCertificateOk } from './itad-certificate-fixtures'

type TransitionsBody = {
  actions: Array<{ id: string; allowed: boolean; conditions: Array<{ key: string; state: string; manualAllowed: boolean; detailParams: Record<string, number> | null }> }>
}

/**
 * TC-ITAD-511 (certificates spec REQ-611, REQ-612, AC-603): `complete` is blocked while
 * one of ten sanitized devices has no certificate, the condition names how many are
 * missing, a manual confirmation is rejected, and the tenth certificate unblocks it.
 */
test.describe('TC-ITAD-511: closeout requires every certificate', () => {
  test('9 of 10 blocks complete; 10 of 10 completes', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    let companyId: string | null = null
    let jobId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA Cert Closeout ${suffix}`)
      jobId = (await createSchedulableJob(request, token, companyId, `QA cert closeout ${suffix}`)).id
      const assets = await processingJobWithDataBearingAssets(request, token, jobId, 10)
      const ids = assets.map((asset) => asset.id)
      expect((await bulkStart(request, token, jobId, ids)).status()).toBe(201)
      expect((await bulkResult(request, token, jobId, ids, { result: 'PASS', verificationMethod: 'sample_verification' })).status()).toBe(200)
      expect(await transitionOk(request, token, jobId, { action: 'start_closeout', confirmations: [CONFIRM('allAssetsProcessed')] })).toBe('closeout_review')
      for (const asset of assets.slice(0, 9)) await issueCertificateOk(request, token, jobId, asset.id)

      const transitions = (await readJsonSafe<TransitionsBody>(await apiRequest(request, 'GET', `/api/itad/jobs/${jobId}/transitions`, { token })))!
      const complete = transitions.actions.find((action) => action.id === 'complete')!
      expect(complete.allowed).toBe(false)
      expect(complete.conditions.find((condition) => condition.key === 'requiredDocumentsComplete')).toMatchObject({
        state: 'unmet',
        manualAllowed: false,
        detailParams: { count: 1 },
      })

      const blocked = await postTransition(request, token, jobId, { action: 'complete' })
      expect(blocked.status()).toBe(400)
      expect(await readJsonSafe(blocked)).toMatchObject({ code: 'itad.jobs.errors.condition_unmet', conditions: ['requiredDocumentsComplete'] })
      const manual = await postTransition(request, token, jobId, { action: 'complete', confirmations: [CONFIRM('requiredDocumentsComplete')] })
      expect(manual.status()).toBe(400)
      expect(await readJsonSafe(manual)).toMatchObject({ code: 'itad.jobs.errors.confirmation_not_allowed', condition: 'requiredDocumentsComplete' })

      await issueCertificateOk(request, token, jobId, assets[9].id)
      expect(await transitionOk(request, token, jobId, { action: 'complete' })).toBe('completed')
      jobId = null
    } finally {
      if (jobId) await postTransition(request, token, jobId, { action: 'cancel', reason: 'QA cleanup' }).catch(() => undefined)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

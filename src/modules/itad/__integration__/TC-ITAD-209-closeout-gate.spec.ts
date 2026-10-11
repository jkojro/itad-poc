import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { CONFIRM, createSchedulableJob, getJob, postTransition, transitionOk, uniqueSuffix } from './itad-job-fixtures'
import { bulkResult, bulkStart, processingJobWithDataBearingAssets } from './itad-sanitization-fixtures'

type ConditionView = { key: string; state: string; detailKey: string | null }

/**
 * TC-ITAD-209 (sanitization spec TEST-309): `start_closeout` is refused with
 * `sanitizationPending` while a data-bearing device is not sanitized — also with a
 * manual confirmation; the jobs list counts pending devices; once all are sanitized the
 * manual confirmation is accepted.
 */
test.describe('TC-ITAD-209: closeout gate for unsanitized devices', () => {
  test('pending blocks closeout until everything is sanitized', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    let companyId: string | null = null
    let jobId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD Closeout ${suffix}`)
      jobId = (await createSchedulableJob(request, token, companyId, `QA closeout ${suffix}`)).id
      const assets = await processingJobWithDataBearingAssets(request, token, jobId, 2)
      const ids = assets.map((asset) => asset.id)
      const view = async () => {
        const response = await postTransition(request, token, jobId!, { action: 'start_closeout' })
        return readJsonSafe<{ code?: string; conditions?: string[] }>(response)
      }
      const conditionView = async (): Promise<ConditionView | undefined> => {
        const response = await request.fetch(`${process.env.BASE_URL ?? ''}/api/itad/jobs/${jobId}/transitions`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        const body = await readJsonSafe<{ actions: Array<{ id: string; conditions: ConditionView[] }> }>(response)
        return body?.actions.find((action) => action.id === 'start_closeout')?.conditions.find((entry) => entry.key === 'allAssetsProcessed')
      }

      expect(((await getJob(request, token, jobId)) as unknown as { sanitizationPendingCount: number }).sanitizationPendingCount).toBe(2)
      expect(await conditionView()).toMatchObject({ state: 'unmet', detailKey: 'itad.jobs.conditions.detail.sanitizationPending' })
      expect(await view()).toMatchObject({ code: 'itad.jobs.errors.condition_unmet', conditions: ['allAssetsProcessed'] })
      const confirmed = await postTransition(request, token, jobId, { action: 'start_closeout', confirmations: [CONFIRM('allAssetsProcessed')] })
      expect(confirmed.status()).toBe(400)
      expect(await readJsonSafe(confirmed)).toMatchObject({ code: 'itad.jobs.errors.condition_unmet', conditions: ['allAssetsProcessed'] })

      expect((await bulkStart(request, token, jobId, ids)).status()).toBe(201)
      expect((await bulkResult(request, token, jobId, [ids[0]], { result: 'PASS', verificationMethod: 'full_verification' })).status()).toBe(200)
      expect(((await getJob(request, token, jobId)) as unknown as { sanitizationPendingCount: number }).sanitizationPendingCount).toBe(1)
      expect((await postTransition(request, token, jobId, { action: 'start_closeout', confirmations: [CONFIRM('allAssetsProcessed')] })).status()).toBe(400)

      expect((await bulkResult(request, token, jobId, [ids[1]], { result: 'PASS', verificationMethod: 'full_verification' })).status()).toBe(200)
      expect(await conditionView()).toMatchObject({ state: 'confirmation_required' })
      expect(await transitionOk(request, token, jobId, { action: 'start_closeout', confirmations: [CONFIRM('allAssetsProcessed')] })).toBe('closeout_review')
      expect(((await getJob(request, token, jobId)) as unknown as { sanitizationPendingCount: number }).sanitizationPendingCount).toBe(0)
    } finally {
      if (jobId) await postTransition(request, token, jobId, { action: 'cancel', reason: 'QA cleanup' }).catch(() => undefined)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

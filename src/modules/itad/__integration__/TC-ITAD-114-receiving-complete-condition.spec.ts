import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { CONFIRM, advanceToReceiving, createSchedulableJob, postTransition, transitionOk, uniqueSuffix } from './itad-job-fixtures'
import { csv, importManifestOk } from './itad-manifest-fixtures'
import { getReconciliation, receivingCompleteView, scanAction, scanOk } from './itad-receiving-fixtures'

async function startProcessingRejection(response: { status: () => number; json: () => Promise<unknown> }) {
  const body = (await response.json()) as { code?: string; conditions?: string[]; condition?: string }
  return { status: response.status(), code: body.code, conditions: body.conditions, condition: body.condition }
}

/**
 * TC-ITAD-114 (spec TEST-113): `receivingComplete` blocks `start_processing` without a
 * manifest, with a pending duplicate and with a duplicate flagged as a different device
 * (each with its detail), never accepts a manual confirmation, and is met once the
 * duplicate is resolved as the same device.
 */
test.describe('TC-ITAD-114: receivingComplete from data', () => {
  test('manifest missing, duplicates pending, different device, manual confirmation refused', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    const tag = suffix.slice(-6).toUpperCase()
    let companyId: string | null = null
    let jobId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD Condition ${suffix}`)
      jobId = (await createSchedulableJob(request, token, companyId, `QA condition ${suffix}`)).id
      await advanceToReceiving(request, token, jobId)

      expect(await receivingCompleteView(request, token, jobId)).toMatchObject({
        state: 'unmet',
        detailKey: 'itad.jobs.conditions.detail.manifestMissing',
        canConfirm: false,
      })
      expect(await startProcessingRejection(await postTransition(request, token, jobId, { action: 'start_processing' }))).toEqual({
        status: 400,
        code: 'itad.jobs.errors.condition_unmet',
        conditions: ['receivingComplete'],
        condition: undefined,
      })

      await importManifestOk(request, token, jobId, { name: `c-${tag}.csv`, content: csv([['Serial'], [`C1-${tag}`], [`C2-${tag}`]]) }, { serial: 'Serial' })
      await scanOk(request, token, jobId, `C1-${tag}`)
      const duplicate = await scanOk(request, token, jobId, `C1-${tag}`)
      expect((await receivingCompleteView(request, token, jobId))?.detailKey).toBe('itad.jobs.conditions.detail.duplicatesPending')
      expect((await getReconciliation(request, token, jobId)).pendingDuplicates).toBe(1)

      expect((await scanAction(request, token, jobId, duplicate.scan.id, 'flag-different-device', 'Second unit on the dock')).status()).toBe(200)
      expect((await receivingCompleteView(request, token, jobId))?.detailKey).toBe('itad.jobs.conditions.detail.differentDeviceUnresolved')
      expect(await getReconciliation(request, token, jobId)).toMatchObject({ pendingDuplicates: 0, differentDeviceUnresolved: 1 })
      const blocked = await postTransition(request, token, jobId, { action: 'start_processing' })
      expect((await readJsonSafe<{ conditions?: string[] }>(blocked))?.conditions).toEqual(['receivingComplete'])

      const manual = await postTransition(request, token, jobId, { action: 'start_processing', confirmations: [CONFIRM('receivingComplete')] })
      expect(await startProcessingRejection(manual)).toMatchObject({
        status: 400,
        code: 'itad.jobs.errors.confirmation_not_allowed',
        condition: 'receivingComplete',
      })

      // Correcting the mistaken flag closes the duplicate; missing C2 does not block.
      expect((await scanAction(request, token, jobId, duplicate.scan.id, 'resolve', 'Same unit after all')).status()).toBe(200)
      expect(await receivingCompleteView(request, token, jobId)).toMatchObject({ state: 'met' })
      expect(await getReconciliation(request, token, jobId)).toMatchObject({ matched: 1, missing: 1, unexpected: 0 })
      expect(await transitionOk(request, token, jobId, { action: 'start_processing' })).toBe('processing')
    } finally {
      if (jobId) await postTransition(request, token, jobId, { action: 'cancel', reason: 'QA cleanup' }).catch(() => undefined)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

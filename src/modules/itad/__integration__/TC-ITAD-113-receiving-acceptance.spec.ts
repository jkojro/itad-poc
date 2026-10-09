import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { advanceToReceiving, createSchedulableJob, getJob, postTransition, transitionOk, uniqueSuffix } from './itad-job-fixtures'
import { csv, importManifestOk, listManifestItems } from './itad-manifest-fixtures'
import { getReconciliation, listAssets, receivingCompleteView, scanOk } from './itad-receiving-fixtures'

/**
 * TC-ITAD-113 — Epic 2 E2E acceptance (spec TEST-112): a manifest of 10 devices
 * ABC001…ABC010; ABC001…ABC009 and an extra XYZ999 are scanned. Result: 9 matched,
 * ABC010 missing, XYZ999 unexpected, `receivingComplete` met from data, and
 * `start_processing` succeeds without any manual confirmation.
 */
test.describe('TC-ITAD-113: Epic 2 acceptance — manifest, receiving, reconciliation', () => {
  test('9 matched, ABC010 missing, XYZ999 unexpected, receiving completes from data', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    let companyId: string | null = null
    let jobId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD Acceptance ${suffix}`)
      jobId = (await createSchedulableJob(request, token, companyId, `QA acceptance ${suffix}`)).id
      const serials = Array.from({ length: 10 }, (_, index) => `ABC${String(index + 1).padStart(3, '0')}`)
      await importManifestOk(
        request,
        token,
        jobId,
        { name: `acceptance-${suffix}.csv`, content: csv([['Serial Number', 'Model'], ...serials.map((serial) => [serial, 'Latitude 5420'])]) },
        { serial: 'Serial Number', model: 'Model' },
      )
      await advanceToReceiving(request, token, jobId)

      for (const serial of serials.slice(0, 9)) expect((await scanOk(request, token, jobId, serial)).result).toBe('MATCHED')
      expect((await scanOk(request, token, jobId, 'XYZ999')).result).toBe('UNEXPECTED')

      expect(await getReconciliation(request, token, jobId)).toEqual({
        expectedAssetCount: 10,
        receivedAssetCount: 10,
        matched: 9,
        missing: 1,
        unexpected: 1,
        pendingDuplicates: 0,
        differentDeviceUnresolved: 0,
        hasManifest: true,
      })
      expect((await listManifestItems(request, token, jobId, 'reconciliation=missing')).items.map((item) => item.serial)).toEqual(['ABC010'])
      expect((await listManifestItems(request, token, jobId, 'reconciliation=matched')).total).toBe(9)
      expect((await listAssets(request, token, jobId, 'reconciliation=unexpected')).items.map((asset) => asset.serial)).toEqual(['XYZ999'])
      expect((await listAssets(request, token, jobId, 'reconciliation=matched')).total).toBe(9)

      expect(await receivingCompleteView(request, token, jobId)).toMatchObject({ key: 'receivingComplete', state: 'met', canConfirm: false })
      expect(await transitionOk(request, token, jobId, { action: 'start_processing' })).toBe('processing')

      const job = await getJob(request, token, jobId)
      expect(job as unknown as { expectedAssetCount: number; receivedAssetCount: number }).toMatchObject({ expectedAssetCount: 10, receivedAssetCount: 10 })
      const history = await apiRequest(request, 'GET', `/api/itad/jobs/${jobId}/history`, { token })
      const items = (await readJsonSafe<{ items: Array<{ action: string; confirmations: unknown[] }> }>(history))?.items ?? []
      expect(items[0]).toMatchObject({ action: 'start_processing', confirmations: [] })
    } finally {
      if (jobId) await postTransition(request, token, jobId, { action: 'cancel', reason: 'QA cleanup' }).catch(() => undefined)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

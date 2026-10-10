import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { advanceToReceiving, createSchedulableJob, postTransition, transitionOk, uniqueSuffix } from './itad-job-fixtures'
import { csv, importManifestOk } from './itad-manifest-fixtures'
import {
  classifyAssets,
  deleteAsset,
  getReconciliation,
  listAssets,
  receivingCompleteView,
  scanOk,
  updateAsset,
} from './itad-receiving-fixtures'

/**
 * TC-ITAD-202 (sanitization spec TEST-305, receiving part): undecided devices block
 * receiving (`dataBearingUndecided`) until classified; bulk classification is
 * all-or-nothing; a decided value cannot go back to undetermined; classification is
 * refused once the job left receiving (Phase 1).
 */
test.describe('TC-ITAD-202: bulk classification and the receiving gate', () => {
  test('classify undecided devices, then start processing', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const employeeToken = await getAuthToken(request, 'employee')
    const suffix = uniqueSuffix()
    const tag = suffix.slice(-6).toUpperCase()
    let companyId: string | null = null
    let jobId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD Classify ${suffix}`)
      jobId = (await createSchedulableJob(request, token, companyId, `QA classify ${suffix}`)).id
      const serials = [`K1${tag}`, `K2${tag}`, `K3${tag}`, `K4${tag}`]
      await importManifestOk(request, token, jobId, { name: `k-${tag}.csv`, content: csv([['Serial'], ...serials.map((s) => [s])]) }, { serial: 'Serial' })
      await advanceToReceiving(request, token, jobId)
      const assets = []
      for (const serial of serials) assets.push((await scanOk(request, token, jobId, serial)).asset)

      expect((await getReconciliation(request, token, jobId)).dataBearingUndecided).toBe(4)
      expect((await receivingCompleteView(request, token, jobId))?.detailKey).toBe('itad.jobs.conditions.detail.dataBearingUndecided')
      const blocked = await postTransition(request, token, jobId, { action: 'start_processing' })
      expect((await readJsonSafe<{ conditions?: string[] }>(blocked))?.conditions).toEqual(['receivingComplete'])

      // All-or-nothing: a removed asset in the selection changes nothing.
      const removed = assets[3]
      const removedRow = (await listAssets(request, token, jobId, `id=${removed.id}`)).items[0]
      expect((await deleteAsset(request, token, jobId, removed.id, 'Scanned by mistake', removedRow.updatedAt)).status()).toBe(200)
      const partial = await classifyAssets(request, token, jobId, [assets[0].id, removed.id], true)
      expect(partial.status()).toBe(409)
      expect(await readJsonSafe(partial)).toMatchObject({ code: 'itad.assets.errors.assets_not_found', assetIds: [removed.id] })
      expect((await listAssets(request, token, jobId, `id=${assets[0].id}`)).items[0]).toMatchObject({ dataBearing: null, status: 'received' })

      // The receiving role may classify (employee has itad.assets.receive).
      const yes = await classifyAssets(request, employeeToken, jobId, [assets[0].id, assets[1].id], true)
      expect(yes.status(), JSON.stringify(await readJsonSafe(yes))).toBe(200)
      expect(await readJsonSafe(yes)).toMatchObject({ dataBearing: true, unchangedAssetIds: [] })
      for (const id of [assets[0].id, assets[1].id]) {
        expect((await listAssets(request, token, jobId, `id=${id}`)).items[0]).toMatchObject({
          dataBearing: true,
          dataBearingSource: 'bulk',
          status: 'sanitization_required',
        })
      }
      expect((await receivingCompleteView(request, token, jobId))?.detailKey).toBe('itad.jobs.conditions.detail.dataBearingUndecided')

      // Correction during receiving: true → false returns the device to the normal path; repeating is a no-op.
      const no = await classifyAssets(request, token, jobId, [assets[1].id, assets[2].id], false)
      expect(no.status()).toBe(200)
      expect(((await readJsonSafe<{ changedAssetIds: string[] }>(no))?.changedAssetIds ?? []).sort()).toEqual([assets[1].id, assets[2].id].sort())
      expect((await listAssets(request, token, jobId, `id=${assets[1].id}`)).items[0]).toMatchObject({ dataBearing: false, status: 'received' })
      const again = await classifyAssets(request, token, jobId, [assets[2].id], false)
      expect(await readJsonSafe(again)).toMatchObject({ changedAssetIds: [], unchangedAssetIds: [assets[2].id] })

      // A decided value cannot be set back to undetermined through the asset edit.
      const row = (await listAssets(request, token, jobId, `id=${assets[2].id}`)).items[0]
      const unset = await updateAsset(request, token, jobId, row.id, { dataBearing: null }, row.updatedAt)
      expect(unset.status()).toBe(400)
      expect((await readJsonSafe<{ code?: string }>(unset))?.code).toBe('itad.assets.errors.data_bearing_cannot_be_unset')

      expect((await getReconciliation(request, token, jobId)).dataBearingUndecided).toBe(0)
      expect(await receivingCompleteView(request, token, jobId)).toMatchObject({ state: 'met' })
      expect(await transitionOk(request, token, jobId, { action: 'start_processing' })).toBe('processing')

      // Phase 1: classification after receiving is refused (manager rules arrive with Phase 2).
      const late = await classifyAssets(request, token, jobId, [assets[2].id], true, 'Found an SSD')
      expect(late.status()).toBe(409)
      expect((await readJsonSafe<{ code?: string }>(late))?.code).toBe('itad.assets.errors.assets_locked')
    } finally {
      if (jobId) await postTransition(request, token, jobId, { action: 'cancel', reason: 'QA cleanup' }).catch(() => undefined)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import {
  advanceToReceiving,
  createSchedulableJob,
  deleteJobIfExists,
  errorCode,
  getJob,
  transitionOk,
  uniqueSuffix,
} from './itad-job-fixtures'
import { csv, importManifestOk } from './itad-manifest-fixtures'
import { listAssets, listScans, postScan, scanOk } from './itad-receiving-fixtures'

/**
 * TC-ITAD-108 (spec TEST-109): during receiving, the first scan of a serial creates an
 * asset — MATCHED (details copied from the manifest item, serial normalized) or
 * UNEXPECTED — and a repeated serial is a DUPLICATE that creates no asset. Invalid
 * serials are rejected; scanning outside `receiving` (before it, or on hold) is refused.
 */
test.describe('TC-ITAD-108: receiving scans', () => {
  test('matched, unexpected, duplicate and status gate', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    const tag = suffix.slice(-6).toUpperCase()
    let companyId: string | null = null
    let jobId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD Scans ${suffix}`)
      jobId = (await createSchedulableJob(request, token, companyId, `QA scans ${suffix}`)).id
      await importManifestOk(
        request,
        token,
        jobId,
        { name: `m-${tag}.csv`, content: csv([['Serial', 'Tag', 'Make', 'Model'], [`ABC${tag}1`, `T-${tag}`, 'Dell', 'Latitude 5420'], [`ABC${tag}2`, '', 'HP', 'EliteBook']]) },
        { serial: 'Serial', customerAssetTag: 'Tag', manufacturer: 'Make', model: 'Model' },
      )

      const early = await postScan(request, token, jobId, `ABC${tag}1`)
      expect(early.status()).toBe(409)
      expect(await errorCode(early)).toBe('itad.assets.errors.receiving_not_active')

      await advanceToReceiving(request, token, jobId)

      // Serial normalization: spaces and case do not matter.
      const matched = await scanOk(request, token, jobId, ` abc ${tag.toLowerCase()}1 `)
      expect(matched).toMatchObject({
        result: 'MATCHED',
        asset: { customerAssetTag: `T-${tag}`, manufacturer: 'Dell', model: 'Latitude 5420' },
        manifestItem: { serial: `ABC${tag}1` },
      })
      const unexpected = await scanOk(request, token, jobId, `XYZ${tag}9`)
      expect(unexpected).toMatchObject({ result: 'UNEXPECTED', manifestItem: null, asset: { manufacturer: null } })
      const duplicate = await scanOk(request, token, jobId, `ABC${tag}1`)
      expect(duplicate.result).toBe('DUPLICATE')
      expect(duplicate.asset.id).toBe(matched.asset.id)

      const assets = await listAssets(request, token, jobId)
      expect(assets.total).toBe(2)
      expect(assets.items.find((asset) => asset.id === matched.asset.id)?.manifestItemId).toBe(matched.manifestItem!.id)
      expect(assets.items.find((asset) => asset.id === unexpected.asset.id)?.manifestItemId).toBeNull()
      expect((await listAssets(request, token, jobId, `search=${encodeURIComponent(`xyz ${tag.toLowerCase()}`)}`)).total).toBe(1)

      const scans = await listScans(request, token, jobId)
      expect(scans.items.map((scan) => scan.result)).toEqual(['duplicate', 'unexpected', 'matched'])
      const pending = await listScans(request, token, jobId, 'pending=true')
      expect(pending.items.map((scan) => scan.id)).toEqual([duplicate.scan.id])
      expect((await getJob(request, token, jobId) as unknown as { receivedAssetCount: number }).receivedAssetCount).toBe(2)

      const blank = await postScan(request, token, jobId, '   ')
      expect(blank.status()).toBe(400)
      expect(await errorCode(blank)).toBe('itad.assets.errors.serial_missing')
      const tooLong = await postScan(request, token, jobId, 'A'.repeat(101))
      expect(await errorCode(tooLong)).toBe('itad.assets.errors.serial_too_long')

      await transitionOk(request, token, jobId, { action: 'hold', reason: 'QA pause' })
      const held = await postScan(request, token, jobId, `ABC${tag}2`)
      expect(held.status()).toBe(409)
      expect((await listScans(request, token, jobId)).total).toBe(3)
    } finally {
      await deleteJobIfExists(request, token, jobId)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { uniqueSuffix } from './itad-job-fixtures'
import { deleteAsset } from './itad-receiving-fixtures'
import { globalAssetSearch, receivedJobWithDevices } from './itad-search-fixtures'

/**
 * TC-ITAD-607 (operations dashboard spec REQ-722, "Global search"): a scanned asset is
 * found by the platform's header search by serial and by tag, with serial, tag, model,
 * customer and job but no status, and links to its detail page; a removed asset is no
 * longer found.
 */
test.describe('TC-ITAD-607: ITAD assets in the global search', () => {
  test('indexed on scan, found by serial and tag, removed on delete', async ({ request }) => {
    test.setTimeout(90_000)
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    const tag = suffix.slice(-6).toUpperCase().replace(/[^A-Z0-9]/g, 'X')
    let companyId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA Global Search ${suffix}`)
      const serial = `GLB${tag}`
      const assetTag = `GT-${tag}`
      const { job, assets } = await receivedJobWithDevices(request, token, companyId, `QA global ${suffix}`, [
        { serial, tag: assetTag, make: 'HP', model: 'EliteBook 840' },
      ])
      const asset = assets[0]
      const findIn = async (q: string) => (await globalAssetSearch(request, token, q)).find((result) => result.recordId === asset.id)

      await expect.poll(async () => Boolean(await findIn(serial)), { timeout: 30_000 }).toBe(true)
      const hit = (await findIn(serial))!
      expect(hit.presenter?.title).toBe(serial)
      for (const part of [assetTag, 'HP EliteBook 840', `QA Global Search ${suffix}`, job.internalReference]) {
        expect(hit.presenter?.subtitle ?? '').toContain(part)
      }
      expect(JSON.stringify(hit.presenter)).not.toMatch(/received|sanitiz/i)
      expect(hit.url).toBe(`/backend/itad/jobs/${job.id}/assets/${asset.id}`)
      expect(hit.links?.map((link) => link.label)).toContain('Open asset')

      await expect.poll(async () => Boolean(await findIn(assetTag)), { timeout: 30_000 }).toBe(true)

      const removed = await deleteAsset(request, token, job.id, asset.id, 'Scanned into the wrong job')
      expect(removed.status(), await removed.text()).toBe(200)
      await expect.poll(async () => Boolean(await findIn(serial)), { timeout: 30_000 }).toBe(false)
    } finally {
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

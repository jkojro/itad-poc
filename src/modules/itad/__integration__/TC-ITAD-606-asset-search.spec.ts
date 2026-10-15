import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createOrganizationFixture, deleteOrganizationIfExists } from '@open-mercato/core/helpers/integration/authFixtures'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { getTokenContext } from '@open-mercato/core/helpers/integration/generalFixtures'
import { uniqueSuffix } from './itad-job-fixtures'
import { receivedJobWithDevices, searchAssets, searchAssetsOk } from './itad-search-fixtures'

/**
 * TC-ITAD-606 (operations dashboard spec AC-704, AC-705, AC-706, REQ-713 … REQ-717): the
 * asset search finds a device by serial or customer asset tag with its customer, job,
 * model and live status; the same tag in two jobs returns both; no match is a 200 with
 * an empty list; another organization finds nothing.
 */
test.describe('TC-ITAD-606: asset search by serial or tag', () => {
  test('serial, tag, duplicates, no result, scope', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const { tenantId } = getTokenContext(token)
    const suffix = uniqueSuffix()
    const tag = suffix.slice(-6).toUpperCase().replace(/[^A-Z0-9]/g, 'X')
    let companyId: string | null = null
    let orgBId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA Asset Search ${suffix}`)
      const assetTag = `FIN-${tag}`
      const first = await receivedJobWithDevices(request, token, companyId, `Laptop refresh ${suffix}`, [
        { serial: `ABC${tag}`, tag: assetTag, make: 'Dell', model: 'Latitude 5440' },
      ])
      const second = await receivedJobWithDevices(request, token, companyId, `Second refresh ${suffix}`, [
        { serial: `XYZ${tag}`, tag: assetTag, make: 'Lenovo', model: 'T14' },
      ])

      // AC-704: by serial, with the context to recognise the device.
      const bySerial = await searchAssetsOk(request, token, `q=ABC${tag}`)
      expect(bySerial.items).toHaveLength(1)
      expect(bySerial.items[0]).toMatchObject({
        id: first.assets[0].id,
        serial: `ABC${tag}`,
        customerAssetTag: assetTag,
        manufacturer: 'Dell',
        model: 'Latitude 5440',
        customerName: `QA Asset Search ${suffix}`,
        jobReference: first.job.internalReference,
        jobName: `Laptop refresh ${suffix}`,
        status: 'received',
        matchedOn: 'serial',
        exactMatch: true,
      })

      // AC-705, AC-706: by tag, every match; the tag is normalized like a serial.
      const byTag = await searchAssetsOk(request, token, `q=${encodeURIComponent(` fin-${tag.toLowerCase()} `)}`)
      expect(byTag.items.map((item) => item.id).sort()).toEqual([first.assets[0].id, second.assets[0].id].sort())
      expect(byTag.items.every((item) => item.matchedOn === 'customerAssetTag' && item.exactMatch)).toBe(true)
      expect(byTag.items.map((item) => item.jobReference).sort()).toEqual([first.job.internalReference, second.job.internalReference].sort())

      // `serial` stays a compatible alias of `q`.
      expect((await searchAssetsOk(request, token, `serial=XYZ${tag}`)).items.map((item) => item.id)).toEqual([second.assets[0].id])

      // No result is not an error; too short is.
      expect(await searchAssetsOk(request, token, `q=NOPE${tag}`)).toMatchObject({ items: [], total: 0 })
      expect((await searchAssets(request, token, 'q=ab')).status()).toBe(400)

      // REQ-717: another organization finds nothing.
      orgBId = await createOrganizationFixture(request, token, { name: `QA Asset Search Org B ${suffix}`, tenantId })
      expect((await searchAssetsOk(request, token, `q=${assetTag}`, orgBId)).items).toEqual([])
    } finally {
      await deleteOrganizationIfExists(request, token, orgBId)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

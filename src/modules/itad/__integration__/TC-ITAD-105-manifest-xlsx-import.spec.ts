import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { createJob, deleteJobIfExists, errorCode, uniqueSuffix } from './itad-job-fixtures'
import {
  XLSX_MIME,
  importManifest,
  listManifestItems,
  previewManifest,
  toPrefixedSpreadsheetMl,
  xlsxBuffer,
  type ManifestPreviewBody,
} from './itad-manifest-fixtures'

/**
 * TC-ITAD-105 (spec TEST-106 and TEST-107, XLSX part): an XLSX workbook with a
 * non-standard header imports with an explicit mapping; a numeric serial cell raises a
 * warning that must be accepted; each sheet imports separately and the same sheet
 * again is rejected; an unknown sheet is reported. A workbook written with
 * `x:`-prefixed SpreadsheetML elements (.NET exporters) imports like any other.
 */
test.describe('TC-ITAD-105: manifest XLSX import', () => {
  test('sheets, explicit mapping, accepted warnings and import identity per sheet', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    const tag = suffix.slice(-6)
    let companyId: string | null = null
    let jobId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD XLSX ${suffix}`)
      jobId = (await createJob(request, token, { customerId: companyId, name: `QA xlsx ${suffix}` })).id
      const numericSerial = Number(`9${tag.replace(/\D/g, '').padEnd(6, '7')}`)
      const file = {
        name: `manifest-${tag}.xlsx`,
        mimeType: XLSX_MIME,
        buffer: await xlsxBuffer({
          Laptops: [
            ['Device ID', 'Hersteller', 'Typ', 'Cost Center'],
            [`LAP-${tag}-1`, 'Dell', 'Latitude 5420', 'CC-1'],
            [numericSerial, 'HP', 'EliteBook', null],
          ],
          Monitors: [
            ['Device ID', 'Hersteller'],
            [`MON-${tag}-1`, 'Eizo'],
          ],
        }),
      }
      const mapping = { serial: 'Device ID', manufacturer: 'Hersteller', model: 'Typ' }

      const firstPreview = await readJsonSafe<ManifestPreviewBody & { sheets: string[]; sheetName: string }>(
        await previewManifest(request, token, jobId, file),
      )
      expect(firstPreview).toMatchObject({ sheets: ['Laptops', 'Monitors'], sheetName: 'Laptops', mappingError: 'serial_required' })

      const preview = await readJsonSafe<ManifestPreviewBody>(await previewManifest(request, token, jobId, file, { mapping }))
      expect(preview?.counts).toMatchObject({ valid: 2, invalid: 0 })
      expect(preview?.warningCount).toBe(1)

      const unaccepted = await importManifest(request, token, jobId, file, { mapping })
      expect(unaccepted.status()).toBe(400)
      expect(await errorCode(unaccepted)).toBe('itad.manifest.errors.warnings_not_accepted')
      expect((await listManifestItems(request, token, jobId)).total).toBe(0)

      const accepted = await importManifest(request, token, jobId, file, { mapping, acceptWarnings: true })
      expect(accepted.status(), JSON.stringify(await readJsonSafe(accepted))).toBe(201)
      const items = await listManifestItems(request, token, jobId)
      expect(items.items.map((item) => item.serial).sort()).toEqual([`LAP-${tag}-1`, String(numericSerial)].sort())
      const lap = items.items.find((item) => item.serial === `LAP-${tag}-1`)
      expect(lap).toMatchObject({ manufacturer: 'Dell', model: 'Latitude 5420' })
      expect(lap?.sourceData).toEqual([
        { column: 'Device ID', value: `LAP-${tag}-1` },
        { column: 'Hersteller', value: 'Dell' },
        { column: 'Typ', value: 'Latitude 5420' },
        { column: 'Cost Center', value: 'CC-1' },
      ])

      const monitors = await importManifest(request, token, jobId, file, {
        mapping: { serial: 'Device ID', manufacturer: 'Hersteller' },
        sheet: 'Monitors',
      })
      expect(monitors.status()).toBe(201)
      expect((await listManifestItems(request, token, jobId)).total).toBe(3)

      const again = await importManifest(request, token, jobId, file, { mapping, acceptWarnings: true, sheet: 'Laptops' })
      expect(again.status()).toBe(409)
      expect(await errorCode(again)).toBe('itad.manifest.errors.manifest_already_imported')

      const missingSheet = await previewManifest(request, token, jobId, file, { sheet: 'Printers' })
      expect(missingSheet.status()).toBe(400)
      expect(await errorCode(missingSheet)).toBe('itad.manifest.errors.sheet_not_found')

      // Regression: .NET Open XML SDK exporters prefix the SpreadsheetML namespace (`<x:workbook>`).
      const dotnet = {
        name: `dotnet-${tag}.xlsx`,
        mimeType: XLSX_MIME,
        buffer: await toPrefixedSpreadsheetMl(
          await xlsxBuffer({ Assets: [['Serial Number', 'Manufacturer', 'Department'], [`NET-${tag}-1`, 'Lenovo', 'Finance']] }),
        ),
      }
      const dotnetPreview = await readJsonSafe<ManifestPreviewBody & { sheets: string[] }>(await previewManifest(request, token, jobId, dotnet))
      expect(dotnetPreview).toMatchObject({ sheets: ['Assets'], mappingError: null, counts: { valid: 1, invalid: 0 } })
      const dotnetImport = await importManifest(request, token, jobId, dotnet, { mapping: { serial: 'Serial Number', manufacturer: 'Manufacturer' } })
      expect(dotnetImport.status()).toBe(201)
      const net = (await listManifestItems(request, token, jobId)).items.find((item) => item.serial === `NET-${tag}-1`)
      expect(net?.sourceData).toEqual([
        { column: 'Serial Number', value: `NET-${tag}-1` },
        { column: 'Manufacturer', value: 'Lenovo' },
        { column: 'Department', value: 'Finance' },
      ])
    } finally {
      await deleteJobIfExists(request, token, jobId)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

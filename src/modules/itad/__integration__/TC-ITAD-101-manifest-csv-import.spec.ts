import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { createJob, deleteJobIfExists, getJob, uniqueSuffix } from './itad-job-fixtures'
import {
  csv,
  getManifest,
  importManifestOk,
  listManifestItems,
  previewManifest,
  type ManifestPreviewBody,
} from './itad-manifest-fixtures'

/**
 * TC-ITAD-101 (spec TEST-105): preview → import of a 10-row CSV with three unmapped
 * columns. Every item keeps its full source row (empty cells included), the import
 * records the unused columns and the importer, the original file downloads byte for
 * byte, search finds an unmapped value, and the job's derived expectedAssetCount follows.
 */
test.describe('TC-ITAD-101: manifest CSV import', () => {
  test('imports a CSV, preserves source data and the original file', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    let companyId: string | null = null
    let jobId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD Manifest ${suffix}`)
      jobId = (await createJob(request, token, { customerId: companyId, name: `QA manifest ${suffix}`, expectedAssetEstimate: 12 })).id

      const header = ['Serial Number', 'Make', 'Model', 'Cost Center', 'Department', 'Notes']
      const rows = Array.from({ length: 10 }, (_, index) => [
        `sn ${suffix.slice(-4)}-${index + 1}`,
        'Dell',
        `Latitude ${5400 + index}`,
        `CC-${index + 1}-${suffix.slice(-4)}`,
        'Finance',
        index === 0 ? '' : `note ${index + 1}`,
      ])
      const file = { name: `manifest-${suffix}.csv`, content: csv([header, ...rows], ';') }

      const previewResponse = await previewManifest(request, token, jobId, file)
      const preview = await readJsonSafe<ManifestPreviewBody>(previewResponse)
      expect(previewResponse.status(), JSON.stringify(preview)).toBe(200)
      expect(preview?.suggestedMapping).toEqual({ serial: 'Serial Number', manufacturer: 'Make', model: 'Model' })
      expect(preview?.unusedColumns).toEqual(['Cost Center', 'Department', 'Notes'])
      expect(preview?.counts).toEqual({ valid: 10, invalid: 0, skippedExisting: 0, blankIgnored: 0 })

      const imported = await importManifestOk(request, token, jobId, file, {
        serial: 'Serial Number',
        manufacturer: 'Make',
        model: 'Model',
      })
      expect(imported).toMatchObject({ importedCount: 10, skippedCount: 0 })

      const items = await listManifestItems(request, token, jobId)
      expect(items.total).toBe(10)
      const first = items.items[0]
      expect(first).toMatchObject({ serial: rows[0][0], manufacturer: 'Dell', model: 'Latitude 5400', customerAssetTag: null, sourceRow: 2 })
      expect(first.sourceData).toEqual(header.map((column, index) => ({ column, value: rows[0][index] })))

      const byUnmapped = await listManifestItems(request, token, jobId, `search=${encodeURIComponent(rows[6][3])}`)
      expect(byUnmapped.items.map((item) => item.serial)).toEqual([rows[6][0]])
      const bySerial = await listManifestItems(request, token, jobId, `search=${encodeURIComponent(rows[2][0].toUpperCase().replace(/\s/g, ''))}`)
      expect(bySerial.items.map((item) => item.serial)).toEqual([rows[2][0]])

      const importsResponse = await getManifest(request, token, jobId, '/imports')
      const imports = await readJsonSafe<{ items: Array<Record<string, unknown>> }>(importsResponse)
      expect(imports?.items).toHaveLength(1)
      expect(imports?.items[0]).toMatchObject({
        fileName: file.name,
        format: 'csv',
        importedCount: 10,
        totalRows: 10,
        unusedColumns: ['Cost Center', 'Department', 'Notes'],
        jobStatusAtChange: 'draft',
      })
      expect((imports?.items[0].importedBy as { name: string | null }).name).toBeTruthy()

      const download = await getManifest(request, token, jobId, `/imports/${imported.importId}/file`)
      expect(download.status()).toBe(200)
      expect(download.headers()['content-disposition']).toContain('attachment')
      expect((await download.body()).equals(Buffer.from(file.content, 'utf-8'))).toBe(true)

      const job = await getJob(request, token, jobId)
      expect(job).toMatchObject({ expectedAssetEstimate: 12 })
      expect((job as unknown as { expectedAssetCount: number }).expectedAssetCount).toBe(10)
    } finally {
      await deleteJobIfExists(request, token, jobId)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

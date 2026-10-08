import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { createJob, deleteJobIfExists, errorCode, transitionOk, uniqueSuffix } from './itad-job-fixtures'
import {
  csv,
  importManifest,
  importManifestOk,
  listManifestItems,
  previewManifest,
  type ManifestPreviewBody,
} from './itad-manifest-fixtures'

const MAPPING = { serial: 'Serial', model: 'Model' }

/**
 * TC-ITAD-102 (spec TEST-107, CSV part): invalid rows block the whole import; a second
 * import appends and skips serials already in the job without touching their source
 * data; the same file is rejected; a changed file, an unsupported type and a locked
 * manifest are refused. (Warnings come only from XLSX cells — covered with Phase 2.)
 */
test.describe('TC-ITAD-102: manifest validation and append rules', () => {
  test('blocks invalid files, appends, skips existing serials and rejects repeats', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    const tag = suffix.slice(-6)
    let companyId: string | null = null
    let jobId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD Manifest Val ${suffix}`)
      jobId = (await createJob(request, token, { customerId: companyId, name: `QA manifest val ${suffix}` })).id
      const header = ['Serial', 'Model', 'Cost Center']

      // Missing serial + a serial repeated after normalization → every such row is an error.
      const invalid = {
        name: `invalid-${suffix}.csv`,
        content: csv([header, [`A-${tag}`, 'X', 'CC1'], ['', 'Y', 'CC2'], [`b ${tag}`, 'Z', 'CC3'], [`B${tag}`, 'Z', 'CC4']]),
      }
      const preview = await readJsonSafe<ManifestPreviewBody>(await previewManifest(request, token, jobId, invalid, { mapping: MAPPING }))
      expect(preview?.counts).toMatchObject({ valid: 1, invalid: 3 })
      expect(preview?.errors.map((issue) => [issue.row, issue.code])).toEqual([
        [3, 'serial_missing'],
        [4, 'serial_duplicate_in_file'],
        [5, 'serial_duplicate_in_file'],
      ])
      const rejected = await importManifest(request, token, jobId, invalid, { mapping: MAPPING })
      expect(rejected.status()).toBe(400)
      const rejectedBody = await readJsonSafe<{ code?: string; rowErrors?: unknown[] }>(rejected)
      expect(rejectedBody?.code).toBe('itad.manifest.errors.manifest_rows_invalid')
      expect(rejectedBody?.rowErrors).toHaveLength(3)
      expect((await listManifestItems(request, token, jobId)).total).toBe(0)

      const first = { name: `first-${suffix}.csv`, content: csv([header, [`S1-${tag}`, 'M', 'CC-100'], [`S2-${tag}`, 'M', 'CC-100']]) }
      expect(await importManifestOk(request, token, jobId, first, MAPPING)).toMatchObject({ importedCount: 2, skippedCount: 0 })

      // Overlap: S2 again with a different unmapped value, plus a new S3.
      const second = { name: `second-${suffix}.csv`, content: csv([header, [`s2-${tag}`, 'M', 'CC-200'], [`S3-${tag}`, 'M', 'CC-200']]) }
      const secondPreview = await readJsonSafe<ManifestPreviewBody>(await previewManifest(request, token, jobId, second, { mapping: MAPPING }))
      expect(secondPreview?.counts).toMatchObject({ valid: 1, skippedExisting: 1, invalid: 0 })
      expect(await importManifestOk(request, token, jobId, second, MAPPING)).toMatchObject({ importedCount: 1, skippedCount: 1 })
      const items = await listManifestItems(request, token, jobId)
      expect(items.total).toBe(3)
      const s2 = items.items.find((item) => item.serial === `S2-${tag}`)
      expect(s2?.sourceData.find((entry) => entry.column === 'Cost Center')?.value).toBe('CC-100')

      const repeat = await importManifest(request, token, jobId, second, { mapping: MAPPING })
      expect(repeat.status()).toBe(409)
      expect(await errorCode(repeat)).toBe('itad.manifest.errors.manifest_already_imported')

      const changed = await importManifest(request, token, jobId, { name: 'changed.csv', content: csv([header, [`S9-${tag}`, 'M', 'x']]) }, {
        mapping: MAPPING,
        expectedSha256: 'a'.repeat(64),
      })
      expect(changed.status()).toBe(400)
      expect(await errorCode(changed)).toBe('itad.manifest.errors.file_changed')

      const unsupported = await previewManifest(request, token, jobId, { name: 'manifest.txt', content: 'Serial\nA1\n', mimeType: 'text/plain' })
      expect(unsupported.status()).toBe(400)
      expect(await errorCode(unsupported)).toBe('itad.manifest.errors.file_type_unsupported')

      await transitionOk(request, token, jobId, { action: 'cancel', reason: 'QA lock check' })
      const locked = await previewManifest(request, token, jobId, first, { mapping: MAPPING })
      expect(locked.status()).toBe(409)
      expect(await errorCode(locked)).toBe('itad.manifest.errors.manifest_locked')
      const lockedImport = await importManifest(request, token, jobId, { name: 'late.csv', content: csv([header, [`S8-${tag}`, 'M', 'x']]) }, { mapping: MAPPING })
      expect(lockedImport.status()).toBe(409)
    } finally {
      await deleteJobIfExists(request, token, jobId)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

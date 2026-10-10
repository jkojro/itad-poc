import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { advanceToReceiving, createSchedulableJob, getJob, postTransition, uniqueSuffix } from './itad-job-fixtures'
import { csv, importManifest, importManifestOk, listManifestItems, previewManifest } from './itad-manifest-fixtures'
import { listAssets, scanOk } from './itad-receiving-fixtures'

/**
 * TC-ITAD-201 (sanitization spec TEST-304): `dataBearing` from a mapped manifest column
 * (yes/no/tak/blank/garbage → accepted warning), the job default, and the resolution at
 * the scan — manifest value first, then the job default, else not determined. A `true`
 * device enters `sanitization_required`; later manifest or default changes never touch
 * an already received asset (snapshot rule).
 */
test.describe('TC-ITAD-201: dataBearing resolved at the scan', () => {
  test('manifest value, job default and snapshot rule', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    const tag = suffix.slice(-6).toUpperCase()
    let companyId: string | null = null
    let jobId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD DataBearing ${suffix}`)
      jobId = (await createSchedulableJob(request, token, companyId, `QA data bearing ${suffix}`)).id
      const file = {
        name: `db-${tag}.csv`,
        content: csv([
          ['Serial', 'Contains data'],
          [`Y${tag}`, 'yes'],
          [`N${tag}`, 'NIE'],
          [`T${tag}`, 'tak'],
          [`B${tag}`, ''],
          [`G${tag}`, 'maybe'],
        ]),
      }

      // The column is suggested and the preview shows parsed values plus one warning.
      const preview = await previewManifest(request, token, jobId, file)
      const previewBody = await readJsonSafe<{
        suggestedMapping: Record<string, string>
        rows: Array<{ serial: string; dataBearing: boolean | null }>
        warnings: Array<{ row: number; code: string }>
      }>(preview)
      expect(preview.status()).toBe(200)
      expect(previewBody?.suggestedMapping).toMatchObject({ serial: 'Serial', dataBearing: 'Contains data' })
      expect(previewBody?.rows.map((row) => row.dataBearing)).toEqual([true, false, true, null, null])
      expect(previewBody?.warnings).toEqual([{ row: 6, code: 'data_bearing_unrecognized', column: 'Contains data' }])

      const mapping = { serial: 'Serial', dataBearing: 'Contains data' }
      const refused = await importManifest(request, token, jobId, file, { mapping })
      expect(refused.status()).toBe(400)
      expect((await importManifest(request, token, jobId, file, { mapping, acceptWarnings: true })).status()).toBe(201)
      const items = (await listManifestItems(request, token, jobId)).items
      expect(Object.fromEntries(items.map((item) => [item.serial, item.dataBearing]))).toEqual({
        [`Y${tag}`]: true,
        [`N${tag}`]: false,
        [`T${tag}`]: true,
        [`B${tag}`]: null,
        [`G${tag}`]: null,
      })

      // Job default: editable until receiving ends, applied to later scans only.
      const job = await getJob(request, token, jobId)
      const setDefault = await apiRequest(request, 'PUT', '/api/itad/jobs', { token, data: { id: jobId, defaultDataBearing: true } })
      expect(setDefault.status(), JSON.stringify(await readJsonSafe(setDefault))).toBe(200)
      expect((await getJob(request, token, jobId)) as unknown as { defaultDataBearing: boolean | null }).toMatchObject({ defaultDataBearing: true })
      expect(job?.editableFields).toContain('defaultDataBearing')
      await advanceToReceiving(request, token, jobId)

      const yes = await scanOk(request, token, jobId, `Y${tag}`)
      expect(yes.asset).toMatchObject({ dataBearing: true, dataBearingSource: 'manifest', status: 'sanitization_required' })
      // Manifest `false` wins over the job default `true`.
      expect((await scanOk(request, token, jobId, `N${tag}`)).asset).toMatchObject({ dataBearing: false, dataBearingSource: 'manifest', status: 'received' })
      // Blank and unrecognized values fall back to the job default; so does an unexpected device.
      expect((await scanOk(request, token, jobId, `B${tag}`)).asset).toMatchObject({ dataBearing: true, dataBearingSource: 'job_default' })
      expect((await scanOk(request, token, jobId, `G${tag}`)).asset).toMatchObject({ dataBearing: true, dataBearingSource: 'job_default' })
      expect((await scanOk(request, token, jobId, `U${tag}`)).asset).toMatchObject({ dataBearing: true, dataBearingSource: 'job_default' })

      // Clearing the default leaves received assets as they are; the next unexpected device is undetermined.
      const cleared = await apiRequest(request, 'PUT', '/api/itad/jobs', { token, data: { id: jobId, defaultDataBearing: null } })
      expect(cleared.status()).toBe(200)
      expect((await scanOk(request, token, jobId, `V${tag}`)).asset).toMatchObject({ dataBearing: null, dataBearingSource: null, status: 'received' })
      expect((await listAssets(request, token, jobId, 'dataBearing=true')).total).toBe(4)
      expect((await listAssets(request, token, jobId, 'dataBearing=false')).items.map((asset) => asset.serial)).toEqual([`N${tag}`])
      expect((await listAssets(request, token, jobId, 'dataBearing=unknown')).items.map((asset) => asset.serial)).toEqual([`V${tag}`])
      expect((await listAssets(request, token, jobId, 'status=sanitization_required')).total).toBe(4)

      // Snapshot rule: a later manifest import for T… does not change the received Y… asset.
      const second = { name: `db2-${tag}.csv`, content: csv([['Serial', 'Contains data'], [`T${tag}`, 'no'], [`Y${tag}`, 'no']]) }
      await importManifestOk(request, token, jobId, second, mapping)
      expect((await listAssets(request, token, jobId, `search=Y${tag}`)).items[0]).toMatchObject({ dataBearing: true, status: 'sanitization_required' })
    } finally {
      if (jobId) await postTransition(request, token, jobId, { action: 'cancel', reason: 'QA cleanup' }).catch(() => undefined)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

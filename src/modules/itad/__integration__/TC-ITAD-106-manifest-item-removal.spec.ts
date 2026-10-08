import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import {
  CONFIRM,
  advanceToReceiving,
  createSchedulableJob,
  deleteJobIfExists,
  errorCode,
  getJob,
  transitionOk,
  uniqueSuffix,
} from './itad-job-fixtures'
import {
  csv,
  deleteManifestItem,
  getManifest,
  importManifest,
  importManifestOk,
  listManifestItems,
} from './itad-manifest-fixtures'

type ChangesBody = {
  items: Array<{
    kind: 'import' | 'item_deleted'
    jobStatus: string
    duringReceiving: boolean
    serial?: string
    reason?: string | null
    fileName?: string
    actor: { name: string | null }
  }>
}

const MAPPING = { serial: 'Serial' }

/**
 * TC-ITAD-106 (spec TEST-108): manifest items can be removed before receiving without a
 * reason and during receiving only with one; every import and removal is listed in the
 * manifest changes with the job status, flagged when made during receiving; from
 * `processing` on, the manifest is locked for both imports and removals.
 */
test.describe('TC-ITAD-106: manifest item removal and manifest changes', () => {
  test('reason rules, history flags and the processing lock', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    const tag = suffix.slice(-6)
    let companyId: string | null = null
    let jobId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD Removal ${suffix}`)
      jobId = (await createSchedulableJob(request, token, companyId, `QA removal ${suffix}`)).id
      const first = { name: `first-${tag}.csv`, content: csv([['Serial'], [`R1-${tag}`], [`R2-${tag}`], [`R3-${tag}`]]) }
      await importManifestOk(request, token, jobId, first, MAPPING)
      const byId = async () => new Map((await listManifestItems(request, token, jobId!)).items.map((item) => [item.serial, item.id]))
      let ids = await byId()

      const draftRemoval = await deleteManifestItem(request, token, jobId, ids.get(`R1-${tag}`)!)
      expect(draftRemoval.status()).toBe(200)
      const repeated = await deleteManifestItem(request, token, jobId, ids.get(`R1-${tag}`)!)
      expect(repeated.status()).toBe(404)
      expect((await getJob(request, token, jobId) as unknown as { expectedAssetCount: number }).expectedAssetCount).toBe(2)

      await advanceToReceiving(request, token, jobId)
      ids = await byId()
      const noReason = await deleteManifestItem(request, token, jobId, ids.get(`R2-${tag}`)!)
      expect(noReason.status()).toBe(400)
      expect(await errorCode(noReason)).toBe('itad.manifest.errors.reason_required')
      const shortReason = await deleteManifestItem(request, token, jobId, ids.get(`R2-${tag}`)!, 'no')
      expect(shortReason.status()).toBe(400)
      const withReason = await deleteManifestItem(request, token, jobId, ids.get(`R2-${tag}`)!, 'Customer withdrew the device')
      expect(withReason.status()).toBe(200)

      const late = { name: `late-${tag}.csv`, content: csv([['Serial'], [`R4-${tag}`]]) }
      await importManifestOk(request, token, jobId, late, MAPPING)

      const changesResponse = await getManifest(request, token, jobId, '/changes')
      expect(changesResponse.status()).toBe(200)
      const changes = (await readJsonSafe<ChangesBody>(changesResponse))!.items
      expect(changes.map((change) => [change.kind, change.jobStatus, change.duringReceiving])).toEqual([
        ['import', 'receiving', true],
        ['item_deleted', 'receiving', true],
        ['item_deleted', 'draft', false],
        ['import', 'draft', false],
      ])
      expect(changes[1]).toMatchObject({ serial: `R2-${tag}`, reason: 'Customer withdrew the device' })
      expect(changes[2]).toMatchObject({ serial: `R1-${tag}`, reason: null })
      expect(changes[0].actor.name).toBeTruthy()
      expect((await listManifestItems(request, token, jobId)).items.map((item) => item.serial).sort()).toEqual([`R3-${tag}`, `R4-${tag}`])

      await transitionOk(request, token, jobId, { action: 'start_processing', confirmations: [CONFIRM('receivingComplete')] })
      ids = await byId()
      const lockedRemoval = await deleteManifestItem(request, token, jobId, ids.get(`R3-${tag}`)!, 'Too late')
      expect(lockedRemoval.status()).toBe(409)
      expect(await errorCode(lockedRemoval)).toBe('itad.manifest.errors.manifest_locked')
      const lockedImport = await importManifest(request, token, jobId, { name: `locked-${tag}.csv`, content: csv([['Serial'], [`R5-${tag}`]]) }, { mapping: MAPPING })
      expect(lockedImport.status()).toBe(409)
    } finally {
      await deleteJobIfExists(request, token, jobId)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

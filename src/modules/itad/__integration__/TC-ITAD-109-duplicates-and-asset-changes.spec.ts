import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import {
  createRoleFixture,
  createUserFixture,
  deleteRoleIfExists,
  deleteUserIfExists,
  setRoleAclFeatures,
} from '@open-mercato/core/helpers/integration/authFixtures'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { getTokenContext } from '@open-mercato/core/helpers/integration/generalFixtures'
import { advanceToReceiving, createSchedulableJob, deleteJobIfExists, errorCode, uniqueSuffix } from './itad-job-fixtures'
import { deleteAsset, listAssets, listScans, scanAction, scanOk, updateAsset } from './itad-receiving-fixtures'

/**
 * TC-ITAD-109 (spec TEST-110): duplicate scans are resolved as the same device (once)
 * or flagged as a different device (note required; stays pending; can still be closed
 * as the same device, keeping the flag); asset edits use the asset version and reject
 * system fields; voiding an asset needs `itad.assets.manage` and a reason, after which
 * the serial can be scanned again.
 */
test.describe('TC-ITAD-109: duplicate resolution and asset corrections', () => {
  test('resolve, flag, edit with version, void with reason', async ({ request }) => {
    const adminToken = await getAuthToken(request, 'admin')
    const { tenantId, organizationId } = getTokenContext(adminToken)
    const suffix = uniqueSuffix()
    const tag = suffix.slice(-6).toUpperCase()
    let companyId: string | null = null
    let jobId: string | null = null
    let roleId: string | null = null
    let userId: string | null = null
    try {
      companyId = await createCompanyFixture(request, adminToken, `QA ITAD Dup ${suffix}`)
      jobId = (await createSchedulableJob(request, adminToken, companyId, `QA dup ${suffix}`)).id
      await advanceToReceiving(request, adminToken, jobId)

      const first = await scanOk(request, adminToken, jobId, `D1-${tag}`)
      const dupA = await scanOk(request, adminToken, jobId, `D1-${tag}`)
      const dupB = await scanOk(request, adminToken, jobId, `d1-${tag.toLowerCase()}`)
      expect([dupA.result, dupB.result]).toEqual(['DUPLICATE', 'DUPLICATE'])

      // Same device: closes the duplicate, once.
      expect((await scanAction(request, adminToken, jobId, dupA.scan.id, 'resolve')).status()).toBe(200)
      const again = await scanAction(request, adminToken, jobId, dupA.scan.id, 'resolve')
      expect(again.status()).toBe(409)
      expect(await errorCode(again)).toBe('itad.assets.errors.scan_not_resolvable')
      expect((await scanAction(request, adminToken, jobId, first.scan.id, 'resolve')).status()).toBe(409)

      // Different device: note required, stays pending, cannot be flagged twice.
      const noNote = await scanAction(request, adminToken, jobId, dupB.scan.id, 'flag-different-device')
      expect(noNote.status()).toBe(400)
      expect(await errorCode(noNote)).toBe('itad.assets.errors.note_required')
      expect((await scanAction(request, adminToken, jobId, dupB.scan.id, 'flag-different-device', 'On shelf B, sticker damaged')).status()).toBe(200)
      expect((await scanAction(request, adminToken, jobId, dupB.scan.id, 'flag-different-device', 'Again')).status()).toBe(409)
      let pending = await listScans(request, adminToken, jobId, 'pending=true')
      expect(pending.items.map((scan) => scan.id)).toEqual([dupB.scan.id])
      expect(pending.items[0]).toMatchObject({ flaggedDifferentDeviceNote: 'On shelf B, sticker damaged', resolvedAt: null })

      // A mistaken flag can still be closed as the same device; the flag stays as history.
      expect((await scanAction(request, adminToken, jobId, dupB.scan.id, 'resolve', 'Was the same laptop')).status()).toBe(200)
      pending = await listScans(request, adminToken, jobId, 'pending=true')
      expect(pending.total).toBe(0)
      const closed = (await listScans(request, adminToken, jobId)).items.find((scan) => scan.id === dupB.scan.id)
      expect(closed).toMatchObject({ resolution: 'same_device', flaggedDifferentDeviceNote: 'On shelf B, sticker damaged' })
      expect(closed?.flaggedDifferentDeviceAt).toBeTruthy()

      // Asset edit: optimistic lock on the asset, system fields refused.
      const [asset] = (await listAssets(request, adminToken, jobId)).items
      const stale = await updateAsset(request, adminToken, jobId, asset.id, { model: 'X1' }, '2000-01-01T00:00:00.000Z')
      expect(stale.status()).toBe(409)
      const systemField = await updateAsset(request, adminToken, jobId, asset.id, { serial: 'HACK' }, asset.updatedAt)
      expect(systemField.status()).toBe(400)
      expect(await errorCode(systemField)).toBe('itad.assets.errors.field_not_writable')
      const edited = await updateAsset(request, adminToken, jobId, asset.id, { model: 'ThinkPad X1', dataBearing: true }, asset.updatedAt)
      expect(edited.status()).toBe(200)
      const [afterEdit] = (await listAssets(request, adminToken, jobId)).items
      expect(afterEdit).toMatchObject({ model: 'ThinkPad X1', dataBearing: true, serial: `D1-${tag}` })

      // Voiding needs itad.assets.manage.
      const roleName = `qa_itad_receiver_${suffix.replace(/[^a-z0-9]/gi, '_')}`
      roleId = await createRoleFixture(request, adminToken, { name: roleName, tenantId })
      await setRoleAclFeatures(request, adminToken, { roleId, features: ['itad.jobs.view', 'itad.assets.view', 'itad.assets.receive'] })
      const email = `qa-itad-receiver-${suffix}@example.test`
      const password = `Qa-${suffix}-Secret!`
      userId = await createUserFixture(request, adminToken, { email, password, organizationId, roles: [roleName] })
      const receiverToken = await getAuthToken(request, email, password)
      expect((await deleteAsset(request, receiverToken, jobId, afterEdit.id, 'Wrong scan', afterEdit.updatedAt)).status()).toBe(403)
      expect((await scanOk(request, receiverToken, jobId, `R2-${tag}`)).result).toBe('UNEXPECTED')

      const noReason = await deleteAsset(request, adminToken, jobId, afterEdit.id, null, afterEdit.updatedAt)
      expect(noReason.status()).toBe(400)
      expect(await errorCode(noReason)).toBe('itad.assets.errors.reason_required')
      expect((await deleteAsset(request, adminToken, jobId, afterEdit.id, 'Scanned the wrong label', afterEdit.updatedAt)).status()).toBe(200)
      expect((await listAssets(request, adminToken, jobId)).items.map((item) => item.serial)).toEqual([`R2-${tag}`])

      // The serial can be received again as a new asset; the old scans stay in the log.
      const rescan = await scanOk(request, adminToken, jobId, `D1-${tag}`)
      expect(rescan.result).toBe('UNEXPECTED')
      expect(rescan.asset.id).not.toBe(afterEdit.id)
      expect((await listScans(request, adminToken, jobId)).total).toBe(5)
    } finally {
      await deleteUserIfExists(request, adminToken, userId)
      await deleteRoleIfExists(request, adminToken, roleId)
      await deleteJobIfExists(request, adminToken, jobId)
      await deleteEntityIfExists(request, adminToken, '/api/customers/companies', companyId)
    }
  })
})

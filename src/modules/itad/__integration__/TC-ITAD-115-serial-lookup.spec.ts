import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import {
  apiRequestWithSelectedOrg,
  createOrganizationFixture,
  createRoleFixture,
  createUserFixture,
  deleteOrganizationIfExists,
  deleteRoleIfExists,
  deleteUserIfExists,
  setRoleAclFeatures,
} from '@open-mercato/core/helpers/integration/authFixtures'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { getTokenContext, readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { advanceToReceiving, createSchedulableJob, errorCode, postTransition, uniqueSuffix } from './itad-job-fixtures'
import { getReconciliation, scanOk } from './itad-receiving-fixtures'

type LookupBody = { items: Array<{ serial: string; exactMatch: boolean; jobId: string; jobReference: string; customerName: string | null }>; total: number }

const BASE_URL = process.env.BASE_URL?.trim() || ''

/**
 * TC-ITAD-115 (spec TEST-115 and TEST-114, lookup part): the cross-job lookup matches
 * the normalized serial exactly or by prefix (exact first), needs 3 characters, stays
 * inside the caller's organizations and needs `itad.assets.view`; the reconciliation
 * counters need only `itad.jobs.view`.
 */
test.describe('TC-ITAD-115: serial lookup across jobs', () => {
  test('exact and prefix matches, minimum length, scope and features', async ({ request }) => {
    const adminToken = await getAuthToken(request, 'admin')
    const { tenantId, organizationId } = getTokenContext(adminToken)
    const suffix = uniqueSuffix()
    const tag = `LK${suffix.slice(-6).toUpperCase().replace(/[^A-Z0-9]/g, '')}`
    let companyId: string | null = null
    const jobIds: string[] = []
    let orgBId: string | null = null
    const roleIds: string[] = []
    const userIds: string[] = []
    const lookup = (token: string, serial: string) =>
      request.fetch(`${BASE_URL}/api/itad/assets?serial=${encodeURIComponent(serial)}`, { headers: { Authorization: `Bearer ${token}` } })
    try {
      companyId = await createCompanyFixture(request, adminToken, `QA ITAD Lookup ${suffix}`)
      for (const name of ['one', 'two']) {
        const id = (await createSchedulableJob(request, adminToken, companyId, `QA lookup ${name} ${suffix}`)).id
        jobIds.push(id)
        await advanceToReceiving(request, adminToken, id)
      }
      await scanOk(request, adminToken, jobIds[0], tag)
      await scanOk(request, adminToken, jobIds[1], `${tag}-2`)

      const prefix = await readJsonSafe<LookupBody>(await lookup(adminToken, tag.toLowerCase()))
      expect(prefix?.items.map((item) => [item.serial, item.exactMatch, item.jobId])).toEqual([
        [tag, true, jobIds[0]],
        [`${tag}-2`, false, jobIds[1]],
      ])
      expect(prefix?.items[0].customerName).toBe(`QA ITAD Lookup ${suffix}`)
      expect(prefix?.items[0].jobReference).toMatch(/^ITAD-\d{4}-\d{5,}$/)
      expect((await readJsonSafe<LookupBody>(await lookup(adminToken, `${tag}-2`)))?.items.map((item) => item.serial)).toEqual([`${tag}-2`])
      // Lookup is exact or prefix, never substring.
      expect((await readJsonSafe<LookupBody>(await lookup(adminToken, tag.slice(1))))?.total).toBe(0)

      const short = await lookup(adminToken, 'ab')
      expect(short.status()).toBe(400)
      expect(await errorCode(short)).toBe('itad.assets.errors.serial_too_short')

      orgBId = await createOrganizationFixture(request, adminToken, { name: `QA ITAD Lookup Org B ${suffix}`, tenantId })
      const fromOrgB = await apiRequestWithSelectedOrg(request, 'GET', `/api/itad/assets?serial=${encodeURIComponent(tag)}`, {
        token: adminToken,
        selectedOrgId: orgBId,
      })
      expect(fromOrgB.status()).toBe(200)
      expect((await readJsonSafe<LookupBody>(fromOrgB))?.total).toBe(0)

      const roleName = `qa_itad_lookup_${suffix.replace(/[^a-z0-9]/gi, '_')}`
      const roleId = await createRoleFixture(request, adminToken, { name: roleName, tenantId })
      roleIds.push(roleId)
      await setRoleAclFeatures(request, adminToken, { roleId, features: ['itad.jobs.view'] })
      const email = `qa-itad-lookup-${suffix}@example.test`
      const password = `Qa-${suffix}-Secret!`
      userIds.push(await createUserFixture(request, adminToken, { email, password, organizationId, roles: [roleName] }))
      const jobsOnly = await getAuthToken(request, email, password)
      expect((await lookup(jobsOnly, tag)).status()).toBe(403)
      expect((await getReconciliation(request, jobsOnly, jobIds[0])).receivedAssetCount).toBe(1)
    } finally {
      for (const id of jobIds) await postTransition(request, adminToken, id, { action: 'cancel', reason: 'QA cleanup' }).catch(() => undefined)
      for (const id of userIds) await deleteUserIfExists(request, adminToken, id)
      for (const id of roleIds) await deleteRoleIfExists(request, adminToken, id)
      await deleteEntityIfExists(request, adminToken, '/api/customers/companies', companyId)
      await deleteOrganizationIfExists(request, adminToken, orgBId)
    }
  })
})

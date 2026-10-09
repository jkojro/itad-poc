import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import {
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
import { advanceToReceiving, createSchedulableJob, deleteJobIfExists, getJob, uniqueSuffix } from './itad-job-fixtures'
import { csv, getManifest, importManifestOk } from './itad-manifest-fixtures'
import { getReceiving, postScan, scanOk } from './itad-receiving-fixtures'

/**
 * TC-ITAD-111 (spec TEST-114, assets part): another organization gets 404 on assets and
 * scans; `itad.jobs.view` alone sees the counters but no device data (403); with
 * `itad.assets.view` but not `itad.manifest.view`, asset responses carry only
 * `manifestItemId` (never source data) and the manifest items route stays 403; view
 * without receive cannot scan.
 */
test.describe('TC-ITAD-111: receiving scope and feature gates', () => {
  test('isolation, counters vs device data, source data only with manifest view', async ({ request }) => {
    const adminToken = await getAuthToken(request, 'admin')
    const { tenantId, organizationId } = getTokenContext(adminToken)
    const suffix = uniqueSuffix()
    const safe = suffix.replace(/[^a-z0-9]/gi, '_')
    const tag = suffix.slice(-6).toUpperCase()
    let companyId: string | null = null
    let jobId: string | null = null
    let orgBId: string | null = null
    const roleIds: string[] = []
    const userIds: string[] = []
    try {
      companyId = await createCompanyFixture(request, adminToken, `QA ITAD Recv ACL ${suffix}`)
      jobId = (await createSchedulableJob(request, adminToken, companyId, `QA recv acl ${suffix}`)).id
      await importManifestOk(request, adminToken, jobId, { name: `acl-${tag}.csv`, content: csv([['Serial', 'Owner'], [`S1-${tag}`, 'Jane Doe']]) }, { serial: 'Serial' })
      await advanceToReceiving(request, adminToken, jobId)
      await scanOk(request, adminToken, jobId, `S1-${tag}`)

      orgBId = await createOrganizationFixture(request, adminToken, { name: `QA ITAD Recv Org B ${suffix}`, tenantId })
      for (const path of ['/assets', '/scans']) {
        const response = await getReceiving(request, adminToken, jobId, path, orgBId)
        expect(response.status(), path).toBe(404)
        expect(await response.text()).not.toContain(`S1-${tag}`)
      }

      const tokenWith = async (label: string, features: string[]) => {
        const roleName = `qa_itad_${label}_${safe}`
        const roleId = await createRoleFixture(request, adminToken, { name: roleName, tenantId })
        roleIds.push(roleId)
        await setRoleAclFeatures(request, adminToken, { roleId, features })
        const email = `qa-itad-${label}-${suffix}@example.test`
        const password = `Qa-${suffix}-Secret!`
        userIds.push(await createUserFixture(request, adminToken, { email, password, organizationId, roles: [roleName] }))
        return getAuthToken(request, email, password)
      }

      const jobsOnly = await tokenWith('recv_jobs', ['itad.jobs.view'])
      expect((await getJob(request, jobsOnly, jobId) as unknown as { receivedAssetCount: number }).receivedAssetCount).toBe(1)
      for (const path of ['/assets', '/scans']) expect((await getReceiving(request, jobsOnly, jobId, path)).status(), path).toBe(403)

      const assetViewer = await tokenWith('recv_view', ['itad.jobs.view', 'itad.assets.view'])
      const assets = await getReceiving(request, assetViewer, jobId, '/assets')
      expect(assets.status()).toBe(200)
      const raw = await assets.text()
      expect(raw).not.toContain('Jane Doe')
      expect(raw).not.toContain('sourceData')
      const body = JSON.parse(raw) as { items: Array<{ manifestItemId: string | null }> }
      expect(body.items[0].manifestItemId).toBeTruthy()
      expect((await getManifest(request, assetViewer, jobId, `/items?id=${body.items[0].manifestItemId}`)).status()).toBe(403)
      expect((await postScan(request, assetViewer, jobId, `S2-${tag}`)).status()).toBe(403)

      const both = await tokenWith('recv_both', ['itad.jobs.view', 'itad.assets.view', 'itad.manifest.view'])
      const item = await getManifest(request, both, jobId, `/items?id=${body.items[0].manifestItemId}`)
      expect(item.status()).toBe(200)
      const itemBody = await readJsonSafe<{ items: Array<{ sourceData: Array<{ value: string }> }> }>(item)
      expect(itemBody?.items[0].sourceData.map((entry) => entry.value)).toContain('Jane Doe')
    } finally {
      for (const userId of userIds) await deleteUserIfExists(request, adminToken, userId)
      for (const roleId of roleIds) await deleteRoleIfExists(request, adminToken, roleId)
      await deleteJobIfExists(request, adminToken, jobId)
      await deleteEntityIfExists(request, adminToken, '/api/customers/companies', companyId)
      await deleteOrganizationIfExists(request, adminToken, orgBId)
    }
  })
})

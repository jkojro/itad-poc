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
import { createJob, deleteJobIfExists, getJob, uniqueSuffix } from './itad-job-fixtures'
import { csv, getManifest, importManifest, importManifestOk, previewManifest } from './itad-manifest-fixtures'

const MAPPING = { serial: 'Serial' }

/**
 * TC-ITAD-103 (spec TEST-114, manifest part): another organization gets 404 on every
 * manifest route and no data; `itad.jobs.view` alone sees the counter but no manifest
 * (403); `itad.manifest.view` reads but cannot preview or import (403).
 */
test.describe('TC-ITAD-103: manifest scope and feature gates', () => {
  test('isolates manifests per organization and enforces manifest features', async ({ request }) => {
    const adminToken = await getAuthToken(request, 'admin')
    const { tenantId, organizationId } = getTokenContext(adminToken)
    const suffix = uniqueSuffix()
    const safe = suffix.replace(/[^a-z0-9]/gi, '_')
    let companyId: string | null = null
    let jobId: string | null = null
    let orgBId: string | null = null
    const roleIds: string[] = []
    const userIds: string[] = []
    try {
      companyId = await createCompanyFixture(request, adminToken, `QA ITAD Manifest ACL ${suffix}`)
      jobId = (await createJob(request, adminToken, { customerId: companyId, name: `QA manifest acl ${suffix}` })).id
      const file = { name: `acl-${suffix}.csv`, content: csv([['Serial', 'Owner'], [`ACL-${safe}`, 'Jane Doe']]) }
      const { importId } = await importManifestOk(request, adminToken, jobId, file, MAPPING)

      orgBId = await createOrganizationFixture(request, adminToken, { name: `QA ITAD Manifest Org B ${suffix}`, tenantId })
      for (const path of ['/items', '/imports', `/imports/${importId}/file`]) {
        const response = await getManifest(request, adminToken, jobId, path, orgBId)
        expect(response.status(), path).toBe(404)
        expect(await response.text()).not.toContain('Jane Doe')
      }
      expect((await previewManifest(request, adminToken, jobId, file, { selectedOrgId: orgBId })).status()).toBe(404)
      expect((await importManifest(request, adminToken, jobId, file, { mapping: MAPPING, selectedOrgId: orgBId })).status()).toBe(404)

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

      const jobsOnly = await tokenWith('jobs_view', ['itad.jobs.view'])
      const job = await getJob(request, jobsOnly, jobId)
      expect((job as unknown as { expectedAssetCount: number }).expectedAssetCount).toBe(1)
      for (const path of ['/items', '/imports', `/imports/${importId}/file`]) {
        expect((await getManifest(request, jobsOnly, jobId, path)).status(), path).toBe(403)
      }

      const reader = await tokenWith('manifest_view', ['itad.jobs.view', 'itad.manifest.view'])
      const items = await getManifest(request, reader, jobId, '/items')
      expect(items.status()).toBe(200)
      const body = await readJsonSafe<{ items: Array<{ sourceData: Array<{ value: string }> }> }>(items)
      expect(body?.items[0].sourceData.map((entry) => entry.value)).toContain('Jane Doe')
      expect((await previewManifest(request, reader, jobId, file)).status()).toBe(403)
      const otherFile = { name: 'other.csv', content: csv([['Serial'], [`ACL2-${safe}`]]) }
      expect((await importManifest(request, reader, jobId, otherFile, { mapping: MAPPING })).status()).toBe(403)
    } finally {
      for (const userId of userIds) await deleteUserIfExists(request, adminToken, userId)
      for (const roleId of roleIds) await deleteRoleIfExists(request, adminToken, roleId)
      await deleteJobIfExists(request, adminToken, jobId)
      await deleteEntityIfExists(request, adminToken, '/api/customers/companies', companyId)
      await deleteOrganizationIfExists(request, adminToken, orgBId)
    }
  })
})

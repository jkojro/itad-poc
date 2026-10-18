import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createOrganizationFixture, deleteOrganizationIfExists, deleteRoleIfExists, deleteUserIfExists } from '@open-mercato/core/helpers/integration/authFixtures'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { getTokenContext } from '@open-mercato/core/helpers/integration/generalFixtures'
import { createSchedulableJob, uniqueSuffix } from './itad-job-fixtures'
import { processingJobWithDataBearingAssets } from './itad-sanitization-fixtures'
import { aiToolOk, tokenWithFeatures, type Cleanup } from './itad-ai-fixtures'

const ALL_VIEW_FEATURES = [
  'itad.jobs.view',
  'itad.assets.view',
  'itad.sanitization.view',
  'itad.exceptions.view',
  'itad.certificates.view',
]

/**
 * TC-ITAD-817 (AI assistant spec "Scope", AI-REQ-02): the AI tools read "not found" from
 * a 404, so every ITAD route they call must answer a record of another organization
 * exactly like a record that does not exist — 404, never 403 — or the assistant would
 * reveal that the record exists. Checked for every route the tools use, and at tool level.
 */
test.describe('TC-ITAD-817: AI route scope contract', () => {
  test('an out-of-organization record answers like a nonexistent one', async ({ request }) => {
    test.setTimeout(120_000)
    const token = await getAuthToken(request, 'admin')
    const { tenantId } = getTokenContext(token)
    const suffix = uniqueSuffix()
    const cleanup: Cleanup = { roleIds: [], userIds: [] }
    let companyId: string | null = null
    let orgBId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA AI Scope ${suffix}`)
      const job = await createSchedulableJob(request, token, companyId, `QA AI scope ${suffix}`)
      const [asset] = await processingJobWithDataBearingAssets(request, token, job.id, 1)

      orgBId = await createOrganizationFixture(request, token, { name: `QA AI Scope Org B ${suffix}`, tenantId })
      const outsider = await tokenWithFeatures(request, token, {
        label: 'scope',
        suffix,
        tenantId,
        organizationId: orgBId,
        features: ALL_VIEW_FEATURES,
        cleanup,
      })

      const paths = (jobId: string, assetId: string) => [
        `/api/itad/jobs/${jobId}/overview`,
        `/api/itad/jobs/${jobId}/transitions`,
        `/api/itad/jobs/${jobId}/reconciliation`,
        `/api/itad/jobs/${jobId}/sanitization`,
        `/api/itad/jobs/${jobId}/exceptions`,
        `/api/itad/jobs/${jobId}/certificates`,
        `/api/itad/jobs/${jobId}/assets`,
        `/api/itad/jobs/${jobId}/assets/${assetId}`,
        `/api/itad/jobs/${jobId}/assets/${assetId}/timeline`,
        `/api/itad/jobs/${jobId}/assets/${assetId}/certificates`,
      ]
      const known = paths(job.id, asset.id)
      const missing = paths(randomUUID(), randomUUID())
      for (const [index, path] of known.entries()) {
        const outOfScope = await apiRequest(request, 'GET', path, { token: outsider })
        const nonexistent = await apiRequest(request, 'GET', missing[index], { token: outsider })
        expect(outOfScope.status(), `out of organization: ${path}`).toBe(404)
        expect(nonexistent.status(), `nonexistent: ${missing[index]}`).toBe(404)
      }

      // The owner still reads every route.
      for (const path of known) expect((await apiRequest(request, 'GET', path, { token })).status(), path).toBe(200)

      // Tool level: the assistant cannot tell the two apart.
      const historyOutOfScope = await aiToolOk(request, outsider, 'itad.get_asset_history', { jobId: job.id, assetId: asset.id })
      const historyMissing = await aiToolOk(request, outsider, 'itad.get_asset_history', { jobId: job.id, assetId: randomUUID() })
      expect(historyOutOfScope.found).toBe(false)
      expect(historyMissing.found).toBe(false)
      expect(await aiToolOk(request, outsider, 'itad.get_job_blockers', { jobId: job.id })).toEqual({ found: false, jobId: job.id })
      expect((await aiToolOk(request, outsider, 'itad.find_asset', { q: asset.serial })).status).toBe('none')
    } finally {
      for (const userId of cleanup.userIds) await deleteUserIfExists(request, token, userId)
      for (const roleId of cleanup.roleIds) await deleteRoleIfExists(request, token, roleId)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
      await deleteOrganizationIfExists(request, token, orgBId)
    }
  })
})

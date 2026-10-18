import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createOrganizationFixture, deleteOrganizationIfExists, deleteRoleIfExists, deleteUserIfExists } from '@open-mercato/core/helpers/integration/authFixtures'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { getTokenContext } from '@open-mercato/core/helpers/integration/generalFixtures'
import { uniqueSuffix } from './itad-job-fixtures'
import { createOperationsScenario } from './itad-operations-scenario'
import { aiToolOk, tokenWithFeatures, type Cleanup } from './itad-ai-fixtures'

/**
 * TC-ITAD-801 (AI assistant spec AC-AI-01, AI-REQ-02, AI-REQ-03): "What should I focus on
 * today?" lists the jobs needing attention with the signals as reasons, red first, and
 * echoes the filters it applied. A user of another organization sees none of them.
 */
test.describe('TC-ITAD-801: AI focus today', () => {
  test('attention jobs with reasons, scoped to the caller', async ({ request }) => {
    test.setTimeout(120_000)
    const token = await getAuthToken(request, 'admin')
    const { tenantId } = getTokenContext(token)
    const suffix = uniqueSuffix()
    const tag = suffix.slice(-6).toUpperCase().replace(/[^A-Z0-9]/g, 'X')
    const cleanup: Cleanup = { roleIds: [], userIds: [] }
    let companyId: string | null = null
    let orgBId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA AI Focus ${suffix}`)
      const jobs = await createOperationsScenario(request, token, companyId, suffix, tag)

      const focus = await aiToolOk(request, token, 'itad.get_focus_today', { filters: { customerId: companyId } })
      expect(focus.appliedFilters).toEqual({ customerId: companyId })
      expect(focus.activeJobsReturned).toBe(5)
      expect(focus.jobs.items.map((job: { jobId: string }) => job.jobId)).toEqual([jobs.red.id, jobs.orange.id])
      const [red, orange] = focus.jobs.items
      expect(red).toMatchObject({ severity: 'red', reasons: [expect.objectContaining({ signal: 'failed', count: 1 })] })
      expect(orange).toMatchObject({ severity: 'orange', reasons: [expect.objectContaining({ signal: 'certificates_missing', count: 1 })] })
      expect(focus.assignedToMe).toMatchObject({ items: [], total: 0, coversAllAttentionJobs: true, jobsChecked: 2 })

      const everything = await aiToolOk(request, token, 'itad.get_focus_today')
      expect(everything.appliedFilters).toEqual({})
      expect(everything.activeJobsReturned).toBeGreaterThanOrEqual(5)

      orgBId = await createOrganizationFixture(request, token, { name: `QA AI Org B ${suffix}`, tenantId })
      const outsider = await tokenWithFeatures(request, token, {
        label: 'org_b',
        suffix,
        tenantId,
        organizationId: orgBId,
        features: ['itad.jobs.view'],
        cleanup,
      })
      const outside = await aiToolOk(request, outsider, 'itad.get_focus_today', { filters: { customerId: companyId } })
      expect(outside.jobs.items).toEqual([])
      expect(await aiToolOk(request, outsider, 'itad.get_job_summary', { jobId: jobs.red.id })).toEqual({ found: false, jobId: jobs.red.id })
      expect((await aiToolOk(request, outsider, 'itad.find_jobs', { query: jobs.red.internalReference })).status).toBe('none')
    } finally {
      for (const userId of cleanup.userIds) await deleteUserIfExists(request, token, userId)
      for (const roleId of cleanup.roleIds) await deleteRoleIfExists(request, token, roleId)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
      await deleteOrganizationIfExists(request, token, orgBId)
    }
  })
})

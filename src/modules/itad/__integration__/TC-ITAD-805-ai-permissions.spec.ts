import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { deleteRoleIfExists, deleteUserIfExists } from '@open-mercato/core/helpers/integration/authFixtures'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { getTokenContext } from '@open-mercato/core/helpers/integration/generalFixtures'
import { createSchedulableJob, uniqueSuffix } from './itad-job-fixtures'
import { createOperationsScenario } from './itad-operations-scenario'
import { processingJobWithDataBearingAssets, recordResult, startRunOk } from './itad-sanitization-fixtures'
import { aiToolOk, runAiTool, tokenWithFeatures, type Cleanup } from './itad-ai-fixtures'

type Gate = { gate: string; blocking?: unknown }

/**
 * TC-ITAD-805 (AI assistant spec AI-REQ-02, AI-REQ-06, AI-REQ-22): tools run with the
 * caller's features. A missing base feature refuses the tool; composite tools degrade the
 * parts the caller may not see to counts with `hidden: no_permission`.
 */
test.describe('TC-ITAD-805: AI tool permissions and degradation', () => {
  test('refuses without the base feature and hides details without the data feature', async ({ request }) => {
    test.setTimeout(150_000)
    const token = await getAuthToken(request, 'admin')
    const { tenantId, organizationId } = getTokenContext(token)
    const suffix = uniqueSuffix()
    const tag = suffix.slice(-6).toUpperCase().replace(/[^A-Z0-9]/g, 'X')
    const cleanup: Cleanup = { roleIds: [], userIds: [] }
    let companyId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA AI ACL ${suffix}`)
      const jobs = await createOperationsScenario(request, token, companyId, suffix, tag)
      const historyJob = await createSchedulableJob(request, token, companyId, `QA AI ACL history ${suffix}`)
      const [failed] = await processingJobWithDataBearingAssets(request, token, historyJob.id, 1)
      const run = await startRunOk(request, token, historyJob.id, failed)
      await recordResult(request, token, historyJob.id, run, { result: 'FAIL', verificationMethod: 'full_verification', verificationNotes: 'Readable' })

      const jobsOnly = await tokenWithFeatures(request, token, { label: 'jobs', suffix, tenantId, organizationId, features: ['itad.jobs.view'], cleanup })
      const refused = await runAiTool(request, jobsOnly, 'itad.get_sanitization_summary', { jobId: jobs.red.id })
      expect(refused.status).toBe(403)

      const blockers = await aiToolOk(request, jobsOnly, 'itad.get_job_blockers', { jobId: jobs.orange.id })
      const complete = blockers.actions.find((action: { action: string }) => action.action === 'complete')
      expect(complete.gates.find((gate: Gate) => gate.gate === 'requiredDocumentsComplete').blocking).toEqual({ hidden: 'no_permission', count: 1 })

      const focus = await aiToolOk(request, jobsOnly, 'itad.get_focus_today', { filters: { customerId: companyId } })
      expect(focus.jobs.items).toHaveLength(3)
      expect(focus.assignedToMe).toEqual({ hidden: 'no_permission' })

      const assetsOnly = await tokenWithFeatures(request, token, {
        label: 'assets',
        suffix,
        tenantId,
        organizationId,
        features: ['itad.jobs.view', 'itad.assets.view'],
        cleanup,
      })
      const history = await aiToolOk(request, assetsOnly, 'itad.get_asset_history', { jobId: historyJob.id, assetId: failed.id })
      expect(history.sections).toEqual({ sanitization: 'hidden', exceptions: 'hidden' })
      expect(history.certificates).toEqual({ hidden: 'no_permission' })
      const events = history.timeline.items.map((entry: { event: string }) => entry.event)
      expect(events).toContain('received')
      expect(events.filter((event: string) => event.startsWith('exception_') || event.startsWith('sanitization_'))).toEqual([])

      const notAllowlisted = await runAiTool(request, token, 'itad.not_a_tool', {})
      expect(notAllowlisted.status).toBe(400)
    } finally {
      for (const userId of cleanup.userIds) await deleteUserIfExists(request, token, userId)
      for (const roleId of cleanup.roleIds) await deleteRoleIfExists(request, token, roleId)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

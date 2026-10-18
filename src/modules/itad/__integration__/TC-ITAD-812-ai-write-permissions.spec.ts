import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { deleteRoleIfExists, deleteUserIfExists } from '@open-mercato/core/helpers/integration/authFixtures'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { getTokenScope } from '@open-mercato/core/helpers/integration/generalFixtures'
import { uniqueSuffix } from './itad-job-fixtures'
import {
  confirmAction,
  deletePendingActions,
  exceptionState,
  jobWithOpenReconciliationExceptions,
  runAiTool,
  seedPendingAction,
  tokenWithFeatures,
  type Cleanup,
} from './itad-ai-fixtures'

/**
 * TC-ITAD-812 (AI assistant spec AC-AI-10, AI-REQ-10): a user who may read exceptions but
 * not manage them cannot run the resolve tool, neither directly nor by confirming an
 * action prepared in their name; nothing changes.
 */
test.describe('TC-ITAD-812: AI write permissions', () => {
  test('without itad.exceptions.manage the resolve tool never writes', async ({ request }) => {
    test.setTimeout(120_000)
    const token = await getAuthToken(request, 'admin')
    const { tenantId, organizationId } = getTokenScope(token)
    const suffix = uniqueSuffix()
    const cleanup: Cleanup = { roleIds: [], userIds: [] }
    const actions: string[] = []
    let companyId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA AI Write ACL ${suffix}`)
      const { jobId, missing } = await jobWithOpenReconciliationExceptions(request, token, companyId, `QA AI write acl ${suffix}`)
      const viewer = await tokenWithFeatures(request, token, {
        label: 'viewer',
        suffix,
        tenantId,
        organizationId,
        features: ['itad.jobs.view', 'itad.exceptions.view'],
        cleanup,
      })
      const input = { jobId, exceptionId: missing.id, outcome: 'not_shipped', reason: 'Customer confirmed it stayed on site' }

      expect((await runAiTool(request, viewer, 'itad.resolve_exception', input)).status).toBe(403)

      const actionId = await seedPendingAction({
        tenantId,
        organizationId,
        createdByUserId: getTokenScope(viewer).userId,
        toolName: 'itad.resolve_exception',
        normalizedInput: input,
        recordVersion: missing.updatedAt,
        targetEntityType: 'itad.exception',
        targetRecordId: missing.id,
      })
      actions.push(actionId)
      const confirmed = await confirmAction(request, viewer, actionId)
      expect(confirmed.body?.ok).not.toBe(true)
      expect((await exceptionState(request, token, jobId, missing.id)).status).toBe('open')
    } finally {
      await deletePendingActions(actions)
      for (const userId of cleanup.userIds) await deleteUserIfExists(request, token, userId)
      for (const roleId of cleanup.roleIds) await deleteRoleIfExists(request, token, roleId)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import {
  createOrganizationFixture,
  deleteOrganizationIfExists,
  deleteRoleIfExists,
  deleteUserIfExists,
  setRoleAclFeatures,
  setUserAclVisibility,
} from '@open-mercato/core/helpers/integration/authFixtures'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { getTokenScope } from '@open-mercato/core/helpers/integration/generalFixtures'
import { uniqueSuffix } from './itad-job-fixtures'
import {
  confirmAction,
  deletePendingActions,
  exceptionState,
  jobWithOpenReconciliationExceptions,
  seedPendingAction,
  tokenWithFeatures,
  type Cleanup,
} from './itad-ai-fixtures'

const MANAGER_FEATURES = ['itad.jobs.view', 'itad.exceptions.view', 'itad.exceptions.manage']

/**
 * TC-ITAD-816 (AI assistant spec AI-REQ-09, AI-REQ-23): rights are checked again at
 * Confirm. A feature removed after the preview, access to the organization removed after
 * the preview, and a different user confirming all end with no change.
 */
test.describe('TC-ITAD-816: AI confirm re-checks', () => {
  test('revoked feature, revoked organization and another user never write', async ({ request }) => {
    test.setTimeout(150_000)
    const token = await getAuthToken(request, 'admin')
    const { tenantId, organizationId } = getTokenScope(token)
    const suffix = uniqueSuffix()
    const cleanup: Cleanup = { roleIds: [], userIds: [] }
    const actions: string[] = []
    let companyId: string | null = null
    let orgBId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA AI Recheck ${suffix}`)
      const { jobId, missing, unexpected } = await jobWithOpenReconciliationExceptions(request, token, companyId, `QA AI recheck ${suffix}`)
      const seedFor = async (userToken: string, exception: { id: string; updatedAt: string }, outcome: string) => {
        const id = await seedPendingAction({
          tenantId,
          organizationId,
          createdByUserId: getTokenScope(userToken).userId,
          toolName: 'itad.resolve_exception',
          normalizedInput: { jobId, exceptionId: exception.id, outcome, reason: 'Customer confirmed it' },
          recordVersion: exception.updatedAt,
          targetEntityType: 'itad.exception',
          targetRecordId: exception.id,
        })
        actions.push(id)
        return id
      }
      const open = async (id: string) => expect((await exceptionState(request, token, jobId, id)).status).toBe('open')

      // Feature removed between preview and Confirm.
      const revoked = await tokenWithFeatures(request, token, { label: 'revoked', suffix, tenantId, organizationId, features: MANAGER_FEATURES, cleanup })
      const revokedAction = await seedFor(revoked, missing, 'not_shipped')
      await setRoleAclFeatures(request, token, { roleId: cleanup.roleIds[0], features: ['ai_assistant.view', 'itad.jobs.view', 'itad.exceptions.view'] })
      const afterRevoke = await confirmAction(request, revoked, revokedAction)
      expect(afterRevoke.body?.ok).not.toBe(true)
      await open(missing.id)

      // Organization access removed between preview and Confirm.
      orgBId = await createOrganizationFixture(request, token, { name: `QA AI Recheck Org B ${suffix}`, tenantId })
      const moved = await tokenWithFeatures(request, token, { label: 'moved', suffix, tenantId, organizationId, features: MANAGER_FEATURES, cleanup })
      const movedAction = await seedFor(moved, missing, 'not_shipped')
      // Restricting organizations needs a user-level feature override too.
      await setUserAclVisibility(request, token, { userId: cleanup.userIds[1], organizations: [orgBId], features: ['ai_assistant.view', ...MANAGER_FEATURES] })
      const afterMove = await confirmAction(request, moved, movedAction)
      expect(afterMove.body?.ok).not.toBe(true)
      await open(missing.id)

      // Another user of the same organization confirming someone else's action.
      const author = await tokenWithFeatures(request, token, { label: 'author', suffix, tenantId, organizationId, features: MANAGER_FEATURES, cleanup })
      const authorAction = await seedFor(author, unexpected, 'accepted_into_job')
      const byOther = await confirmAction(request, token, authorAction)
      expect(byOther.body?.ok).toBe(false)
      expect(byOther.body?.mutationResult?.error?.message).toContain('Only the user who prepared')
      await open(unexpected.id)
    } finally {
      await deletePendingActions(actions)
      for (const userId of cleanup.userIds) await deleteUserIfExists(request, token, userId)
      for (const roleId of cleanup.roleIds) await deleteRoleIfExists(request, token, roleId)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
      await deleteOrganizationIfExists(request, token, orgBId)
    }
  })
})

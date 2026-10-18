import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { getTokenScope } from '@open-mercato/core/helpers/integration/generalFixtures'
import { uniqueSuffix } from './itad-job-fixtures'
import { jobOverviewOk } from './itad-overview-fixtures'
import { confirmAction, deletePendingActions, exceptionState, jobWithOpenReconciliationExceptions, latestActionLog, seedPendingAction } from './itad-ai-fixtures'

/**
 * TC-ITAD-809 (AI assistant spec AC-AI-05, AI-REQ-07, AI-REQ-10, AI-REQ-16): a pending
 * "resolve exception" changes nothing until Confirm; Confirm runs the existing command,
 * the job loses the missing attention while Missing keeps its count (D9), and the audit
 * entry carries the AI context with the confirming user as actor.
 */
test.describe('TC-ITAD-809: AI resolve exception', () => {
  test('nothing before Confirm; Confirm resolves through the domain command and audits the AI source', async ({ request }) => {
    test.setTimeout(120_000)
    const token = await getAuthToken(request, 'admin')
    const { tenantId, organizationId, userId } = getTokenScope(token)
    const suffix = uniqueSuffix()
    const actions: string[] = []
    let companyId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA AI Resolve ${suffix}`)
      const { jobId, missing } = await jobWithOpenReconciliationExceptions(request, token, companyId, `QA AI resolve ${suffix}`)
      const reason = 'Customer confirmed it stayed on site'
      const actionId = await seedPendingAction({
        tenantId,
        organizationId,
        createdByUserId: userId,
        toolName: 'itad.resolve_exception',
        normalizedInput: { jobId, exceptionId: missing.id, outcome: 'not_shipped', reason },
        recordVersion: missing.updatedAt,
        targetEntityType: 'itad.exception',
        targetRecordId: missing.id,
      })
      actions.push(actionId)

      // Pending: nothing changed yet.
      expect((await exceptionState(request, token, jobId, missing.id)).status).toBe('open')
      const before = await jobOverviewOk(request, token, jobId)
      expect(before.signals.map((signal) => signal.key)).toContain('missing_exceptions')

      const confirmed = await confirmAction(request, token, actionId)
      expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200)
      expect(confirmed.body).toMatchObject({ ok: true, pendingAction: { status: 'confirmed' }, mutationResult: { recordId: missing.id, commandName: 'itad.exceptions.resolve' } })

      const after = await exceptionState(request, token, jobId, missing.id)
      expect(after).toMatchObject({ status: 'resolved', resolutionOutcome: 'not_shipped', resolutionReason: reason })
      const overview = await jobOverviewOk(request, token, jobId)
      expect(overview.counters).toMatchObject({ missing: 1, openMissingExceptions: 0 })
      expect(overview.signals.map((signal) => signal.key)).not.toContain('missing_exceptions')

      const log = await latestActionLog(request, token, missing.id)
      expect(log).toMatchObject({ commandId: 'itad.exceptions.resolve', actorUserId: userId })
      expect(log!.context).toMatchObject({
        source: 'ai',
        channel: 'chat',
        actionId,
        pendingActionId: actionId,
        toolName: 'itad.resolve_exception',
        agentId: 'itad.operations_assistant',
        origin: { type: 'user', userId },
      })
    } finally {
      await deletePendingActions(actions)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

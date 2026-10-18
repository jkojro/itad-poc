import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { getTokenScope } from '@open-mercato/core/helpers/integration/generalFixtures'
import { uniqueSuffix } from './itad-job-fixtures'
import {
  cancelAction,
  confirmAction,
  deletePendingActions,
  exceptionState,
  jobWithOpenReconciliationExceptions,
  runAiTool,
  seedPendingAction,
} from './itad-ai-fixtures'

/**
 * TC-ITAD-810 (AI assistant spec AC-AI-06, AI-REQ-07, AI-REQ-09, AI-REQ-11, AI-REQ-12):
 * a write never happens without a valid, confirmed preview. Wrong outcome, an exception
 * of another job, a serial instead of an id, cancel, expiry, a change made in the UI
 * after the preview, and a direct tool call all leave the exception open.
 */
test.describe('TC-ITAD-810: AI resolve exception — refusals', () => {
  test('every invalid, cancelled, expired, stale or unapproved write leaves the exception open', async ({ request }) => {
    test.setTimeout(150_000)
    const token = await getAuthToken(request, 'admin')
    const { tenantId, organizationId, userId } = getTokenScope(token)
    const suffix = uniqueSuffix()
    const actions: string[] = []
    let companyId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA AI Refusals ${suffix}`)
      const a = await jobWithOpenReconciliationExceptions(request, token, companyId, `QA AI refusals A ${suffix}`)
      const b = await jobWithOpenReconciliationExceptions(request, token, companyId, `QA AI refusals B ${suffix}`)
      const reason = 'Customer confirmed it stayed on site'
      const seed = async (normalizedInput: Record<string, unknown>, extra: { recordVersion?: string | null; expiresInMinutes?: number } = {}) => {
        const id = await seedPendingAction({
          tenantId,
          organizationId,
          createdByUserId: userId,
          toolName: 'itad.resolve_exception',
          normalizedInput,
          recordVersion: extra.recordVersion === undefined ? a.missing.updatedAt : extra.recordVersion,
          targetEntityType: 'itad.exception',
          targetRecordId: String(normalizedInput.exceptionId),
          expiresInMinutes: extra.expiresInMinutes,
        })
        actions.push(id)
        return id
      }
      const stillOpen = async () => expect((await exceptionState(request, token, a.jobId, a.missing.id)).status).toBe('open')

      // Direct tool call (no approval): refused.
      const direct = await runAiTool(request, token, 'itad.resolve_exception', { jobId: a.jobId, exceptionId: a.missing.id, outcome: 'not_shipped', reason })
      expect(direct.status).toBe(400)
      expect(direct.body?.error).toContain('confirmed preview')
      await stillOpen()

      // Outcome not allowed for MISSING (AC-AI-06). Prepare refuses this input, so such a row only
      // exists if tampered with; the confirm-time re-read refuses it again and nothing is written.
      const wrongOutcome = await confirmAction(request, token, await seed({ jobId: a.jobId, exceptionId: a.missing.id, outcome: 'accepted_into_job', reason }))
      expect(wrongOutcome.body?.ok).not.toBe(true)
      expect(JSON.stringify(wrongOutcome.body)).toContain('not allowed')
      await stillOpen()

      // Exception of another job.
      const otherJob = await confirmAction(request, token, await seed({ jobId: a.jobId, exceptionId: b.missing.id, outcome: 'not_shipped', reason }))
      expect(otherJob.body?.ok).not.toBe(true)
      expect((await exceptionState(request, token, b.jobId, b.missing.id)).status).toBe('open')

      // A serial instead of an id: the stored input no longer fits the tool schema.
      const serialInput = await confirmAction(request, token, await seed({ jobId: a.jobId, exceptionId: a.missing.serial, outcome: 'not_shipped', reason }))
      expect(serialInput.status).toBe(412)
      expect(serialInput.body?.code).toBe('schema_drift')

      // Cancel never writes.
      const cancelled = await cancelAction(request, token, await seed({ jobId: a.jobId, exceptionId: a.missing.id, outcome: 'not_shipped', reason }))
      expect(cancelled.status).toBe(200)
      await stillOpen()

      // Expired never writes.
      const expired = await confirmAction(
        request,
        token,
        await seed({ jobId: a.jobId, exceptionId: a.missing.id, outcome: 'not_shipped', reason }, { expiresInMinutes: -1 }),
      )
      expect(expired.status).toBe(409)
      await stillOpen()

      // Resolved in the UI after the preview: stale, no second write.
      const staleId = await seed({ jobId: a.jobId, exceptionId: a.missing.id, outcome: 'not_shipped', reason })
      const ui = await apiRequest(request, 'POST', `/api/itad/jobs/${a.jobId}/exceptions/${a.missing.id}/resolve`, {
        token,
        data: { outcome: 'lost_in_transit', reason: 'Resolved by hand in the UI' },
        headers: { 'x-om-ext-optimistic-lock-expected-updated-at': a.missing.updatedAt },
      })
      expect(ui.status()).toBe(200)
      const stale = await confirmAction(request, token, staleId)
      expect(stale.status).toBe(412)
      expect(stale.body?.code).toBe('stale_version')
      expect(await exceptionState(request, token, a.jobId, a.missing.id)).toMatchObject({ status: 'resolved', resolutionOutcome: 'lost_in_transit' })

      // Unknown pending action.
      expect((await confirmAction(request, token, randomUUID())).status).toBe(404)
    } finally {
      await deletePendingActions(actions)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

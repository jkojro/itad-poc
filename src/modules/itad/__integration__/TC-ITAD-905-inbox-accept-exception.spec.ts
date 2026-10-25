import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { getTokenScope } from '@open-mercato/core/helpers/integration/generalFixtures'
import { uniqueSuffix } from './itad-job-fixtures'
import { exceptionState, jobWithOpenReconciliationExceptions, latestActionLog } from './itad-ai-fixtures'
import { acceptAction, importInboxMessage, inboxDetail, notShipped, waitProcessed } from './itad-inbox-fixtures'

/**
 * TC-ITAD-905 (Inbox Ops spec "Execute and audit", US-IN-03, demo steps 5–7): accepting an
 * I3 action resolves the exception `not_shipped` with the customer's reason through the
 * same command as the UI; the action log carries the email audit context — `actionId` =
 * the action, `proposalId` = the message, `origin.type: 'email'` with `messageId` only when
 * the email had one (not for a manual import) — with the operator as actor; the message
 * closes once its only action is decided.
 */
test.describe('TC-ITAD-905: Inbox accept resolves the exception', () => {
  test('accept → exception resolved, audited with the email context, message closed', async ({ request }) => {
    test.setTimeout(180_000)
    const token = await getAuthToken(request, 'admin')
    const { userId } = getTokenScope(token)
    const suffix = uniqueSuffix()
    let companyId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA Inbox Accept ${suffix}`)
      const { jobId, reference, missing } = await jobWithOpenReconciliationExceptions(request, token, companyId, `QA inbox accept ${suffix}`)
      const message = await waitProcessed(
        request,
        token,
        await importInboxMessage(request, token, {
          fromAddress: `qa-accept-${suffix}@customer.example`,
          subject: `Re: ${reference}`,
          bodyText: `About ${reference}: the device ${missing.serial} was never shipped, it stayed on site.`,
          extraction: notShipped(missing.serial),
        }),
      )
      const [action] = message.actions
      expect(action).toMatchObject({ type: 'resolve_exception', status: 'pending', matchStatus: 'high', missingFields: [] })
      expect(action.target.exception).toMatchObject({ id: missing.id })
      expect((await exceptionState(request, token, jobId, missing.id)).status).toBe('open')

      const accepted = await acceptAction(request, token, action)
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200)
      expect(accepted.body).toMatchObject({ status: 'executed', recordId: missing.id })

      expect(await exceptionState(request, token, jobId, missing.id)).toMatchObject({ status: 'resolved', resolutionOutcome: 'not_shipped' })
      const log = await latestActionLog(request, token, missing.id)
      expect(log).toMatchObject({ actorUserId: userId, commandId: 'itad.exceptions.resolve' })
      expect(log?.context).toMatchObject({ source: 'ai', channel: 'email', actionId: action.id, proposalId: message.id, toolName: 'inbox.resolve_exception', origin: { type: 'email' } })
      expect((log?.context as { origin?: Record<string, unknown> }).origin).not.toHaveProperty('messageId')

      const after = await inboxDetail(request, token, message.id)
      expect(after.status).toBe('closed')
      expect(after.actions[0]).toMatchObject({ status: 'executed', result: { recordId: missing.id, commandId: 'itad.exceptions.resolve' } })

      // A decided action cannot be accepted again.
      expect((await acceptAction(request, token, after.actions[0])).status).toBe(409)
    } finally {
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

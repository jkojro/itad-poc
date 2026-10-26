import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { deleteRoleIfExists, deleteUserIfExists } from '@open-mercato/core/helpers/integration/authFixtures'
import { getTokenScope } from '@open-mercato/core/helpers/integration/generalFixtures'
import { uniqueSuffix } from './itad-job-fixtures'
import { latestActionLog, tokenWithFeatures, type Cleanup } from './itad-ai-fixtures'
import { capturedEmails, importInboxMessage, inboxDetail, organizationInboxAddress, sendReply, statusInquiry, waitProcessed } from './itad-inbox-fixtures'

/**
 * TC-ITAD-913 (Inbox Ops spec "Phase 4 — Send the reply"): with `OM_TEST_MODE=1` the
 * framework captures the email instead of delivering it. Send goes to the customer sender
 * (fixed), with the operator's subject and body and Reply-To = the organization's Inbox
 * address; two concurrent Sends deliver one email; a second Send is refused; a stale
 * version is refused; `itad.inbox.reply` and `itad.jobs.view` are both required; the
 * message shows the sent reply and closes; the action log records it with the email context.
 */
test.describe('TC-ITAD-913: Inbox send the reply', () => {
  test('one email to the customer, Reply-To the Inbox, recorded and audited', async ({ request }) => {
    test.setTimeout(180_000)
    const token = await getAuthToken(request, 'admin')
    const { tenantId, organizationId, userId } = getTokenScope(token)
    const suffix = uniqueSuffix()
    const cleanup: Cleanup = { roleIds: [], userIds: [] }
    try {
      const sender = `qa-reply-${suffix}@customer.example`
      const message = await waitProcessed(
        request,
        token,
        await importInboxMessage(request, token, {
          fromAddress: sender,
          subject: `Status please ${suffix}`,
          bodyText: 'Hello, where are we with our devices?',
          extraction: statusInquiry(),
        }),
      )
      expect(message).toMatchObject({
        replyState: 'none',
        reply: null,
        canReply: true,
        emailDelivery: { available: true },
        replyCompose: { to: sender, subject: `Re: Status please ${suffix}` },
      })
      const subject = `Re: your devices ${suffix}`
      const body = `Hello,\n\nall 12 devices were received. ${suffix}\n\nITAD Operations`

      // Permissions: the reply feature, and the job view the draft is built from.
      const manageOnly = await tokenWithFeatures(request, token, {
        label: 'replymanage',
        suffix,
        tenantId,
        organizationId,
        features: ['itad.inbox.view', 'itad.inbox.manage', 'itad.jobs.view'],
        cleanup,
      })
      expect((await sendReply(request, manageOnly, message, { subject, body })).status).toBe(403)
      const replyNoJobs = await tokenWithFeatures(request, token, {
        label: 'replynojobs',
        suffix,
        tenantId,
        organizationId,
        features: ['itad.inbox.view', 'itad.inbox.reply'],
        cleanup,
      })
      expect((await sendReply(request, replyNoJobs, message, { subject, body })).status).toBe(403)

      // A stale version is refused.
      expect((await sendReply(request, token, { id: message.id, updatedAt: '2020-01-01T00:00:00.000Z' }, { subject, body })).status).toBe(409)
      expect(capturedEmails({ to: sender })).toHaveLength(0)

      // A double click: two concurrent Sends deliver one email.
      const [first, second] = await Promise.all([sendReply(request, token, message, { subject, body }), sendReply(request, token, message, { subject, body })])
      expect([first.status, second.status].sort()).toEqual([200, 409])
      const sent = first.status === 200 ? first : second
      expect(sent.body).toMatchObject({ messageId: message.id, toAddress: sender })

      const emails = capturedEmails({ to: sender })
      expect(emails).toHaveLength(1)
      expect(emails[0]).toMatchObject({ to: sender, subject, replyTo: await organizationInboxAddress(request, token) })
      expect(emails[0].text).toContain(`all 12 devices were received. ${suffix}`)

      const after = await inboxDetail(request, token, message.id)
      expect(after).toMatchObject({
        status: 'closed',
        replyState: 'sent',
        reply: { toAddress: sender, subject, body, sentBy: { id: userId } },
        replyError: null,
      })
      expect((await sendReply(request, token, after, { subject, body })).body).toMatchObject({ code: 'reply_already_sent' })
      expect(capturedEmails({ to: sender })).toHaveLength(1)

      const log = await latestActionLog(request, token, message.id)
      expect(log).toMatchObject({ actorUserId: userId, commandId: 'itad.inbox.record_reply' })
      expect(log?.context).toMatchObject({ channel: 'email', toolName: 'inbox.send_reply', proposalId: message.id })
    } finally {
      for (const id of cleanup.userIds) await deleteUserIfExists(request, token, id)
      for (const id of cleanup.roleIds) await deleteRoleIfExists(request, token, id)
    }
  })
})

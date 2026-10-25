import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { uniqueSuffix } from './itad-job-fixtures'
import { deliverSignedEmail, listInbox, organizationInboxAddress, waitProcessed } from './itad-inbox-fixtures'

/**
 * TC-ITAD-910 (Inbox Ops spec Q1 hybrid, "Architecture"): the `inbox_ops` contract ITAD
 * relies on, end to end — a signed delivery emits `inbox_ops.email.received` with the email
 * id and scope (the ITAD message exists and points at that `InboxEmail`), and every field
 * ITAD reads from it arrives mapped: message id, In-Reply-To, sender address and name,
 * subject, the current text without the quoted history, the quoted history as the thread,
 * the received time. The installed event id and columns are pinned by the unit test
 * `module-integrations/__tests__/inbox-ops-contract.test.ts`.
 */
test.describe('TC-ITAD-910: inbox_ops contract', () => {
  test('a signed delivery arrives with every InboxEmail field ITAD reads', async ({ request }) => {
    test.setTimeout(120_000)
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    const to = await organizationInboxAddress(request, token)
    const fromAddress = `qa-contract-${suffix}@customer.example`
    const email = {
      to,
      from: `Ola Kontrakt <${fromAddress}>`,
      subject: `QA inbox contract ${suffix}`,
      text: `Thanks, the new date works for us. ${suffix}\n\nOn Mon, 5 Jan 2026 at 10:00, ITAD Ops <ops@itad.example> wrote:\n> We propose a pickup on Friday at 9:00.\n`,
      messageId: `<qa-contract-${suffix}@customer.example>`,
      inReplyTo: `<ops-${suffix}@itad.example>`,
    }
    const before = Date.now()
    const delivered = await deliverSignedEmail(request, email)
    expect(delivered.status, JSON.stringify(delivered.body)).toBe(200)

    let id: string | null = null
    for (let attempt = 0; attempt < 60 && !id; attempt += 1) {
      const found = (await listInbox(request, token, 'pageSize=50')).items.find((item) => item.subject === email.subject)
      if (found) id = found.id as string
      else await new Promise((resolve) => setTimeout(resolve, 500))
    }
    expect(id, 'the received event reached the ITAD subscriber').toBeTruthy()
    const detail = await waitProcessed(request, token, id!)

    // The event carried the inbox_ops email id: the ITAD message points at that email.
    const emails = await apiRequest(request, 'GET', '/api/inbox_ops/emails?pageSize=50', { token })
    const source = ((await readJsonSafe<{ items: Array<{ id: string; subject?: string }> }>(emails))?.items ?? []).find((item) => item.subject === email.subject)
    expect(source, 'the inbox_ops email exists').toBeTruthy()
    expect(detail.inboxEmailId).toBe(source!.id)

    expect(detail).toMatchObject({
      source: 'email',
      messageId: email.messageId,
      inReplyTo: email.inReplyTo,
      from: { address: fromAddress, name: 'Ola Kontrakt' },
      subject: email.subject,
    })
    expect(detail.currentText).toContain('the new date works for us')
    expect(detail.currentText).not.toContain('We propose a pickup')
    expect(JSON.stringify(detail.threadMessages)).toContain('We propose a pickup on Friday')
    expect(new Date(detail.receivedAt).getTime()).toBeGreaterThanOrEqual(before - 60_000)
  })
})

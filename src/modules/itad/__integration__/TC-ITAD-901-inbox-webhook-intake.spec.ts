import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { uniqueSuffix } from './itad-job-fixtures'
import { deliverSignedEmail, listInbox, organizationInboxAddress, waitProcessed } from './itad-inbox-fixtures'

/**
 * TC-ITAD-901 (Inbox Ops spec Q1 hybrid, §4.2 receive → snapshot): a signed delivery to the
 * organization's inbound address becomes an `inbox_ops` email and exactly one ITAD inbox
 * message, processed to a proposal; a duplicate delivery adds nothing; a bad signature is
 * refused; the `inbox_ops` order / quote extraction does not run (its subscriber is
 * disabled), so its email stays `received`.
 */
test.describe('TC-ITAD-901: Inbox webhook intake', () => {
  test('signed delivery → one ITAD message; duplicate ignored; bad signature refused; no inbox_ops extraction', async ({ request }) => {
    test.setTimeout(120_000)
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    const to = await organizationInboxAddress(request, token)
    const email = {
      to,
      from: `qa-customer-${suffix}@customer.example`,
      subject: `QA inbox intake ${suffix}`,
      text: `Hello, just checking in about our devices. ${suffix}`,
      messageId: `<qa-${suffix}@customer.example>`,
    }

    expect((await deliverSignedEmail(request, email, { badSignature: true })).status).toBe(400)

    const delivered = await deliverSignedEmail(request, email)
    expect(delivered.status, JSON.stringify(delivered.body)).toBe(200)

    let id: string | null = null
    for (let attempt = 0; attempt < 60 && !id; attempt += 1) {
      const found = (await listInbox(request, token, 'pageSize=50')).items.find((item) => item.subject === email.subject)
      if (found) id = found.id as string
      else await new Promise((resolve) => setTimeout(resolve, 500))
    }
    expect(id, 'the ITAD inbox message appears').toBeTruthy()
    const detail = await waitProcessed(request, token, id!)
    expect(detail).toMatchObject({ source: 'email', status: 'proposed', customerSender: { address: email.from }, currentText: expect.stringContaining('checking in') })

    // A second delivery of the same message is deduplicated (by inbox_ops) and adds no ITAD message.
    expect((await deliverSignedEmail(request, email)).status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 2000))
    expect((await listInbox(request, token, 'pageSize=50')).items.filter((item) => item.subject === email.subject)).toHaveLength(1)

    // The inbox_ops extraction subscriber is disabled: its email is never processed into order proposals.
    const emails = await apiRequest(request, 'GET', '/api/inbox_ops/emails?pageSize=50', { token })
    const items = ((await readJsonSafe<{ items: Array<{ subject?: string; status?: string }> }>(emails))?.items ?? []).filter((item) => item.subject === email.subject)
    expect(items).toHaveLength(1)
    expect(items[0].status).toBe('received')
  })
})

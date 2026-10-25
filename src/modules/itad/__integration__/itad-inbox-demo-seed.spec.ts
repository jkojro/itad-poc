import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, createPersonFixture } from '@open-mercato/core/helpers/integration/crmFixtures'
import { uniqueSuffix } from './itad-job-fixtures'
import { jobWithOpenReconciliationExceptions } from './itad-ai-fixtures'
import { deliverSignedEmail, listInbox, organizationInboxAddress, waitProcessed } from './itad-inbox-fixtures'

/**
 * Inbox Ops demo seed (spec Phase 3, PDF §8 demo steps 5–8) — not a regression test, and
 * skipped unless `ITAD_SEED_INBOX_DEMO=1`. Run it against a dev server with an AI provider:
 *
 *   ITAD_SEED_INBOX_DEMO=1 BASE_URL=http://localhost:3000 yarn test:integration src/modules/itad/__integration__/itad-inbox-demo-seed.spec.ts
 *
 * It creates a customer with a contact and a processing job with an open "missing from
 * delivery" exception, then delivers three customer emails through the signed `inbox_ops`
 * webhook — the way a provider would — and waits until the interpreter has proposed:
 * step 5–7 the missing device "was never shipped" (I3 → resolve the exception), step 8 a
 * status question (I4 → draft reply with live counts), plus a new pickup request (I1). The
 * data stays for the demo; the printed summary says where to look.
 */
test.describe('ITAD Inbox demo seed', () => {
  test.skip(process.env.ITAD_SEED_INBOX_DEMO !== '1', 'Set ITAD_SEED_INBOX_DEMO=1 to seed the Inbox Ops demo')

  test('seed the Inbox Ops demo (steps 5–8)', async ({ request }) => {
    test.setTimeout(600_000)
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    const tag = suffix.slice(-5)
    const to = await organizationInboxAddress(request, token)
    const companyName = `Northwind Office ${tag}`
    const companyId = await createCompanyFixture(request, token, companyName)
    const contact = `anna.nowak.${tag}@northwind.example`
    await createPersonFixture(request, token, { firstName: 'Anna', lastName: 'Nowak', displayName: `Anna Nowak ${tag}`, companyEntityId: companyId, primaryEmail: contact })
    const { reference, missing } = await jobWithOpenReconciliationExceptions(request, token, companyId, `Laptop refresh ${tag}`)
    const year = new Date().getUTCFullYear() + 1

    const emails = [
      {
        step: 'Steps 5–7: missing device not shipped (I3)',
        subject: `Re: ${reference} delivery`,
        text: `Hi,\n\nregarding ${reference}: the laptop ${missing.serial} was never shipped, it stayed in our Warsaw office with a colleague who still needs it. Sorry for the confusion.\n\nBest regards,\nAnna Nowak`,
      },
      {
        step: 'Step 8: status inquiry (I4)',
        subject: `Status of ${reference}`,
        text: `Hello,\n\ncould you tell me where we are with ${reference}? When can we expect the data-erasure certificate?\n\nThanks,\nAnna`,
      },
      {
        step: 'New pickup request (I1)',
        subject: 'New pickup — monitors and laptops',
        text: `Hi,\n\nwe would like you to collect about 25 laptops and monitors from Prosta 20, 00-850 Warsaw, 2nd floor, on 15 March ${year} at 10:00. Our PO number is PO-${tag}.\n\nAnna Nowak`,
      },
    ]
    const summary: string[] = [`Customer: ${companyName} (${contact}); job ${reference} with missing ${missing.serial}`]
    for (const [index, email] of emails.entries()) {
      const delivered = await deliverSignedEmail(request, {
        to,
        from: `Anna Nowak <${contact}>`,
        subject: email.subject,
        text: email.text,
        messageId: `<demo-${tag}-${index}@northwind.example>`,
      })
      expect(delivered.status, JSON.stringify(delivered.body)).toBe(200)
      let id: string | null = null
      for (let attempt = 0; attempt < 120 && !id; attempt += 1) {
        const found = (await listInbox(request, token, 'pageSize=50')).items.find((item) => item.subject === email.subject)
        if (found) id = String(found.id)
        else await new Promise((resolve) => setTimeout(resolve, 500))
      }
      expect(id, `${email.step}: the email reached the ITAD Inbox`).toBeTruthy()
      const detail = await waitProcessed(request, token, id!, 180_000)
      summary.push(`${email.step}: /backend/itad/inbox/${id} — ${detail.status}, ${detail.matchStatus ?? 'no match'}, ${detail.actions.length} action(s)`)
    }
    console.log(`\nInbox Ops demo seeded:\n- ${summary.join('\n- ')}\n`)
  })
})

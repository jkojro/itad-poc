import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, createPersonFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { createSchedulableJob, deleteJobIfExists, loginAs, transitionOk, uniqueSuffix } from './itad-job-fixtures'
import { importInboxMessage, movePickup, newPickup, waitProcessed } from './itad-inbox-fixtures'

/**
 * TC-ITAD-911 (Inbox Ops spec "UI/UX"): the Inbox list shows the message and the 30-day
 * statistics; the detail of an ambiguous I2 email blocks Accept with a hint until the job is
 * chosen in the Match selector, then Accept shows the result on the action card; the draft
 * reply is filled and can be copied. An I1 email from an unknown sender says the customer
 * is missing, the customer is chosen by search, and Accept links the created job.
 */
test.describe('TC-ITAD-911: Inbox UI', () => {
  test('list, ambiguous selector, action result, draft copy, I1 customer choice', async ({ page, request, context }) => {
    test.setTimeout(180_000)
    await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => undefined)
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    const companyName = `QA Inbox UI ${suffix}`
    const jobIds: string[] = []
    let companyId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, companyName)
      const sender = `qa-ui-${suffix}@customer.example`
      await createPersonFixture(request, token, { firstName: 'Iga', lastName: 'U', displayName: `Iga U ${suffix}`, companyEntityId: companyId, primaryEmail: sender })
      const first = await createSchedulableJob(request, token, companyId, `QA inbox ui 1 ${suffix}`)
      const second = await createSchedulableJob(request, token, companyId, `QA inbox ui 2 ${suffix}`)
      jobIds.push(first.id, second.id)
      await transitionOk(request, token, first.id, { action: 'schedule' })
      await transitionOk(request, token, second.id, { action: 'schedule' })
      const year = new Date().getUTCFullYear() + 1
      const subject = `QA inbox UI pickup ${suffix}`
      const ambiguous = await waitProcessed(
        request,
        token,
        await importInboxMessage(request, token, {
          fromAddress: sender,
          subject,
          bodyText: `Hi, could you move our pickup to 7 April ${year} at 11:00?`,
          extraction: movePickup(`${year}-04-07T11:00`, `7 April ${year} at 11:00`),
        }),
      )
      expect(ambiguous.matchStatus).toBe('ambiguous')

      await loginAs(page, 'admin@acme.com', 'secret')
      await page.goto('/backend/itad/inbox')
      await expect(page.getByText(subject)).toBeVisible({ timeout: 30_000 })
      await expect(page.getByTestId('itad-inbox-stats')).toBeVisible()

      await page.goto(`/backend/itad/inbox/${ambiguous.id}`)
      const detail = page.getByTestId('itad-inbox-detail')
      await expect(detail.getByRole('heading', { name: subject })).toBeVisible()
      const card = detail.getByTestId('itad-inbox-action')
      await expect(card.getByTestId('itad-inbox-accept')).toBeDisabled()
      await expect(card.getByText('Choose the job or exception in Match first.')).toBeVisible()

      await detail.getByTestId('itad-inbox-change-match').click()
      const editor = detail.getByTestId('itad-inbox-match-editor')
      await editor.getByRole('combobox', { name: 'Job' }).click()
      await page.getByRole('option', { name: new RegExp(`${second.internalReference}`) }).click()
      await editor.getByTestId('itad-inbox-match-save').click()
      await expect(editor).toBeHidden()
      await expect(card.getByTestId('itad-inbox-accept')).toBeEnabled({ timeout: 15_000 })
      await card.getByTestId('itad-inbox-accept').click()
      await expect(card.getByText('Executed')).toBeVisible({ timeout: 15_000 })
      await expect(card.getByText('Done in')).toBeVisible()
      await expect(card.getByRole('link', { name: second.internalReference }).first()).toBeVisible()

      const draft = detail.getByTestId('itad-inbox-draft')
      await expect(draft).not.toHaveValue('')
      await detail.getByRole('button', { name: 'Copy' }).click()
      await expect(page.getByText('Copied')).toBeVisible()

      // I1 from an unknown sender: choose the customer by search, accept, open the new job.
      const unknown = await waitProcessed(
        request,
        token,
        await importInboxMessage(request, token, {
          fromAddress: `qa-ui-unknown-${suffix}@elsewhere.example`,
          subject: `QA inbox UI new ${suffix}`,
          bodyText: 'Hello, we have printers to recycle. Can you pick them up?',
          extraction: newPickup({ name: `Printers ${suffix}` }),
        }),
      )
      await page.goto(`/backend/itad/inbox/${unknown.id}`)
      const newCard = detail.getByTestId('itad-inbox-action')
      await expect(newCard.getByText('Missing: Customer')).toBeVisible()
      await expect(newCard.getByText('Choose the customer in Match first.')).toBeVisible()
      await expect(newCard.getByTestId('itad-inbox-accept')).toBeDisabled()
      await detail.getByTestId('itad-inbox-change-match').click()
      await editor.getByLabel('Find the customer').fill(companyName)
      await editor.getByRole('combobox', { name: 'Customer' }).click()
      await page.getByRole('option', { name: companyName }).click()
      await editor.getByTestId('itad-inbox-match-save').click()
      await expect(newCard.getByTestId('itad-inbox-accept')).toBeEnabled({ timeout: 15_000 })
      await newCard.getByTestId('itad-inbox-accept').click()
      const openJob = newCard.getByRole('link', { name: 'open the job' })
      await expect(openJob).toBeVisible({ timeout: 15_000 })
      const href = await openJob.getAttribute('href')
      jobIds.push(href!.split('/').pop()!)
      await openJob.click()
      await expect(page.getByTestId('itad-job-overview')).toBeVisible()
    } finally {
      for (const jobId of jobIds) await deleteJobIfExists(request, token, jobId)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { deleteRoleIfExists, deleteUserIfExists } from '@open-mercato/core/helpers/integration/authFixtures'
import { getTokenScope } from '@open-mercato/core/helpers/integration/generalFixtures'
import { loginAs, uniqueSuffix } from './itad-job-fixtures'
import { userWithFeatures, type Cleanup } from './itad-ai-fixtures'
import { capturedEmails, importInboxMessage, statusInquiry, waitProcessed } from './itad-inbox-fixtures'

/**
 * TC-ITAD-914 (Inbox Ops spec "Phase 4 — Send the reply", UI): Send opens a confirmation
 * dialog with the customer as a read-only recipient, the editable subject and body, and the
 * "cannot be recalled" warning; after sending, the draft section shows the sent reply read
 * only and Send is gone. Without `itad.inbox.reply` there is no Send, only Copy.
 */
test.describe('TC-ITAD-914: Inbox send the reply (UI)', () => {
  test('confirm dialog, sent state, no Send without the feature', async ({ page, request, browser }) => {
    test.setTimeout(180_000)
    const token = await getAuthToken(request, 'admin')
    const { tenantId, organizationId } = getTokenScope(token)
    const suffix = uniqueSuffix()
    const cleanup: Cleanup = { roleIds: [], userIds: [] }
    try {
      const sender = `qa-reply-ui-${suffix}@customer.example`
      const message = await waitProcessed(
        request,
        token,
        await importInboxMessage(request, token, {
          fromAddress: sender,
          subject: `Where are we ${suffix}`,
          bodyText: 'Hi, any news about our laptops?',
          extraction: statusInquiry(),
        }),
      )

      // Without the reply feature: Copy only.
      const viewer = await userWithFeatures(request, token, {
        label: 'replyviewer',
        suffix,
        tenantId,
        organizationId,
        features: ['itad.inbox.view', 'itad.inbox.manage', 'itad.jobs.view'],
        cleanup,
      })
      // Its own browser context: no session swap on a page that would redirect mid-navigation.
      const viewerContext = await browser.newContext({ baseURL: test.info().project.use.baseURL })
      try {
        const viewerPage = await viewerContext.newPage()
        await loginAs(viewerPage, viewer.email, viewer.password)
        await viewerPage.goto(`/backend/itad/inbox/${message.id}`)
        const viewerDetail = viewerPage.getByTestId('itad-inbox-detail')
        await expect(viewerDetail.getByRole('button', { name: 'Copy' })).toBeVisible({ timeout: 30_000 })
        await expect(viewerDetail.getByTestId('itad-inbox-send-reply')).toHaveCount(0)
      } finally {
        await viewerContext.close()
      }

      await loginAs(page, 'admin@acme.com', 'secret')
      await page.goto(`/backend/itad/inbox/${message.id}`)
      const detail = page.getByTestId('itad-inbox-detail')
      await detail.getByTestId('itad-inbox-draft').fill(`Hello, your 7 laptops are being processed. ${suffix}`)
      await detail.getByTestId('itad-inbox-send-reply').click()
      const dialog = page.getByTestId('itad-inbox-reply-dialog')
      await expect(dialog.getByLabel('To')).toHaveValue(sender)
      await expect(dialog.getByLabel('To')).toHaveAttribute('readonly', '')
      await expect(dialog.getByLabel('Subject')).toHaveValue(`Re: Where are we ${suffix}`)
      await expect(dialog.getByText('This email cannot be recalled.')).toBeVisible()
      await dialog.getByLabel('Subject').fill(`Re: laptops ${suffix}`)
      await dialog.getByTestId('itad-inbox-reply-confirm').click()

      const sent = detail.getByTestId('itad-inbox-reply-sent')
      await expect(sent).toBeVisible({ timeout: 15_000 })
      await expect(sent.getByText(`Re: laptops ${suffix}`)).toBeVisible()
      await expect(sent.getByText(`your 7 laptops are being processed. ${suffix}`)).toBeVisible()
      await expect(detail.getByTestId('itad-inbox-send-reply')).toHaveCount(0)
      expect(capturedEmails({ to: sender, subject: `Re: laptops ${suffix}` })).toHaveLength(1)
    } finally {
      for (const id of cleanup.userIds) await deleteUserIfExists(request, token, id)
      for (const id of cleanup.roleIds) await deleteRoleIfExists(request, token, id)
    }
  })
})

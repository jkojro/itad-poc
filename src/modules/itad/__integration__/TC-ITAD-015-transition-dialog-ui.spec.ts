import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { login } from '@open-mercato/core/helpers/integration/auth'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { waitForApiMutation } from '@open-mercato/core/helpers/integration/ui'
import { createSchedulableJob, getJob, postTransition, uniqueSuffix } from './itad-job-fixtures'
import { advanceToProcessing } from './itad-flow-fixtures'

/**
 * TC-ITAD-015 (spec TEST-011, lifecycle part): on the job detail page a supervisor
 * confirms a manual condition (allAssetsProcessed on "Start closeout review"; since the
 * manifest spec Phase 4 receivingComplete is computed from data) in the transition
 * dialog and submits with Cmd/Ctrl+Enter;
 * the status, history (with the confirmation and a decrypted actor name) and the hold
 * banner update; the confirm button stays disabled until the comment is valid.
 */
test.describe('TC-ITAD-015: transition dialog on the job detail page', () => {
  test('manual confirmation via keyboard, history and hold banner', async ({ page, request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    let companyId: string | null = null
    let jobId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD Dialog ${suffix}`)
      jobId = (await createSchedulableJob(request, token, companyId, `QA dialog ${suffix}`)).id
      await advanceToProcessing(request, token, jobId)

      await login(page, 'admin')
      await page.goto(`/backend/itad/jobs/${jobId}`)
      const statusRegion = page.getByRole('region', { name: 'Status', exact: true })
      const historyRegion = page.getByRole('region', { name: 'Status history' })
      await expect(statusRegion.getByText('Processing', { exact: true })).toBeVisible()

      await statusRegion.getByRole('button', { name: 'Start closeout review' }).click()
      const dialog = page.getByRole('dialog', { name: 'Start closeout review' })
      await expect(dialog.getByText('All assets processed — Requires confirmation')).toBeVisible()
      const confirmButton = dialog.getByRole('button', { name: 'Confirm' })
      await expect(confirmButton).toBeDisabled()
      await dialog.getByRole('checkbox', { name: 'Confirm manually' }).click()
      const comment = dialog.getByRole('textbox', { name: 'Confirmation comment' })
      await comment.fill('ok')
      await expect(confirmButton).toBeDisabled()
      await comment.fill('All drives erased on site')
      await expect(confirmButton).toBeEnabled()

      const moved = await waitForApiMutation(page, `/api/itad/jobs/${jobId}/transitions`, () => comment.press('ControlOrMeta+Enter'))
      expect(moved.status()).toBe(200)
      await expect(dialog).toBeHidden()
      await expect(statusRegion.getByText('Closeout review', { exact: true })).toBeVisible()
      await expect(historyRegion.getByText('Start closeout review: Processing → Closeout review')).toBeVisible()
      await expect(historyRegion.getByText(/All assets processed confirmed manually by .+: "All drives erased on site"/)).toBeVisible()
      await expect(historyRegion.getByText(/:v\d+$/)).toHaveCount(0)

      await statusRegion.getByRole('button', { name: 'Put on hold' }).click()
      const holdDialog = page.getByRole('dialog', { name: 'Put on hold' })
      await holdDialog.getByRole('textbox', { name: 'Reason' }).fill('Waiting for customer documents')
      const held = await waitForApiMutation(page, `/api/itad/jobs/${jobId}/transitions`, () =>
        holdDialog.getByRole('button', { name: 'Confirm' }).click(),
      )
      expect(held.status()).toBe(200)
      const banner = statusRegion.getByRole('alert')
      await expect(banner.getByText('On hold', { exact: true })).toBeVisible()
      await expect(banner.getByText(/Waiting for customer documents.*Was: Closeout review/)).toBeVisible()
      await expect(statusRegion.getByRole('button', { name: 'Resume' })).toBeVisible()
      expect((await getJob(request, token, jobId))?.status).toBe('on_hold')
    } finally {
      if (jobId) await postTransition(request, token, jobId, { action: 'cancel', reason: 'QA cleanup' }).catch(() => undefined)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { login } from '@open-mercato/core/helpers/integration/auth'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { createSchedulableJob, postTransition, uniqueSuffix } from './itad-job-fixtures'
import { processingJobWithDataBearingAssets } from './itad-sanitization-fixtures'

/**
 * TC-ITAD-211 (sanitization spec TEST-311, bulk part): the status panel names the
 * pending sanitization and keeps closeout disabled; in the Sanitization tab the whole
 * selection is started and passed in bulk; afterwards the pending line is gone. No HTML
 * nesting or hydration errors in the console.
 */
test.describe('TC-ITAD-211: bulk sanitization in the UI and the closeout gate', () => {
  test('select all, start, pass, closeout unblocked', async ({ page, request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    let companyId: string | null = null
    let jobId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD Bulk UI ${suffix}`)
      jobId = (await createSchedulableJob(request, token, companyId, `QA bulk ui ${suffix}`)).id
      const assets = await processingJobWithDataBearingAssets(request, token, jobId, 3)

      const markupErrors: string[] = []
      page.on('console', (message) => {
        if (message.type() === 'error' && /cannot be a descendant of|cannot contain a nested|hydration/i.test(message.text())) {
          markupErrors.push(message.text())
        }
      })
      await login(page, 'admin')
      await page.goto(`/backend/itad/jobs/${jobId}`)
      const status = page.getByRole('region', { name: 'Status', exact: true })
      await expect(status.getByText('Sanitization: 3 devices are not sanitized yet')).toBeVisible()
      await expect(status.getByRole('button', { name: 'Start closeout' })).toBeDisabled()
      await expect(status.getByText('Devices are waiting for sanitization')).toBeVisible()

      await page.getByRole('tab', { name: 'Sanitization' }).click()
      const tab = page.getByRole('region', { name: 'Sanitization' })
      await expect(tab.getByRole('row').filter({ hasText: assets[2].serial })).toBeVisible()
      const counter = (label: string) => tab.getByText(label, { exact: true }).locator('xpath=following-sibling::dd[1]')

      await tab.getByRole('checkbox', { name: 'Select all' }).click()
      await expect(tab.getByText('3 selected')).toBeVisible()
      await tab.getByRole('button', { name: 'Start run' }).click()
      let dialog = page.getByRole('dialog', { name: 'Start sanitization: 3 devices' })
      await dialog.getByRole('combobox', { name: 'Tool', exact: true }).fill('QA Rack Eraser')
      await dialog.getByRole('combobox', { name: 'Tool version' }).fill('3.0')
      await dialog.getByRole('button', { name: 'Start run' }).click()
      await expect(counter('Sanitization in progress')).toHaveText('3')

      await tab.getByRole('checkbox', { name: 'Select all' }).click()
      await tab.getByRole('button', { name: 'Record result' }).click()
      dialog = page.getByRole('dialog', { name: 'Sanitization result: 3 devices' })
      await expect(dialog.getByText('If any device has no open run, nothing is saved.', { exact: false })).toBeVisible()
      await dialog.getByRole('button', { name: 'Save result' }).click()
      await expect(counter('Sanitized')).toHaveText('3')

      await page.getByRole('tab', { name: 'Overview' }).click()
      await expect(status.getByText('Sanitization:', { exact: false })).toHaveCount(0)
      await expect(status.getByText('Devices are waiting for sanitization')).toHaveCount(0)
      expect(markupErrors).toEqual([])
    } finally {
      if (jobId) await postTransition(request, token, jobId, { action: 'cancel', reason: 'QA cleanup' }).catch(() => undefined)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

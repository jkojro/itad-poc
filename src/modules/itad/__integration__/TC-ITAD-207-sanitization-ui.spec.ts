import { expect, test, type Locator, type Page } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { login } from '@open-mercato/core/helpers/integration/auth'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { createSchedulableJob, postTransition, uniqueSuffix } from './itad-job-fixtures'
import { processingJobWithDataBearingAssets } from './itad-sanitization-fixtures'

/**
 * TC-ITAD-207 (sanitization spec TEST-311, single actions): in the Sanitization tab a
 * technician starts a run, records a FAIL (notes required), a manager approves a retry
 * with a reason (keyboard submit), the second run passes, and the history dialog shows
 * both runs and the `sanitization_failed` step. Counters follow. No HTML nesting or
 * hydration errors in the console.
 */
test.describe('TC-ITAD-207: Sanitization tab', () => {
  test('start, FAIL, retry, PASS and history', async ({ page, request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    const tool = `QA Eraser ${suffix.slice(-5)}`
    let companyId: string | null = null
    let jobId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD San UI ${suffix}`)
      jobId = (await createSchedulableJob(request, token, companyId, `QA san ui ${suffix}`)).id
      const [asset] = await processingJobWithDataBearingAssets(request, token, jobId, 1)

      const markupErrors: string[] = []
      page.on('console', (message) => {
        if (message.type() === 'error' && /cannot be a descendant of|cannot contain a nested|hydration/i.test(message.text())) {
          markupErrors.push(message.text())
        }
      })
      await login(page, 'admin')
      await page.goto(`/backend/itad/jobs/${jobId}`)
      await page.getByRole('tab', { name: 'Sanitization' }).click()
      await expect(page).toHaveURL(/tab=sanitization/)
      const tab = page.getByRole('region', { name: 'Sanitization' })
      const row = tab.getByRole('row').filter({ hasText: asset.serial })
      const counter = (label: string) => tab.getByText(label, { exact: true }).locator('xpath=following-sibling::dd[1]')
      const action = async (name: string) => {
        await row.getByRole('button', { name: 'Open actions' }).click()
        await page.getByRole('menuitem', { name }).click()
      }
      const choose = async (page: Page, combobox: Locator, option: string) => {
        await combobox.click()
        await page.getByRole('option', { name: option }).click()
      }
      await expect(row.getByText('No runs yet')).toBeVisible()
      await expect(counter('Sanitization required')).toHaveText('1')

      // Start run.
      await action('Start run')
      let dialog = page.getByRole('dialog', { name: `Start sanitization: ${asset.serial}` })
      await choose(page, dialog.getByRole('combobox', { name: 'Method' }), 'Clear (NIST 800-88)')
      await dialog.getByRole('combobox', { name: 'Tool', exact: true }).fill(tool)
      await dialog.getByRole('combobox', { name: 'Tool version' }).fill('2.1')
      await dialog.getByRole('button', { name: 'Start run' }).click()
      await expect(row.getByText('Sanitization in progress')).toBeVisible()
      await expect(row.getByText(`${tool} 2.1`, { exact: false })).toBeVisible()

      // FAIL needs notes.
      await action('Record result')
      dialog = page.getByRole('dialog', { name: `Sanitization result: ${asset.serial}` })
      await choose(page, dialog.getByRole('combobox', { name: 'Result' }), 'Failed')
      await expect(dialog.getByRole('button', { name: 'Save result' })).toBeDisabled()
      await dialog.getByLabel('Verification notes').fill('Verification found readable sectors')
      await dialog.getByRole('button', { name: 'Save result' }).click()
      await expect(row.getByText('Review required')).toBeVisible()
      await expect(counter('Review required')).toHaveText('1')

      // Manager retry, submitted with the keyboard.
      await action('Approve retry')
      dialog = page.getByRole('dialog', { name: `Approve a retry for ${asset.serial}?` })
      await dialog.getByLabel('Reason').fill('Second pass with a new cable')
      await dialog.getByLabel('Reason').press('ControlOrMeta+Enter')
      await expect(row.getByText('Sanitization required')).toBeVisible()

      // Second run passes; the tool is suggested from the first run.
      await action('Start run')
      dialog = page.getByRole('dialog', { name: `Start sanitization: ${asset.serial}` })
      await expect(dialog.locator(`datalist option[value="${tool}"]`)).toHaveCount(1)
      await dialog.getByRole('combobox', { name: 'Tool', exact: true }).fill(tool)
      await dialog.getByRole('combobox', { name: 'Tool version' }).fill('2.1')
      await dialog.getByRole('button', { name: 'Start run' }).click()
      await expect(row.getByText('Sanitization in progress')).toBeVisible()
      await action('Record result')
      dialog = page.getByRole('dialog', { name: `Sanitization result: ${asset.serial}` })
      await dialog.getByRole('button', { name: 'Save result' }).click()
      await expect(row.getByText('Sanitized', { exact: true })).toBeVisible()
      await expect(counter('Sanitized')).toHaveText('1')
      await expect(row.getByRole('cell', { name: '2', exact: true })).toBeVisible()

      // History: both runs and the transition state.
      await action('History')
      dialog = page.getByRole('dialog', { name: `Sanitization history: ${asset.serial}` })
      const runs = dialog.getByRole('region', { name: 'Runs' })
      await expect(runs.getByText('Passed')).toBeVisible()
      await expect(runs.getByText('Failed')).toBeVisible()
      await expect(runs.getByText('Verification found readable sectors')).toBeVisible()
      const statuses = dialog.getByRole('region', { name: 'Status history' })
      await expect(statuses.getByText('Sanitization in progress → Sanitization failed')).toBeVisible()
      await expect(statuses.getByText('Second pass with a new cable')).toBeVisible()
      expect(markupErrors).toEqual([])
    } finally {
      if (jobId) await postTransition(request, token, jobId, { action: 'cancel', reason: 'QA cleanup' }).catch(() => undefined)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

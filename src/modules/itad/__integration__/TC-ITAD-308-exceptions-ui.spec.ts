import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { login } from '@open-mercato/core/helpers/integration/auth'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { advanceToReceiving, createSchedulableJob, postTransition, transitionOk, uniqueSuffix } from './itad-job-fixtures'
import { csv, importManifestOk } from './itad-manifest-fixtures'
import { classifyUndecided, scanOk } from './itad-receiving-fixtures'

/**
 * TC-ITAD-308 (exceptions spec TEST-409, tab part; E4-060, E4-061): the Exceptions tab
 * shows OPEN exceptions first with counters by type; a manager assigns one to a person
 * and resolves the missing device with an outcome and a reason (keyboard submit); the
 * status filter shows it as resolved; the history dialog lists creation, assignment and
 * resolution; the status panel counts open exceptions. No HTML nesting or hydration errors.
 */
test.describe('TC-ITAD-308: Exceptions tab', () => {
  test('counters, assign, resolve, filters and history', async ({ page, request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    const tag = suffix.slice(-5).toUpperCase().replace(/[^A-Z0-9]/g, 'X')
    let companyId: string | null = null
    let jobId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD Exc UI ${suffix}`)
      jobId = (await createSchedulableJob(request, token, companyId, `QA exc ui ${suffix}`, { defaultDataBearing: false })).id
      await importManifestOk(request, token, jobId, { name: `u-${tag}.csv`, content: csv([['Serial'], [`UA${tag}`], [`UB${tag}`]]) }, { serial: 'Serial' })
      await advanceToReceiving(request, token, jobId)
      await scanOk(request, token, jobId, `UA${tag}`)
      await scanOk(request, token, jobId, `UX${tag}`)
      await classifyUndecided(request, token, jobId, false)
      await transitionOk(request, token, jobId, { action: 'start_processing' })

      const markupErrors: string[] = []
      page.on('console', (message) => {
        if (message.type() === 'error' && /cannot be a descendant of|cannot contain a nested|hydration/i.test(message.text())) {
          markupErrors.push(message.text())
        }
      })
      await login(page, 'admin')
      await page.goto(`/backend/itad/jobs/${jobId}`)
      const status = page.getByRole('region', { name: 'Status', exact: true })
      await expect(status.getByText('Open exceptions: 2')).toBeVisible()

      await page.getByRole('tab', { name: 'Exceptions' }).click()
      await expect(page).toHaveURL(/tab=exceptions/)
      const tab = page.getByRole('region', { name: 'Exceptions' })
      const counter = (label: string) => tab.getByText(label, { exact: true }).locator('xpath=following-sibling::dd[1]')
      await expect(counter('Missing from delivery')).toHaveText('1')
      await expect(counter('Unexpected device')).toHaveText('1')
      const missingRow = tab.getByRole('row').filter({ hasText: `UB${tag}` })
      await expect(missingRow.getByText('Expected in the manifest, not received')).toBeVisible()
      await expect(missingRow.getByText('Open', { exact: true })).toBeVisible()

      // Assign to the employee.
      await missingRow.getByRole('button', { name: 'Open actions' }).click()
      await page.getByRole('menuitem', { name: 'Assign' }).click()
      let dialog = page.getByRole('dialog', { name: `Assign: UB${tag}` })
      await dialog.getByLabel('Search people').fill('employee')
      await dialog.getByRole('combobox', { name: 'Assigned to' }).click()
      await page.getByRole('option', { name: /employee@acme\.com/ }).click()
      await dialog.getByRole('button', { name: 'Assign', exact: true }).click()
      await expect(missingRow.getByText(/employee/i)).toBeVisible()

      // Resolve the missing device, submitted with the keyboard.
      await missingRow.getByRole('button', { name: 'Open actions' }).click()
      await page.getByRole('menuitem', { name: 'Resolve' }).click()
      dialog = page.getByRole('dialog', { name: `Resolve: UB${tag}` })
      await expect(dialog.getByRole('button', { name: 'Resolve' })).toBeDisabled()
      await dialog.getByRole('combobox', { name: 'Outcome' }).click()
      await page.getByRole('option', { name: 'Lost in transit' }).click()
      await dialog.getByLabel('Reason').fill('Courier confirmed the parcel was lost')
      await dialog.getByLabel('Reason').press('ControlOrMeta+Enter')
      await expect(tab.getByRole('row').filter({ hasText: `UB${tag}` })).toHaveCount(0)
      await expect(counter('Missing from delivery')).toHaveText('0')

      // Show resolved ones and open the history.
      // The active filter chip "Status: Open ×" removes the default filter.
      await tab.getByRole('button', { name: /Status: Open/ }).click()
      const resolvedRow = tab.getByRole('row').filter({ hasText: `UB${tag}` })
      await expect(resolvedRow.getByText('Resolved', { exact: true })).toBeVisible()
      await expect(resolvedRow.getByText('Lost in transit')).toBeVisible()
      await resolvedRow.getByRole('button', { name: 'Open actions' }).click()
      await page.getByRole('menuitem', { name: 'History' }).click()
      dialog = page.getByRole('dialog', { name: /History: Missing from delivery/ })
      await expect(dialog.getByText('Opened by the system')).toBeVisible()
      await expect(dialog.getByText(/^Assigned:/)).toBeVisible()
      await expect(dialog.getByText('Resolved: Lost in transit')).toBeVisible()
      await page.keyboard.press('Escape')

      await page.getByRole('tab', { name: 'Overview' }).click()
      await expect(page.getByRole('region', { name: 'Status', exact: true }).getByText('Open exceptions: 1')).toBeVisible()
      expect(markupErrors).toEqual([])
    } finally {
      if (jobId) await postTransition(request, token, jobId, { action: 'cancel', reason: 'QA cleanup' }).catch(() => undefined)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { login } from '@open-mercato/core/helpers/integration/auth'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { advanceToReceiving, createSchedulableJob, postTransition, uniqueSuffix } from './itad-job-fixtures'
import { csv, importManifestOk } from './itad-manifest-fixtures'
import { scanOk } from './itad-receiving-fixtures'

/**
 * TC-ITAD-203 (sanitization spec TEST-311, receiving part): the job form shows the
 * default "carries data"; the status panel names the `dataBearingUndecided` blocker; the
 * Receiving tab shows the value with its source and the asset status, filters undecided
 * devices and classifies the selection in bulk after a confirmation, which unblocks
 * `start_processing`. No HTML nesting or hydration errors in the console.
 */
test.describe('TC-ITAD-203: data-bearing classification in the Receiving tab', () => {
  test('filter undecided devices and classify them in bulk', async ({ page, request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    const tag = suffix.slice(-6).toUpperCase().replace(/[^A-Z0-9]/g, 'X')
    let companyId: string | null = null
    let jobId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD Classify UI ${suffix}`)
      jobId = (await createSchedulableJob(request, token, companyId, `QA classify ui ${suffix}`)).id
      await importManifestOk(
        request,
        token,
        jobId,
        { name: `cu-${tag}.csv`, content: csv([['Serial', 'Data'], [`CA${tag}`, 'yes'], [`CB${tag}`, ''], [`CC${tag}`, '']]) },
        { serial: 'Serial', dataBearing: 'Data' },
      )
      await advanceToReceiving(request, token, jobId)
      for (const serial of [`CA${tag}`, `CB${tag}`, `CC${tag}`]) await scanOk(request, token, jobId, serial)

      const markupErrors: string[] = []
      page.on('console', (message) => {
        if (message.type() === 'error' && /cannot be a descendant of|cannot contain a nested|hydration/i.test(message.text())) {
          markupErrors.push(message.text())
        }
      })
      await login(page, 'admin')
      await page.goto(`/backend/itad/jobs/${jobId}`)
      const status = page.getByRole('region', { name: 'Status', exact: true })
      await expect(status.getByRole('button', { name: 'Start processing' })).toBeDisabled()
      await expect(status.getByText('Some devices are not yet classified as carrying data or not')).toBeVisible()
      const defaultField = page.locator('[data-crud-field-id="defaultDataBearing"]')
      await expect(defaultField.getByText('Default: carries data')).toBeVisible()
      await expect(defaultField.getByRole('combobox')).toHaveText('Not set')

      await page.getByRole('tab', { name: 'Receiving' }).click()
      const receiving = page.getByRole('region', { name: 'Receiving' })
      const rowOf = (serial: string) => receiving.getByRole('row').filter({ hasText: serial })
      await expect(rowOf(`CA${tag}`).getByText(/Yes\s*\(from manifest\)/)).toBeVisible()
      await expect(rowOf(`CA${tag}`).getByText('Sanitization required')).toBeVisible()
      await expect(rowOf(`CB${tag}`).getByText('Not determined')).toBeVisible()
      await expect(receiving.getByText('Carries data: not determined').locator('xpath=following-sibling::dd[1]')).toHaveText('2')

      // Filter the undecided devices.
      await receiving.getByRole('button', { name: 'Filters' }).click()
      await expect(receiving.getByRole('heading', { name: 'Filter' })).toBeVisible()
      // The panel holds two selects: Reconciliation, then Carries data.
      await receiving.getByRole('combobox').nth(1).click()
      await page.getByRole('option', { name: 'Not determined' }).click()
      await receiving.getByRole('button', { name: 'Apply' }).first().click()
      await expect(rowOf(`CA${tag}`)).toHaveCount(0)
      await expect(rowOf(`CB${tag}`)).toBeVisible()
      await expect(rowOf(`CC${tag}`)).toBeVisible()

      // Select both and mark them as not carrying data, after a confirmation.
      await receiving.getByRole('checkbox', { name: 'Select all' }).click()
      await expect(receiving.getByText('2 selected')).toBeVisible()
      await receiving.getByRole('button', { name: 'Mark as not carrying data' }).click()
      const confirm = page.getByRole('alertdialog').or(page.getByRole('dialog')).filter({ hasText: 'Mark 2 devices as not carrying data?' })
      await expect(confirm).toBeVisible()
      await confirm.getByRole('button').filter({ hasNotText: /cancel/i }).last().click()
      await expect(page.getByText('2 devices classified')).toBeVisible()
      await expect(receiving.getByText('No received devices match the search.')).toBeVisible()
      await expect(receiving.getByText('Carries data: not determined').locator('xpath=following-sibling::dd[1]')).toHaveText('0')

      await page.getByRole('tab', { name: 'Overview' }).click()
      await expect(page.getByRole('region', { name: 'Status', exact: true }).getByRole('button', { name: 'Start processing' })).toBeEnabled()
      expect(markupErrors).toEqual([])
    } finally {
      if (jobId) await postTransition(request, token, jobId, { action: 'cancel', reason: 'QA cleanup' }).catch(() => undefined)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

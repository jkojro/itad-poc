import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { login } from '@open-mercato/core/helpers/integration/auth'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { waitForApiMutation } from '@open-mercato/core/helpers/integration/ui'
import { createJob, deleteJobIfExists, uniqueSuffix } from './itad-job-fixtures'
import { csv } from './itad-manifest-fixtures'

/**
 * TC-ITAD-104 (spec TEST-116, wizard part): on the job's Manifest tab an operator
 * uploads a CSV, sees the suggested mapping and the unused columns, is blocked by an
 * invalid row, fixes the file, imports it, and opens a row's source data. Assigning one
 * column to two fields is reported in the mapping step and blocks the preview.
 */
test.describe('TC-ITAD-104: manifest import wizard', () => {
  test('upload, mapping, preview with errors, import and source data', async ({ page, request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    const tag = suffix.slice(-6)
    let companyId: string | null = null
    let jobId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD Wizard ${suffix}`)
      jobId = (await createJob(request, token, { customerId: companyId, name: `QA wizard ${suffix}` })).id
      const header = ['S/N', 'Vendor', 'Cost Center']
      const broken = csv([header, [`W1-${tag}`, 'HP', 'CC-1'], ['', 'HP', 'CC-2']])
      const fixed = csv([header, [`W1-${tag}`, 'HP', 'CC-1'], [`W2-${tag}`, 'Lenovo', 'CC-2']])

      await login(page, 'admin')
      await page.goto(`/backend/itad/jobs/${jobId}?tab=manifest`)
      const manifest = page.getByRole('region', { name: 'Manifest' })
      await expect(manifest.getByText('No manifest imported yet.')).toBeVisible()

      const openWizard = async () => {
        await manifest.getByRole('button', { name: 'Import manifest' }).first().click()
        return page.getByRole('dialog', { name: 'Import manifest' })
      }

      let dialog = await openWizard()
      await dialog.locator('input[type="file"]').setInputFiles({ name: `broken-${tag}.csv`, mimeType: 'text/csv', buffer: Buffer.from(broken) })
      await expect(dialog.getByRole('combobox', { name: 'Serial number' })).toHaveText('S/N')
      await expect(dialog.getByRole('combobox', { name: 'Manufacturer' })).toHaveText('Vendor')
      await expect(dialog.getByText('Cost Center', { exact: true })).toBeVisible()
      // The same column for two fields is caught before previewing (it used to yield an empty preview).
      await dialog.getByRole('combobox', { name: 'Model' }).click()
      await page.getByRole('option', { name: 'Vendor' }).click()
      await expect(dialog.getByText('Each column can be assigned to only one field.')).toBeVisible()
      await expect(dialog.getByRole('button', { name: 'Preview rows' })).toBeDisabled()
      await dialog.getByRole('combobox', { name: 'Model' }).click()
      await page.getByRole('option', { name: 'Not mapped' }).click()
      await dialog.getByRole('button', { name: 'Preview rows' }).click()
      await expect(dialog.getByText('1 to import · 1 with errors · 0 already in the job · 0 blank rows ignored')).toBeVisible()
      await expect(dialog.getByText('Row 3 · S/N: Serial number is missing')).toBeVisible()
      await expect(dialog.getByRole('button', { name: 'Import', exact: true })).toBeDisabled()
      await dialog.getByRole('button', { name: 'Cancel' }).click()
      await expect(dialog).toBeHidden()

      dialog = await openWizard()
      await dialog.locator('input[type="file"]').setInputFiles({ name: `fixed-${tag}.csv`, mimeType: 'text/csv', buffer: Buffer.from(fixed) })
      await dialog.getByRole('button', { name: 'Preview rows' }).click()
      const importButton = dialog.getByRole('button', { name: 'Import', exact: true })
      await expect(importButton).toBeEnabled()
      const imported = await waitForApiMutation(page, `/api/itad/jobs/${jobId}/manifest/imports`, () => importButton.click())
      expect(imported.status()).toBe(201)
      await expect(dialog).toBeHidden()

      await expect(manifest.getByText('Expected devices (manifest): 2')).toBeVisible()
      await expect(manifest.getByText(`W2-${tag}`)).toBeVisible()
      await expect(manifest.getByRole('link', { name: `fixed-${tag}.csv` })).toBeVisible()

      await manifest.getByText(`W2-${tag}`).click()
      const sourceDialog = page.getByRole('dialog', { name: `Source data of W2-${tag}` })
      await expect(sourceDialog.getByText('CC-2')).toBeVisible()
      await expect(sourceDialog.getByText('Lenovo')).toBeVisible()
    } finally {
      await deleteJobIfExists(request, token, jobId)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

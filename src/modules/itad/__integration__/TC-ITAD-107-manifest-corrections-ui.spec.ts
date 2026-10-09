import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { login } from '@open-mercato/core/helpers/integration/auth'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { waitForApiMutation } from '@open-mercato/core/helpers/integration/ui'
import { advanceToReceiving, createSchedulableJob, deleteJobIfExists, uniqueSuffix } from './itad-job-fixtures'
import { XLSX_MIME, csv, importManifestOk, xlsxBuffer } from './itad-manifest-fixtures'

/**
 * TC-ITAD-107 (spec TEST-116, wizard + history parts): during receiving an operator
 * imports the second sheet of an XLSX workbook through the wizard, removes a manifest
 * item (the reason is mandatory), and the job history shows both changes with the
 * "During receiving" badge, without HTML nesting or hydration errors in the console.
 */
test.describe('TC-ITAD-107: XLSX sheet import, item removal and history badge', () => {
  test('sheet selection, required removal reason and history entries', async ({ page, request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    const tag = suffix.slice(-6)
    let companyId: string | null = null
    let jobId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD Corrections ${suffix}`)
      jobId = (await createSchedulableJob(request, token, companyId, `QA corrections ${suffix}`)).id
      await importManifestOk(request, token, jobId, { name: `base-${tag}.csv`, content: csv([['Serial'], [`B1-${tag}`], [`B2-${tag}`]]) }, { serial: 'Serial' })
      await advanceToReceiving(request, token, jobId)

      // Regression: invalid HTML nesting (a badge div inside a p) caused a hydration error in the history.
      const markupErrors: string[] = []
      page.on('console', (message) => {
        if (message.type() === 'error' && /cannot be a descendant of|cannot contain a nested|hydration/i.test(message.text())) {
          markupErrors.push(message.text())
        }
      })

      await login(page, 'admin')
      await page.goto(`/backend/itad/jobs/${jobId}?tab=manifest`)
      const manifest = page.getByRole('region', { name: 'Manifest' })
      await expect(manifest.getByText(`B2-${tag}`)).toBeVisible()

      // XLSX: pick the second sheet; its columns get their own suggested mapping.
      await manifest.getByRole('button', { name: 'Import manifest' }).first().click()
      const wizard = page.getByRole('dialog', { name: 'Import manifest' })
      const workbook = await xlsxBuffer({
        Laptops: [['Serial'], [`L1-${tag}`]],
        Monitors: [['S/N', 'Brand'], [`M1-${tag}`, 'Eizo']],
      })
      await wizard.locator('input[type="file"]').setInputFiles({ name: `workbook-${tag}.xlsx`, mimeType: XLSX_MIME, buffer: workbook })
      await expect(wizard.getByRole('combobox', { name: 'Sheet' })).toHaveText('Laptops')
      await wizard.getByRole('combobox', { name: 'Sheet' }).click()
      await page.getByRole('option', { name: 'Monitors' }).click()
      await expect(wizard.getByRole('combobox', { name: 'Manufacturer' })).toHaveText('Brand')
      await wizard.getByRole('button', { name: 'Preview rows' }).click()
      const imported = await waitForApiMutation(page, `/api/itad/jobs/${jobId}/manifest/imports`, () =>
        wizard.getByRole('button', { name: 'Import', exact: true }).click(),
      )
      expect(imported.status()).toBe(201)
      await expect(manifest.getByText(`M1-${tag}`)).toBeVisible()
      await expect(manifest.getByText(`L1-${tag}`)).toHaveCount(0)

      // Removal during receiving needs a reason.
      const row = manifest.getByRole('row').filter({ hasText: `B1-${tag}` })
      await row.getByRole('button').last().click()
      await page.getByRole('menuitem', { name: 'Remove' }).click()
      const removeDialog = page.getByRole('dialog', { name: `Remove B1-${tag} from the manifest` })
      const removeButton = removeDialog.getByRole('button', { name: 'Remove' })
      await expect(removeButton).toBeDisabled()
      const reason = removeDialog.getByRole('textbox', { name: 'Reason' })
      await reason.fill('Customer kept the laptop')
      const removed = await waitForApiMutation(page, `/api/itad/jobs/${jobId}/manifest/items/`, () => reason.press('ControlOrMeta+Enter'), 'DELETE')
      expect(removed.status()).toBe(200)
      await expect(removeDialog).toBeHidden()
      await expect(manifest.getByText(`B1-${tag}`)).toHaveCount(0)

      await page.getByRole('tab', { name: 'Overview' }).click()
      const history = page.getByRole('region', { name: 'Status history' })
      const removal = history.getByRole('listitem').filter({ hasText: `Removed from manifest: B1-${tag}` })
      await expect(removal.getByText('During receiving')).toBeVisible()
      await expect(removal.getByText('Customer kept the laptop')).toBeVisible()
      const sheetImport = history.getByRole('listitem').filter({ hasText: `Manifest imported: workbook-${tag}.xlsx (Monitors)` })
      await expect(sheetImport.getByText('During receiving')).toBeVisible()
      await expect(history.getByRole('listitem').filter({ hasText: `Manifest imported: base-${tag}.csv` }).getByText('During receiving')).toHaveCount(0)
      await page.reload()
      await expect(page.getByRole('region', { name: 'Status history' }).getByText('During receiving').first()).toBeVisible()
      expect(markupErrors).toEqual([])
    } finally {
      await deleteJobIfExists(request, token, jobId)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

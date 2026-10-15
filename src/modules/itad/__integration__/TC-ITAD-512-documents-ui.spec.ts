import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { login } from '@open-mercato/core/helpers/integration/auth'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { createSchedulableJob, uniqueSuffix } from './itad-job-fixtures'
import { processingJobWithDataBearingAssets } from './itad-sanitization-fixtures'
import { passAsset } from './itad-certificate-fixtures'

/**
 * TC-ITAD-512 (certificates spec "UI/UX"): issuing from the asset "Certificates" section,
 * the job "Documents" tab with counts, missing devices, "Issue all missing" and the
 * certificate table, opening a PDF, and the reissue preview with its differences.
 */
test.describe('TC-ITAD-512: documents and certificates in the UI', () => {
  test('asset issue, Documents tab, bulk issue, PDF and reissue preview', async ({ page, request }) => {
    test.setTimeout(120_000)
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    let companyId: string | null = null
    const markupErrors: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error' && /cannot be a descendant of|cannot contain a nested|hydration/i.test(message.text())) {
        markupErrors.push(message.text())
      }
    })
    try {
      companyId = await createCompanyFixture(request, token, `QA Cert UI Original ${suffix}`)
      const job = await createSchedulableJob(request, token, companyId, `QA cert ui ${suffix}`)
      const assets = await processingJobWithDataBearingAssets(request, token, job.id, 3)
      for (const asset of assets) await passAsset(request, token, job.id, asset)

      await login(page, 'admin')

      // Issue one certificate from the asset section.
      await page.goto(`/backend/itad/jobs/${job.id}/assets/${assets[0].id}`)
      const section = page.getByTestId('itad-asset-certificates')
      await section.getByRole('button', { name: 'Issue certificate' }).click()
      await page.getByRole('dialog').getByRole('button', { name: 'Issue certificate' }).click()
      await expect(section.getByText('Issued', { exact: true })).toBeVisible()

      // The Documents tab counts it and lists the two devices still missing one.
      await page.goto(`/backend/itad/jobs/${job.id}?tab=documents`)
      const documents = page.getByTestId('itad-job-documents')
      await expect(documents.getByTestId('itad-documents-count-required')).toHaveText('3')
      await expect(documents.getByTestId('itad-documents-count-issued')).toHaveText('1')
      await expect(documents.getByTestId('itad-documents-count-missing')).toHaveText('2')
      await expect(documents.getByRole('link', { name: assets[1].serial })).toBeVisible()
      await expect(documents.getByRole('link', { name: assets[2].serial })).toBeVisible()

      await documents.getByRole('button', { name: 'Issue all missing' }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByRole('button', { name: 'Issue 2 certificates' }).click()
      await expect(dialog.getByTestId('itad-documents-issue-result')).toContainText('Issued: 2. Failed: 0.')
      // The footer button; the dialog's corner X shares the name.
      await dialog.getByRole('button', { name: 'Close' }).last().click()
      await expect(documents.getByTestId('itad-documents-count-missing')).toHaveText('0')
      await expect(documents.getByText('Every device that requires a certificate has one.')).toBeVisible()
      await expect(documents.getByRole('link', { name: 'Open PDF' })).toHaveCount(3)

      // Opening a PDF returns the stored document, with the browser session as a link would.
      const href = await documents.getByRole('link', { name: 'Open PDF' }).first().getAttribute('href')
      const pdf = await page.evaluate(async (url) => {
        const response = await fetch(url, { credentials: 'include' })
        return { status: response.status, type: response.headers.get('content-type') ?? '' }
      }, href!)
      expect(pdf).toMatchObject({ status: 200, type: expect.stringContaining('application/pdf') })

      // The reissue preview shows what changed since the issue.
      const renamed = await apiRequest(request, 'PUT', '/api/customers/companies', {
        token,
        data: { id: companyId, displayName: `QA Cert UI Corrected ${suffix}` },
      })
      expect(renamed.status()).toBe(200)
      await page.goto(`/backend/itad/jobs/${job.id}/assets/${assets[0].id}`)
      await section.getByRole('button', { name: 'Reissue' }).click()
      const differences = page.getByTestId('itad-certificate-reissue-differences')
      await expect(differences).toContainText(`QA Cert UI Original ${suffix}`)
      await expect(differences).toContainText(`QA Cert UI Corrected ${suffix}`)
      await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()
      expect(markupErrors).toEqual([])
    } finally {
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { createSchedulableJob, loginAs, uniqueSuffix } from './itad-job-fixtures'
import { processingJobWithDataBearingAssets } from './itad-sanitization-fixtures'

/**
 * TC-ITAD-808 (AI assistant spec AI-REQ-18, AI-REQ-19, Q8): the job page has a collapsed
 * assistant panel; the asset page and the dashboard offer "Ask the assistant". Without an
 * AI provider (the test environment has none) the panel says so, the button is disabled,
 * and the pages work as before.
 */
test.describe('TC-ITAD-808: AI assistant UI', () => {
  test('panel on the job page, ask buttons, not-configured state', async ({ page, request }) => {
    test.setTimeout(120_000)
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    let companyId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA AI UI ${suffix}`)
      const job = await createSchedulableJob(request, token, companyId, `QA AI UI ${suffix}`)
      const [asset] = await processingJobWithDataBearingAssets(request, token, job.id, 1)
      await loginAs(page, 'admin@acme.com', 'secret')

      await page.goto(`/backend/itad/jobs/${job.id}`)
      await expect(page.getByTestId('itad-job-overview')).toBeVisible()
      const panel = page.getByTestId('itad-assistant-panel')
      const toggle = panel.getByRole('button', { name: 'AI assistant' })
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-expanded', 'true')
      await expect(panel.getByTestId('itad-assistant-not-configured')).toBeVisible()

      await page.goto(`/backend/itad/jobs/${job.id}/assets/${asset.id}`)
      await expect(page.getByRole('heading', { name: asset.serial })).toBeVisible()
      await expect(page.getByTestId('itad-ask-assistant')).toBeDisabled()

      await page.goto('/backend/itad')
      await expect(page.getByRole('heading', { name: 'Operations' })).toBeVisible()
      await expect(page.getByTestId('itad-ask-assistant')).toBeDisabled()
    } finally {
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { login } from '@open-mercato/core/helpers/integration/auth'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { createSchedulableJob, uniqueSuffix } from './itad-job-fixtures'
import { processingJobWithDataBearingAssets, recordResult, startRunOk } from './itad-sanitization-fixtures'

/**
 * TC-ITAD-605 (operations dashboard spec "UI and interaction contracts"): the Operations
 * page is the first ITAD entry, a red job sits in Needs attention, its chip opens the
 * sanitization review, and the search box hands the query to the ITAD Assets page.
 */
test.describe('TC-ITAD-605: operations dashboard UI', () => {
  test('groups, chip link and search box', async ({ page, request }) => {
    test.setTimeout(90_000)
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
      companyId = await createCompanyFixture(request, token, `QA Ops UI ${suffix}`)
      const job = await createSchedulableJob(request, token, companyId, `QA ops ui ${suffix}`)
      const [asset] = await processingJobWithDataBearingAssets(request, token, job.id, 1)
      const run = await startRunOk(request, token, job.id, asset)
      await recordResult(request, token, job.id, run, { result: 'FAIL', verificationMethod: 'full_verification', verificationNotes: 'Readable sectors' })

      await login(page, 'admin')
      await page.goto('/backend/itad')
      const dashboard = page.getByTestId('itad-operations')
      await expect(dashboard.getByRole('heading', { name: 'Operations', level: 1 })).toBeVisible()
      const attention = dashboard.getByTestId('itad-operations-attention')
      const row = attention.getByRole('row').filter({ hasText: `QA ops ui ${suffix}` })
      await expect(row).toBeVisible()
      await expect(dashboard.getByTestId('itad-operations-upcoming').getByText(`QA ops ui ${suffix}`)).toHaveCount(0)

      await row.getByRole('link', { name: '1 failed sanitization' }).click()
      await expect(page).toHaveURL(new RegExp(`/backend/itad/jobs/${job.id}\\?tab=sanitization&status=review_required`))
      await expect(page.getByText('Status: Review required')).toBeVisible()

      await page.goto('/backend/itad')
      await page.getByRole('searchbox').or(page.getByLabel('Search assets by serial or customer asset tag')).first().fill(asset.serial)
      await page.getByRole('button', { name: 'Search', exact: true }).click()
      await expect(page).toHaveURL(new RegExp(`/backend/itad/assets\\?q=${asset.serial}`))
      expect(markupErrors).toEqual([])
    } finally {
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

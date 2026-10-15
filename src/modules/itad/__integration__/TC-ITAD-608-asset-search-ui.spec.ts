import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { login } from '@open-mercato/core/helpers/integration/auth'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { uniqueSuffix } from './itad-job-fixtures'
import { globalAssetSearch, receivedJobWithDevices } from './itad-search-fixtures'

/**
 * TC-ITAD-608 (operations dashboard spec "Asset search", REQ-715, REQ-722): from any
 * screen the header search finds the device and opens its detail; the ITAD Assets page
 * reads `?q=`, shows the live status and an explicit empty state.
 */
test.describe('TC-ITAD-608: asset search in the UI', () => {
  test('header search → asset detail; ITAD Assets page results and empty state', async ({ page, request }) => {
    test.setTimeout(90_000)
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    const tag = suffix.slice(-6).toUpperCase().replace(/[^A-Z0-9]/g, 'X')
    let companyId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA Search UI ${suffix}`)
      const serial = `UIS${tag}`
      const { job, assets } = await receivedJobWithDevices(request, token, companyId, `QA search ui ${suffix}`, [
        { serial, tag: `UT-${tag}`, make: 'Dell', model: 'Latitude 7420' },
      ])
      await expect
        .poll(async () => (await globalAssetSearch(request, token, serial)).some((result) => result.recordId === assets[0].id), { timeout: 30_000 })
        .toBe(true)

      await login(page, 'admin')
      await page.goto('/backend/itad')
      await page.locator('header').getByRole('button', { name: 'Open global search' }).click()
      await page.locator('input[aria-controls="topbar-search-results"]').fill(serial)
      const panel = page.locator('#topbar-search-results')
      await panel.getByText(serial, { exact: true }).first().click()
      await expect(page).toHaveURL(new RegExp(`/backend/itad/jobs/${job.id}/assets/${assets[0].id}`))

      await page.goto(`/backend/itad/assets?q=${encodeURIComponent(`UT-${tag}`)}`)
      const row = page.getByRole('row').filter({ hasText: serial })
      await expect(row).toBeVisible()
      await expect(row).toContainText('Dell Latitude 7420')
      await expect(row).toContainText(`QA Search UI ${suffix}`)
      await expect(row).toContainText('Received')

      await page.goto(`/backend/itad/assets?q=NOPE${tag}`)
      await expect(page.getByText(`No asset found for "NOPE${tag}".`)).toBeVisible()
    } finally {
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

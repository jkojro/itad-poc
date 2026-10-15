import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { login } from '@open-mercato/core/helpers/integration/auth'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { createSchedulableJob, postTransition, uniqueSuffix } from './itad-job-fixtures'
import { processingJobWithDataBearingAssets, recordResult, startRunOk } from './itad-sanitization-fixtures'

/**
 * TC-ITAD-311 (exceptions spec TEST-409, detail part; E4-062, E4-063, AC-408): the serial
 * lookup and the Receiving tab open the Asset detail page; it shows the device header,
 * its exceptions, its sanitization runs and the business timeline with actors and system
 * entries; it works at 390 px without horizontal scrolling. No HTML nesting or hydration
 * errors.
 */
test.describe('TC-ITAD-311: Asset detail page', () => {
  test('lookup and receiving open the page; sections and timeline', async ({ page, request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    let companyId: string | null = null
    let jobId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD Asset Detail ${suffix}`)
      jobId = (await createSchedulableJob(request, token, companyId, `QA asset detail ${suffix}`)).id
      const [asset] = await processingJobWithDataBearingAssets(request, token, jobId, 1)
      const run = await startRunOk(request, token, jobId, asset)
      expect((await recordResult(request, token, jobId, run, { result: 'FAIL', verificationMethod: 'none', verificationNotes: 'Readable sectors' })).status()).toBe(200)

      const markupErrors: string[] = []
      page.on('console', (message) => {
        if (message.type() === 'error' && /cannot be a descendant of|cannot contain a nested|hydration/i.test(message.text())) {
          markupErrors.push(message.text())
        }
      })
      await login(page, 'admin')

      // From the serial lookup page: a row opens the device.
      await page.goto('/backend/itad/assets')
      await page.getByPlaceholder('Serial number or customer asset tag').fill(asset.serial.toLowerCase())
      await page.getByRole('row').filter({ hasText: asset.serial }).getByRole('cell').first().click()
      await expect(page).toHaveURL(new RegExp(`/backend/itad/jobs/${jobId}/assets/${asset.id}`))

      const device = page.getByRole('region', { name: 'ITAD device' })
      await expect(device.getByRole('heading', { name: asset.serial })).toBeVisible()
      await expect(device.getByText('Review required')).toBeVisible()
      await expect(device.getByText(/Yes\s*\(from manifest\)/)).toBeVisible()
      await expect(page.getByRole('region', { name: 'Exceptions' }).getByText('Sanitization failed')).toBeVisible()
      await expect(page.getByRole('region', { name: 'Sanitization runs' }).getByText('Readable sectors')).toBeVisible()
      const timeline = page.getByRole('region', { name: 'Timeline' }).getByRole('listitem')
      await expect(timeline).toHaveCount(6)
      await expect(timeline.nth(0)).toContainText('Received')
      await expect(timeline.nth(1)).toContainText('system')
      await expect(timeline.nth(4)).toContainText('Sanitization failed')
      await expect(timeline.nth(5)).toContainText('Exception opened')

      // From the Receiving tab: "Details".
      await page.goto(`/backend/itad/jobs/${jobId}?tab=receiving`)
      const row = page.getByRole('region', { name: 'Receiving' }).getByRole('row').filter({ hasText: asset.serial })
      await row.getByRole('button', { name: 'Open actions' }).click()
      await page.getByRole('menuitem', { name: 'Details' }).click()
      await expect(page).toHaveURL(new RegExp(`/assets/${asset.id}`))

      // Narrow screen: the page body does not scroll horizontally.
      await page.setViewportSize({ width: 390, height: 844 })
      await expect(page.getByRole('region', { name: 'Timeline' })).toBeVisible()
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      expect(overflow).toBeLessThanOrEqual(1)
      expect(markupErrors).toEqual([])
    } finally {
      if (jobId) await postTransition(request, token, jobId, { action: 'cancel', reason: 'QA cleanup' }).catch(() => undefined)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

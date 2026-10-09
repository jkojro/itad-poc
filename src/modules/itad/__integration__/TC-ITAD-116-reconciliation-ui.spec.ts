import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { login } from '@open-mercato/core/helpers/integration/auth'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { advanceToReceiving, createSchedulableJob, postTransition, uniqueSuffix } from './itad-job-fixtures'
import { csv, importManifestOk } from './itad-manifest-fixtures'
import { scanOk } from './itad-receiving-fixtures'

/**
 * TC-ITAD-116 (spec TEST-116, reconciliation part): the status panel shows the
 * reconciliation line and names why `start_processing` is blocked; the Manifest tab
 * counts and filters missing devices; the serial lookup page finds a device across jobs
 * and opens its Receiving tab; returning to Overview does not focus the "Name" field. No
 * HTML nesting or hydration errors in the console.
 */
test.describe('TC-ITAD-116: reconciliation in the UI and serial lookup page', () => {
  test('status summary, blocked reason, missing filter and lookup', async ({ page, request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    const tag = suffix.slice(-6).toUpperCase().replace(/[^A-Z0-9]/g, 'X')
    let companyId: string | null = null
    let jobId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD Recon UI ${suffix}`)
      jobId = (await createSchedulableJob(request, token, companyId, `QA recon ui ${suffix}`)).id
      await importManifestOk(
        request,
        token,
        jobId,
        { name: `r-${tag}.csv`, content: csv([['Serial'], [`RA${tag}`], [`RB${tag}`], [`RC${tag}`]]) },
        { serial: 'Serial' },
      )
      await advanceToReceiving(request, token, jobId)
      await scanOk(request, token, jobId, `RA${tag}`)
      await scanOk(request, token, jobId, `RX${tag}`)
      await scanOk(request, token, jobId, `RA${tag}`)

      const markupErrors: string[] = []
      page.on('console', (message) => {
        if (message.type() === 'error' && /cannot be a descendant of|cannot contain a nested|hydration/i.test(message.text())) {
          markupErrors.push(message.text())
        }
      })
      await login(page, 'admin')
      await page.goto(`/backend/itad/jobs/${jobId}`)
      const statusRegion = page.getByRole('region', { name: 'Status', exact: true })
      await expect(statusRegion.getByText('1 matched · 2 missing · 1 unexpected · 1 duplicates to resolve')).toBeVisible()
      await expect(statusRegion.getByRole('button', { name: 'Start processing' })).toBeDisabled()
      await expect(statusRegion.getByText('Duplicate scans are waiting to be resolved')).toBeVisible()

      await page.getByRole('tab', { name: 'Manifest' }).click()
      const manifest = page.getByRole('region', { name: 'Manifest' })
      await expect(manifest.getByRole('row').filter({ hasText: `RB${tag}` }).getByText('Missing')).toBeVisible()
      await expect(manifest.getByRole('row').filter({ hasText: `RA${tag}` }).getByText('Matched')).toBeVisible()

      // Regression: coming back to Overview must not focus the "Name" field.
      await page.getByRole('tab', { name: 'Overview' }).click()
      const nameInput = page.locator('[data-crud-field-id="name"] input')
      await expect(nameInput).toBeVisible()
      await expect(nameInput).not.toBeFocused()

      await page.goto('/backend/itad/assets')
      await page.getByPlaceholder('Serial number or its beginning').fill(`rx${tag.toLowerCase()}`)
      const result = page.getByRole('row').filter({ hasText: `RX${tag}` })
      await expect(result.getByText('Exact match')).toBeVisible()
      await result.getByRole('link').click()
      await expect(page).toHaveURL(new RegExp(`/backend/itad/jobs/${jobId}\\?tab=receiving`))
      await expect(page.getByRole('region', { name: 'Receiving' }).getByRole('row').filter({ hasText: `RX${tag}` }).getByText('Unexpected')).toBeVisible()
      expect(markupErrors).toEqual([])
    } finally {
      if (jobId) await postTransition(request, token, jobId, { action: 'cancel', reason: 'QA cleanup' }).catch(() => undefined)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { login } from '@open-mercato/core/helpers/integration/auth'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { waitForApiMutation } from '@open-mercato/core/helpers/integration/ui'
import { advanceToReceiving, createSchedulableJob, deleteJobIfExists, uniqueSuffix } from './itad-job-fixtures'
import { csv, importManifestOk } from './itad-manifest-fixtures'

/**
 * TC-ITAD-112 (spec TEST-116, receiving part): the scan field keeps focus through an
 * Enter-driven scan loop and announces each result; a repeated serial shows up under
 * duplicates and is resolved as the same device; asset details are edited in a dialog;
 * no HTML nesting or hydration errors appear in the console.
 */
test.describe('TC-ITAD-112: receiving tab', () => {
  test('scan loop, duplicate resolution and asset edit', async ({ page, request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    const tag = suffix.slice(-6).toUpperCase()
    let companyId: string | null = null
    let jobId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD Recv UI ${suffix}`)
      jobId = (await createSchedulableJob(request, token, companyId, `QA recv ui ${suffix}`)).id
      await importManifestOk(
        request,
        token,
        jobId,
        { name: `m-${tag}.csv`, content: csv([['Serial', 'Make', 'Model'], [`U1-${tag}`, 'Dell', 'Latitude 5420'], [`U2-${tag}`, 'HP', 'EliteBook']]) },
        { serial: 'Serial', manufacturer: 'Make', model: 'Model' },
      )
      await advanceToReceiving(request, token, jobId)

      const markupErrors: string[] = []
      page.on('console', (message) => {
        if (message.type() === 'error' && /cannot be a descendant of|cannot contain a nested|hydration/i.test(message.text())) {
          markupErrors.push(message.text())
        }
      })

      await login(page, 'admin')
      await page.goto(`/backend/itad/jobs/${jobId}?tab=receiving`)
      const receiving = page.getByRole('region', { name: 'Receiving' })
      const field = receiving.getByRole('textbox', { name: 'Scan or type a serial number' })
      await expect(field).toBeFocused()
      const status = receiving.getByRole('status')

      const scan = async (serial: string) => {
        await field.fill(serial)
        const response = await waitForApiMutation(page, `/api/itad/jobs/${jobId}/scans`, () => field.press('Enter'))
        expect(response.status()).toBe(201)
      }

      await scan(`u1-${tag.toLowerCase()}`)
      await expect(status.getByText('Matched')).toBeVisible()
      await expect(status.getByText('Dell Latitude 5420')).toBeVisible()
      await expect(field).toHaveValue('')
      await expect(field).toBeFocused()

      await scan(`NEW-${tag}`)
      await expect(status.getByText('Unexpected')).toBeVisible()
      await expect(field).toBeFocused()

      await scan(`U1-${tag}`)
      await expect(status.getByText('Duplicate')).toBeVisible()
      const duplicates = receiving.getByRole('region', { name: 'Duplicates to resolve' })
      await expect(duplicates.getByText(`U1-${tag}`)).toBeVisible()

      await duplicates.getByRole('button', { name: 'Same device' }).click()
      const resolveDialog = page.getByRole('dialog', { name: `Same device: U1-${tag}` })
      const resolved = await waitForApiMutation(page, '/resolve', () => resolveDialog.getByRole('button', { name: 'Confirm' }).click())
      expect(resolved.status()).toBe(200)
      await expect(duplicates).toHaveCount(0)

      const assets = receiving.getByRole('row').filter({ hasText: `NEW-${tag}` })
      await assets.getByRole('button').last().click()
      await page.getByRole('menuitem', { name: 'Edit details' }).click()
      const editDialog = page.getByRole('dialog', { name: `Asset NEW-${tag}` })
      await editDialog.locator('[data-crud-field-id="model"] input').fill('Optiplex 7090')
      const saved = await waitForApiMutation(page, `/api/itad/jobs/${jobId}/assets/`, () => editDialog.getByRole('button', { name: 'Save' }).click(), 'PUT')
      expect(saved.status()).toBe(200)
      await expect(editDialog).toBeHidden()
      await expect(receiving.getByRole('row').filter({ hasText: `NEW-${tag}` }).getByText('Optiplex 7090')).toBeVisible()

      await page.reload()
      await expect(page.getByRole('region', { name: 'Receiving' }).getByText(`NEW-${tag}`)).toBeVisible()
      expect(markupErrors).toEqual([])
    } finally {
      await deleteJobIfExists(request, token, jobId)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

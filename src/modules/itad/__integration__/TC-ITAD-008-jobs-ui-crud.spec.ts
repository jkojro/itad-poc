import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { login } from '@open-mercato/core/helpers/integration/auth'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { fillControlledInput, waitForApiMutation } from '@open-mercato/core/helpers/integration/ui'
import { createJob, deleteJobIfExists, getJob, uniqueSuffix } from './itad-job-fixtures'

const JOB_URL = /\/backend\/itad\/jobs\/([0-9a-f-]{36})/

/**
 * TC-ITAD-008 (spec TEST-011, CRUD part): an operator creates a job with the customer
 * picker, lands on its detail page, edits it, sees the duplicate customer reference as an
 * inline field error, and deletes the draft from the list.
 *
 * Fields are located through `data-crud-field-id`, the stable host attribute `CrudForm`
 * itself uses for focus management — the shared form does not associate its labels with
 * the inputs (no accessible names), so label-based locators are not available.
 */
test.describe('TC-ITAD-008: ITAD jobs CRUD through the backend UI', () => {
  test('create, edit, duplicate reference error and delete', async ({ page, request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    const company = `QA ITAD UI ${suffix}`
    const reference = `UI-${suffix}`
    let companyId: string | null = null
    let jobId: string | null = null
    let otherJobId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, company)
      otherJobId = (await createJob(request, token, {
        customerId: companyId,
        name: `QA UI other ${suffix}`,
        customerReference: `${reference}-TAKEN`,
      })).id

      await login(page, 'admin')
      await page.goto('/backend/itad/jobs')
      await expect(page.getByRole('heading', { name: 'ITAD Jobs', level: 1 })).toBeVisible()
      await page.getByRole('link', { name: 'New job' }).first().click()
      await expect(page.getByRole('heading', { name: 'New ITAD job', level: 1 })).toBeVisible()

      await page.locator('[data-crud-field-id="customerId"]').getByRole('combobox').click()
      await page.getByRole('option', { name: company }).click()
      await fillControlledInput(page.locator('[data-crud-field-id="name"] input'), `QA UI job ${suffix}`)
      await fillControlledInput(page.locator('[data-crud-field-id="customerReference"] input'), reference)
      const created = await waitForApiMutation(page, '/api/itad/jobs', () =>
        page.getByRole('button', { name: 'Create job' }).first().click(),
      )
      expect(created.status()).toBe(201)

      await page.waitForURL(JOB_URL)
      jobId = JOB_URL.exec(page.url())?.[1] ?? null
      const job = await getJob(request, token, jobId!)
      await expect(page.getByRole('heading', { name: `${job!.internalReference} · QA UI job ${suffix}`, level: 1 })).toBeVisible()
      await expect(page.getByRole('definition').filter({ hasText: 'Draft' })).toBeVisible()
      await expect(page.getByRole('link', { name: company })).toBeVisible()

      await fillControlledInput(page.locator('[data-crud-field-id="name"] input'), `QA UI job renamed ${suffix}`)
      const saved = await waitForApiMutation(
        page,
        '/api/itad/jobs',
        () => page.getByRole('button', { name: 'Save' }).first().click(),
        'PUT',
      )
      expect(saved.status()).toBe(200)
      await expect.poll(async () => (await getJob(request, token, jobId!))?.name).toBe(`QA UI job renamed ${suffix}`)

      await page.goto(`/backend/itad/jobs/${jobId}`)
      await expect(page.getByRole('heading', { name: `${job!.internalReference} · QA UI job renamed ${suffix}`, level: 1 })).toBeVisible()
      await fillControlledInput(page.locator('[data-crud-field-id="customerReference"] input'), `${reference}-taken`)
      const duplicate = await waitForApiMutation(
        page,
        '/api/itad/jobs',
        () => page.getByRole('button', { name: 'Save' }).first().click(),
        'PUT',
      )
      expect(duplicate.status()).toBe(409)
      await expect(
        page.locator('[data-crud-field-id="customerReference"]').getByText('Another job in this organization already uses this customer reference'),
      ).toBeVisible()

      await page.goto('/backend/itad/jobs')
      await page.getByRole('searchbox', { name: 'Search by reference or name' }).fill(job!.internalReference)
      const row = page.getByRole('row').filter({ hasText: job!.internalReference })
      await expect(row).toBeVisible()
      await row.getByRole('button').last().click()
      await page.getByRole('menuitem', { name: 'Delete' }).click()
      const removed = await waitForApiMutation(
        page,
        '/api/itad/jobs',
        () => page.getByRole('alertdialog').getByRole('button', { name: /delete|confirm/i }).click(),
        'DELETE',
      )
      expect(removed.status()).toBe(200)
      await expect(page.getByRole('row').filter({ hasText: job!.internalReference })).toHaveCount(0)
      jobId = null
    } finally {
      await deleteJobIfExists(request, token, jobId)
      await deleteJobIfExists(request, token, otherJobId)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

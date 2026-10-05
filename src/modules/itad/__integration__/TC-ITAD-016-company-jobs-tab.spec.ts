import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { login } from '@open-mercato/core/helpers/integration/auth'
import {
  createRoleFixture,
  createUserFixture,
  deleteRoleIfExists,
  deleteUserIfExists,
  setRoleAclFeatures,
} from '@open-mercato/core/helpers/integration/authFixtures'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { getTokenContext } from '@open-mercato/core/helpers/integration/generalFixtures'
import { createJob, deleteJobIfExists, loginAs, uniqueSuffix } from './itad-job-fixtures'

/**
 * TC-ITAD-016 (spec TEST-012, REQ-009): the injected "ITAD Jobs" tab on the customers
 * company detail pages — the current one the companies list links to
 * (`/backend/customers/companies-v2/[id]`) and the legacy one — lists only that company's jobs, shows an empty state with
 * "New job", "New job" opens the create form with the company preselected, and the
 * tab is not rendered for a user without `itad.jobs.view`.
 */
test.describe('TC-ITAD-016: ITAD Jobs tab on the company detail page', () => {
  test('lists the company jobs, empty state, preselected create, hidden without feature', async ({ page, request }) => {
    const adminToken = await getAuthToken(request, 'admin')
    const { tenantId, organizationId } = getTokenContext(adminToken)
    const suffix = uniqueSuffix()
    const companyName = `QA ITAD Tab ${suffix}`
    const companyIds: string[] = []
    const jobIds: string[] = []
    let roleId: string | null = null
    let userId: string | null = null
    try {
      const companyId = await createCompanyFixture(request, adminToken, companyName)
      const otherId = await createCompanyFixture(request, adminToken, `QA ITAD Tab Other ${suffix}`)
      const emptyId = await createCompanyFixture(request, adminToken, `QA ITAD Tab Empty ${suffix}`)
      companyIds.push(companyId, otherId, emptyId)
      const mine = await createJob(request, adminToken, { customerId: companyId, name: `QA tab mine ${suffix}` })
      const theirs = await createJob(request, adminToken, { customerId: otherId, name: `QA tab theirs ${suffix}` })
      jobIds.push(mine.id, theirs.id)

      await login(page, 'admin')
      // Legacy page: the tab is present too.
      await page.goto(`/backend/customers/companies/${companyId}`)
      await page.getByRole('tab', { name: 'ITAD Jobs' }).click()
      await expect(page.getByRole('row').filter({ hasText: mine.internalReference })).toBeVisible()

      // Current page (target of the companies list).
      await page.goto(`/backend/customers/companies-v2/${companyId}`)
      await page.getByRole('tab', { name: 'ITAD Jobs' }).click()
      await expect(page.getByRole('heading', { name: 'ITAD jobs of this company' })).toBeVisible()
      await expect(page.getByRole('row').filter({ hasText: mine.internalReference })).toBeVisible()
      await expect(page.getByRole('row').filter({ hasText: theirs.internalReference })).toHaveCount(0)

      await page.getByRole('link', { name: 'New job' }).first().click()
      await page.waitForURL(/\/backend\/itad\/jobs\/create\?customerId=/)
      expect(new URL(page.url()).searchParams.get('customerId')).toBe(companyId)
      await expect(page.locator('[data-crud-field-id="customerId"]').getByRole('combobox')).toContainText(companyName)

      await page.goto(`/backend/customers/companies-v2/${emptyId}`)
      await page.getByRole('tab', { name: 'ITAD Jobs' }).click()
      await expect(page.getByText('No ITAD jobs for this company')).toBeVisible()

      const roleName = `qa_itad_crm_only_${suffix.replace(/[^a-z0-9]/gi, '_')}`
      roleId = await createRoleFixture(request, adminToken, { name: roleName, tenantId })
      await setRoleAclFeatures(request, adminToken, { roleId, features: ['customers.companies.view'] })
      const email = `qa-itad-crm-${suffix}@example.test`
      const password = `Qa-${suffix}-Secret!`
      userId = await createUserFixture(request, adminToken, { email, password, organizationId, roles: [roleName] })

      // Leave the app before switching users: a still-mounted backend page reacts to the
      // cleared session with its own redirect, which would abort the next navigation.
      await page.goto('about:blank')
      await page.context().clearCookies()
      await loginAs(page, email, password)
      await page.goto(`/backend/customers/companies-v2/${companyId}`)
      await expect(page.getByRole('heading', { name: companyName })).toBeVisible()
      await expect(page.getByRole('tab', { name: 'ITAD Jobs' })).toHaveCount(0)
    } finally {
      await deleteUserIfExists(request, adminToken, userId)
      await deleteRoleIfExists(request, adminToken, roleId)
      for (const id of jobIds) await deleteJobIfExists(request, adminToken, id)
      for (const id of companyIds) await deleteEntityIfExists(request, adminToken, '/api/customers/companies', id)
    }
  })
})

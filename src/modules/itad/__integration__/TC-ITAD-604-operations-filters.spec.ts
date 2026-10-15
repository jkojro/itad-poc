import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createOrganizationFixture, deleteOrganizationIfExists } from '@open-mercato/core/helpers/integration/authFixtures'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { getTokenContext } from '@open-mercato/core/helpers/integration/generalFixtures'
import { uniqueSuffix } from './itad-job-fixtures'
import { operations, operationsOk } from './itad-overview-fixtures'
import { createOperationsScenario } from './itad-operations-scenario'

/**
 * TC-ITAD-604 (operations dashboard spec REQ-712, REQ-717): filters by customer, status
 * (repeatable) and required conditions combine; an invalid filter is 400; another
 * organization never sees these jobs.
 */
test.describe('TC-ITAD-604: operations filters and scope', () => {
  test('customer, status, conditions, combined, scope', async ({ request }) => {
    test.setTimeout(90_000)
    const token = await getAuthToken(request, 'admin')
    const { tenantId } = getTokenContext(token)
    const suffix = uniqueSuffix()
    const tag = suffix.slice(-6).toUpperCase().replace(/[^A-Z0-9]/g, 'X')
    let companyId: string | null = null
    let orgBId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA Ops Filters ${suffix}`)
      const jobs = await createOperationsScenario(request, token, companyId, suffix, tag)
      const ids = async (query: string) => (await operationsOk(request, token, `customerId=${companyId}${query ? `&${query}` : ''}`)).items.map((item) => item.id)

      expect(await ids('failed=true')).toEqual([jobs.red.id])
      expect(await ids('openExceptions=true')).toEqual([jobs.red.id])
      expect(await ids('missingCertificates=true')).toEqual([jobs.orange.id])
      expect(await ids('missing=true')).toEqual([jobs.receiving.id])
      expect(await ids('status=receiving')).toEqual([jobs.receiving.id])
      expect(await ids('status=processing&status=closeout_review')).toEqual([jobs.red.id, jobs.orange.id])
      expect(await ids('status=processing&failed=true')).toEqual([jobs.red.id])
      expect(await ids('failed=true&missingCertificates=true')).toEqual([])
      expect(await ids('status=scheduled&status=draft')).toEqual([jobs.upcoming.id, jobs.draft.id])

      expect((await operations(request, token, 'status=completed')).status()).toBe(400)

      orgBId = await createOrganizationFixture(request, token, { name: `QA Ops Org B ${suffix}`, tenantId })
      const other = await operationsOk(request, token, `customerId=${companyId}`, orgBId)
      expect(other.items).toEqual([])
      expect(other.customers.map((customer) => customer.id)).not.toContain(companyId)
    } finally {
      await deleteOrganizationIfExists(request, token, orgBId)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

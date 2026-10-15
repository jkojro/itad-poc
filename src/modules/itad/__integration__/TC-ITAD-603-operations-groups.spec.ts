import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { uniqueSuffix } from './itad-job-fixtures'
import { operationsOk } from './itad-overview-fixtures'
import { createOperationsScenario } from './itad-operations-scenario'

/**
 * TC-ITAD-603 (operations dashboard spec REQ-711, REQ-721, AC-707, AC-709): active jobs
 * come grouped and sorted by need for action — red, orange, in progress, upcoming, draft.
 * Missing certificates in closeout are orange; receiving 3 of 5 is progress, not attention.
 */
test.describe('TC-ITAD-603: operations groups and order', () => {
  test('red, orange, in progress, upcoming, draft', async ({ request }) => {
    test.setTimeout(90_000)
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    const tag = suffix.slice(-6).toUpperCase().replace(/[^A-Z0-9]/g, 'X')
    let companyId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA Ops Groups ${suffix}`)
      const jobs = await createOperationsScenario(request, token, companyId, suffix, tag)

      const body = await operationsOk(request, token, `customerId=${companyId}`)
      expect(body.items.map((item) => item.id)).toEqual([jobs.red.id, jobs.orange.id, jobs.receiving.id, jobs.upcoming.id, jobs.draft.id])
      expect(body.items.map((item) => item.group)).toEqual(['attention_red', 'attention_orange', 'in_progress', 'upcoming', 'draft'])

      const [red, orange, receiving] = body.items
      expect(red.signals).toEqual([expect.objectContaining({ key: 'failed', severity: 'red', count: 1 })])
      expect(orange.signals).toEqual([expect.objectContaining({ key: 'certificates_missing', severity: 'orange', count: 1 })])
      expect(orange.signals[0].href).toBe(`/backend/itad/jobs/${jobs.orange.id}?tab=documents`)
      expect(receiving.counters).toMatchObject({ expected: 5, received: 3, missing: 2 })
      expect(receiving).toMatchObject({ severity: 'none', signals: [] })
      expect(body.customers).toContainEqual({ id: companyId, name: `QA Ops Groups ${suffix}` })
      expect(body.truncated).toBe(false)
    } finally {
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

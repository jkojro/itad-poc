import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { uniqueSuffix } from './itad-job-fixtures'
import { createOperationsScenario } from './itad-operations-scenario'
import { aiToolOk } from './itad-ai-fixtures'

/**
 * TC-ITAD-807 (AI assistant spec AI-REQ-19, Q7): focus today applies only the filters the
 * user stated, with the operations semantics, and echoes them. Page context for the job
 * and asset pages is covered by the `resolvePageContext` unit test.
 */
test.describe('TC-ITAD-807: AI focus filters', () => {
  test('stated filters narrow the result and are echoed', async ({ request }) => {
    test.setTimeout(120_000)
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    const tag = suffix.slice(-6).toUpperCase().replace(/[^A-Z0-9]/g, 'X')
    let companyId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA AI Filters ${suffix}`)
      const jobs = await createOperationsScenario(request, token, companyId, suffix, tag)

      const failed = await aiToolOk(request, token, 'itad.get_focus_today', { filters: { customerId: companyId, failed: true } })
      expect(failed.appliedFilters).toEqual({ customerId: companyId, failed: true })
      expect(failed.jobs.items.map((job: { jobId: string }) => job.jobId)).toEqual([jobs.red.id])

      const closeout = await aiToolOk(request, token, 'itad.get_focus_today', { filters: { customerId: companyId, status: 'closeout_review' } })
      expect(closeout.activeJobsConsidered).toBe(1)
      expect(closeout.jobs.items.map((job: { jobId: string }) => job.jobId)).toEqual([jobs.orange.id])

      const receiving = await aiToolOk(request, token, 'itad.get_focus_today', { filters: { customerId: companyId, status: 'receiving' } })
      expect(receiving).toMatchObject({ activeJobsConsidered: 1, jobs: { items: [], total: 0 } })
    } finally {
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { uniqueSuffix } from './itad-job-fixtures'
import { createOperationsScenario } from './itad-operations-scenario'
import { aiToolOk } from './itad-ai-fixtures'

type Gate = { gate: string; state: string; blocking?: { items?: Array<{ label: string }>; total?: number; hidden?: string } }
type Action = { action: string; ready: boolean; gates: Gate[] }

/**
 * TC-ITAD-802 (AI assistant spec AC-AI-02, AI-REQ-04): "Why can't I complete …?" checks
 * every gate of the forward actions and names the blocking records; a job is ready only
 * when every gate of the action is met.
 */
test.describe('TC-ITAD-802: AI job blockers', () => {
  test('unmet gates with blocking records; ready only when all gates are met', async ({ request }) => {
    test.setTimeout(120_000)
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    const tag = suffix.slice(-6).toUpperCase().replace(/[^A-Z0-9]/g, 'X')
    let companyId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA AI Blockers ${suffix}`)
      const jobs = await createOperationsScenario(request, token, companyId, suffix, tag)

      const closeout = await aiToolOk(request, token, 'itad.get_job_blockers', { jobId: jobs.orange.id })
      expect(closeout).toMatchObject({ found: true, status: 'closeout_review', reference: jobs.orange.internalReference })
      const complete = (closeout.actions as Action[]).find((action) => action.action === 'complete')!
      expect(complete.ready).toBe(false)
      const documents = complete.gates.find((gate) => gate.gate === 'requiredDocumentsComplete')!
      expect(documents).toMatchObject({ state: 'unmet', blocking: { total: 1 } })
      expect(documents.blocking!.items![0].label).toMatch(/^SD1/)
      expect((closeout.actions as Action[]).map((action) => action.action)).not.toContain('cancel')

      const processing = await aiToolOk(request, token, 'itad.get_job_blockers', { jobId: jobs.red.id })
      const closeoutStart = (processing.actions as Action[]).find((action) => action.action === 'start_closeout')!
      expect(closeoutStart.ready).toBe(false)
      const sanitization = closeoutStart.gates.find((gate) => gate.gate === 'allAssetsProcessed')!
      expect(sanitization.blocking!.items![0].label).toContain('review_required')

      const draft = await aiToolOk(request, token, 'itad.get_job_blockers', { jobId: jobs.draft.id })
      expect((draft.actions as Action[]).find((action) => action.action === 'schedule')).toMatchObject({
        ready: true,
        gates: [expect.objectContaining({ gate: 'schedulingDataComplete', state: 'met' })],
      })
    } finally {
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

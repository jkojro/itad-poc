import { test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { seedDashboardDemo } from './itad-dashboard-demo-fixtures'

/**
 * Seeds the operations dashboard demo (7 customers / jobs stopped at their demo states)
 * into the environment at BASE_URL. Skipped unless asked for, so test runs never leave demo
 * data behind; run it on an empty organization:
 *
 *   ITAD_SEED_DASHBOARD_DEMO=1 BASE_URL=http://localhost:3000 npx playwright test \
 *     --config .ai/qa/tests/playwright.config.ts seed-dashboard-demo --retries=0
 */
test.describe('Seed the operations dashboard demo', () => {
  test.skip(process.env.ITAD_SEED_DASHBOARD_DEMO !== '1', 'Set ITAD_SEED_DASHBOARD_DEMO=1 to seed the demo data')

  test('creates the demo customers and jobs', async ({ request }) => {
    test.setTimeout(600_000)
    const token = await getAuthToken(request, 'admin')
    const jobs = await seedDashboardDemo(request, token)
    console.log(['Operations dashboard demo:', ...jobs.map((job) => `- ${job.customer} — ${job.job}: ${job.reference} (${job.status}) /backend/itad/jobs/${job.jobId}`)].join('\n'))
  })
})

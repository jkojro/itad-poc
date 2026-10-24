import { test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { seedAiDemo } from './itad-ai-demo-fixtures'

/**
 * Seeds the AI assistant demo (PDF §8 steps 1–4) into the environment at BASE_URL. Skipped
 * unless asked for, so test runs never leave demo data behind:
 *
 *   ITAD_SEED_AI_DEMO=1 BASE_URL=http://localhost:3000 npx playwright test \
 *     --config .ai/qa/tests/playwright.config.ts seed-ai-demo --retries=0
 */
test.describe('Seed the AI assistant demo', () => {
  test.skip(process.env.ITAD_SEED_AI_DEMO !== '1', 'Set ITAD_SEED_AI_DEMO=1 to seed the demo data')

  test('creates the demo jobs', async ({ request }) => {
    test.setTimeout(300_000)
    const token = await getAuthToken(request, 'admin')
    const demo = await seedAiDemo(request, token)
    console.log(
      [
        `AI assistant demo — customer "${demo.customer}"`,
        `1. Focus today: ${demo.failedWipe.reference} (failed wipe), ${demo.missingDevice.reference} (missing ${demo.missingDevice.serial})`,
        `2. Why can't I complete ${demo.closeout.reference}? (2 missing certificates: ${demo.closeout.serials.join(', ')})`,
        `3. Approve a retry for ${demo.failedWipe.serial} (${demo.failedWipe.reference})`,
        `4. Assign all open sanitization failures on ${demo.failures.reference} to me (${demo.failures.openSerials.length} open, ${demo.failures.resolvedSerial} resolved)`,
      ].join('\n'),
    )
  })
})

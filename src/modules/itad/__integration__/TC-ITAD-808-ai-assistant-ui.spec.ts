import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { createSchedulableJob, loginAs, uniqueSuffix } from './itad-job-fixtures'
import { processingJobWithDataBearingAssets } from './itad-sanitization-fixtures'

/**
 * TC-ITAD-808 (AI assistant spec AI-REQ-18, AI-REQ-19, Q8): the job page has a collapsed
 * assistant panel; the job page, the asset page and the dashboard offer "Ask the page assistant".
 * Covers both environments (the provider comes from `.env`):
 * - without an AI provider the panel says so, the buttons are disabled, the pages work as before;
 * - with one, the panel keeps its own conversation per job — never the agent's legacy
 *   conversation another page left behind, the same one when the job is reopened — and the
 *   buttons are enabled. No message is sent, so no model is called.
 */
test.describe('TC-ITAD-808: AI assistant UI', () => {
  test('panel on the job page, ask buttons, not-configured state or a conversation per job', async ({ page, request }) => {
    test.setTimeout(120_000)
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    let companyId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA AI UI ${suffix}`)
      const job = await createSchedulableJob(request, token, companyId, `QA AI UI ${suffix}`)
      const [asset] = await processingJobWithDataBearingAssets(request, token, job.id, 1)
      await loginAs(page, 'admin@acme.com', 'secret')

      await page.goto(`/backend/itad/jobs/${job.id}`)
      await expect(page.getByTestId('itad-job-overview')).toBeVisible()
      const panel = page.getByTestId('itad-assistant-panel')
      const toggle = panel.getByRole('button', { name: 'AI assistant' })
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-expanded', 'true')
      const notConfigured = panel.getByTestId('itad-assistant-not-configured')
      const chat = panel.locator('[data-ai-chat-conversation-id]')
      await expect(notConfigured.or(chat)).toBeVisible({ timeout: 30_000 })
      const configured = await chat.isVisible()

      if (!configured) {
        // The page assistant button sits in the overview header too.
        await expect(page.getByTestId('itad-job-overview').getByTestId('itad-ask-assistant')).toBeDisabled()
        await page.goto(`/backend/itad/jobs/${job.id}/assets/${asset.id}`)
        await expect(page.getByRole('heading', { name: asset.serial })).toBeVisible()
        await expect(page.getByTestId('itad-ask-assistant')).toBeDisabled()
        await page.goto('/backend/itad')
        await expect(page.getByRole('heading', { name: 'Operations' })).toBeVisible()
        await expect(page.getByTestId('itad-ask-assistant')).toBeDisabled()
        return
      }

      await expect(page.getByTestId('itad-job-overview').getByTestId('itad-ask-assistant')).toBeEnabled()
      const conversationOf = async (jobId: string) => {
        await page.goto(`/backend/itad/jobs/${jobId}`)
        await expect(page.getByTestId('itad-job-overview')).toBeVisible()
        await panel.getByRole('button', { name: 'AI assistant' }).click()
        await expect(chat).toBeVisible({ timeout: 30_000 })
        return chat.getAttribute('data-ai-chat-conversation-id')
      }
      // A conversation another page left in the agent's legacy slot must never answer here.
      await page.evaluate(() =>
        window.localStorage.setItem('om-ai-chat:itad.operations_assistant', JSON.stringify({ v: 1, conversationId: 'legacy-other-page', messages: [] })),
      )
      const first = await conversationOf(job.id)
      expect(first).toBeTruthy()
      expect(first).not.toBe('legacy-other-page')
      const other = await createSchedulableJob(request, token, companyId, `QA AI UI other ${suffix}`)
      const second = await conversationOf(other.id)
      expect(second).not.toBe(first)
      expect(second).not.toBe('legacy-other-page')
      expect(await conversationOf(job.id)).toBe(first)

      await page.goto(`/backend/itad/jobs/${job.id}/assets/${asset.id}`)
      await expect(page.getByRole('heading', { name: asset.serial })).toBeVisible()
      await expect(page.getByTestId('itad-ask-assistant')).toBeEnabled()
      await page.goto('/backend/itad')
      await expect(page.getByRole('heading', { name: 'Operations' })).toBeVisible()
      await expect(page.getByTestId('itad-ask-assistant')).toBeEnabled()
    } finally {
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

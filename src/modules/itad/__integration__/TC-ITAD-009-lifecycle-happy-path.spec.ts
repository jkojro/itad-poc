import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import {
  CONFIRM,
  createSchedulableJob,
  errorCode,
  getJob,
  postTransition,
  transitionOk,
  uniqueSuffix,
} from './itad-job-fixtures'
import { receiveOneDevice } from './itad-flow-fixtures'

type HistoryItem = { action: string; from: string; to: string; actor: { name: string | null }; confirmations: Array<{ condition: string; comment: string }> }

/**
 * TC-ITAD-009 (spec TEST-006): a job goes draft → completed through every happy-path
 * transition; `receivingComplete` is met from data (manifest + scan, manifest spec
 * Phase 4) and the remaining manual conditions are confirmed by an admin; startedAt/completedAt are set;
 * the history holds every step with its confirmations; the completed job is terminal.
 */
test.describe('TC-ITAD-009: ITAD job lifecycle happy path', () => {
  test('draft to completed with manual confirmations and full history', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    let companyId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD Life ${suffix}`)
      const { id } = await createSchedulableJob(request, token, companyId, `QA lifecycle ${suffix}`)

      expect(await transitionOk(request, token, id, { action: 'schedule' })).toBe('scheduled')
      expect(await transitionOk(request, token, id, { action: 'dispatch' })).toBe('in_transit')
      expect((await getJob(request, token, id))?.startedAt).toBeNull()
      expect(await transitionOk(request, token, id, { action: 'start_receiving' })).toBe('receiving')
      const startedAt = (await getJob(request, token, id))?.startedAt
      expect(typeof startedAt).toBe('string')

      await receiveOneDevice(request, token, id)
      expect(await transitionOk(request, token, id, { action: 'start_processing' })).toBe('processing')
      expect(
        await transitionOk(request, token, id, { action: 'start_closeout', confirmations: [CONFIRM('allAssetsProcessed')] }),
      ).toBe('closeout_review')
      expect(
        await transitionOk(request, token, id, {
          action: 'complete',
          confirmations: [CONFIRM('noBlockingExceptions'), CONFIRM('requiredDocumentsComplete')],
        }),
      ).toBe('completed')

      const done = await getJob(request, token, id)
      expect(done?.status).toBe('completed')
      expect(done?.startedAt).toBe(startedAt)
      expect(typeof done?.completedAt).toBe('string')
      expect(done?.editableFields).toEqual([])

      const history = await apiRequest(request, 'GET', `/api/itad/jobs/${id}/history`, { token })
      expect(history.status()).toBe(200)
      const items = (await readJsonSafe<{ items: HistoryItem[] }>(history))?.items ?? []
      expect(items.map((item) => item.action)).toEqual([
        'complete', 'start_closeout', 'start_processing', 'start_receiving', 'dispatch', 'schedule',
      ])
      expect(items[0].confirmations.map((entry) => entry.condition).sort()).toEqual(['noBlockingExceptions', 'requiredDocumentsComplete'])
      // receivingComplete is a data condition: start_processing carries no manual confirmation.
      expect(items[2].confirmations).toEqual([])
      // Names are decrypted display values, never stored ciphertext (`iv:data:tag:v1`).
      for (const item of items) {
        expect(typeof item.actor.name).toBe('string')
        expect(item.actor.name).not.toMatch(/:v\d+$/)
      }

      const available = await apiRequest(request, 'GET', `/api/itad/jobs/${id}/transitions`, { token })
      expect((await readJsonSafe<{ actions: unknown[] }>(available))?.actions).toEqual([])

      const again = await postTransition(request, token, id, { action: 'cancel', reason: 'too late' })
      expect(again.status()).toBe(409)
      expect(await errorCode(again)).toBe('itad.jobs.errors.terminal')
      const edit = await apiRequest(request, 'PUT', '/api/itad/jobs', { token, data: { id, name: 'renamed' } })
      expect(edit.status()).toBe(409)
      expect(await errorCode(edit)).toBe('itad.jobs.errors.terminal')
    } finally {
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

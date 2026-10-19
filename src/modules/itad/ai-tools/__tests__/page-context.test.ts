import { describe, expect, it, jest } from '@jest/globals'
import type { AiAgentPageContextInput } from '@open-mercato/ai-assistant/modules/ai_assistant/lib/ai-agent-definition'

const pendingActions: Array<Record<string, unknown>> = []
jest.mock('@open-mercato/ai-assistant/modules/ai_assistant/data/repositories/AiPendingActionRepository', () => ({
  AiPendingActionRepository: jest.fn().mockImplementation(() => ({ listPendingForAgent: async () => pendingActions })),
}))

import aiAgents from '../../ai-agents'
import { ITAD_ASSET_ENTITY_ID, ITAD_JOB_ENTITY_ID } from '../../lib/constants'

/** AI assistant spec AI-REQ-19: "this job" / "this device" only for a record the user may read. */
describe('itad.operations_assistant resolvePageContext', () => {
  const resolve = aiAgents[0].resolvePageContext!
  const job = { id: 'job-1', organizationId: 'org-1', internalReference: 'ITAD-2026-00042', status: 'processing' }
  const asset = { id: 'asset-1', organizationId: 'org-1', serial: 'SN-42', job }

  function input(entityType: string, recordId: string, options: { record: unknown; allowed: boolean }): AiAgentPageContextInput {
    const findOne = jest.fn(async () => options.record)
    const userHasAllFeatures = jest.fn(async () => options.allowed)
    const container = {
      resolve: (name: string) => (name === 'em' ? { fork: () => ({ findOne }) } : { userHasAllFeatures }),
    }
    return { entityType, recordId, container, tenantId: 'tenant-1', organizationId: 'org-1', userId: 'user-1' } as unknown as AiAgentPageContextInput
  }

  it('names the open job and its id', async () => {
    const text = await resolve(input(ITAD_JOB_ENTITY_ID, 'job-1', { record: job, allowed: true }))
    expect(text).toContain('ITAD-2026-00042')
    expect(text).toContain('jobId: job-1')
  })

  it('names the open asset with its job', async () => {
    const text = await resolve(input(ITAD_ASSET_ENTITY_ID, 'asset-1', { record: asset, allowed: true }))
    expect(text).toContain('SN-42')
    expect(text).toContain('assetId: asset-1')
    expect(text).toContain('jobId: job-1')
  })

  it('tells the agent it is on the Operations Dashboard, without opening a job', async () => {
    const text = await resolve(input('itad:operations_dashboard', 'operations', { record: null, allowed: false }))
    expect(text).toContain('Operations Dashboard')
    expect(text).toContain('itad.get_focus_today')
  })

  it('states the current time and which of the user\'s changes really await Confirm', async () => {
    pendingActions.length = 0
    const none = await resolve(input(ITAD_JOB_ENTITY_ID, 'job-1', { record: job, allowed: true }))
    expect(none).toMatch(/The current time is \d{4}-\d{2}-\d{2}T/)
    // A cancelled or expired preview is not pending: the model must propose again.
    expect(none).toContain('No change of this user awaits confirmation')
    const future = new Date(Date.now() + 600_000)
    pendingActions.push(
      { toolName: 'itad.reschedule_pickup', targetRecordId: 'job-1', createdByUserId: 'user-1', expiresAt: future },
      { toolName: 'itad.resolve_exception', targetRecordId: 'job-2', createdByUserId: 'someone-else', expiresAt: future },
      { toolName: 'itad.resolve_exception', targetRecordId: 'job-3', createdByUserId: 'user-1', expiresAt: new Date(Date.now() - 1000) },
    )
    const one = await resolve(input(ITAD_JOB_ENTITY_ID, 'job-1', { record: job, allowed: true }))
    expect(one).toContain("Changes awaiting the user's Confirm now: itad.reschedule_pickup for record job-1.")
    expect(one).not.toContain('job-2')
    expect(one).not.toContain('job-3')
    pendingActions.length = 0
  })

  it('gives no context for a record the user may not read, a missing record or another entity type', async () => {
    expect(await resolve(input(ITAD_JOB_ENTITY_ID, 'job-1', { record: job, allowed: false }))).toBeNull()
    expect(await resolve(input(ITAD_JOB_ENTITY_ID, 'job-1', { record: null, allowed: true }))).toBeNull()
    expect(await resolve(input('customers:customer_entity', 'x', { record: job, allowed: true }))).toBeNull()
  })
})

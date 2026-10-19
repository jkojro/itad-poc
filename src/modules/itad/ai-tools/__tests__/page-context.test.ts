import { describe, expect, it, jest } from '@jest/globals'
import type { AiAgentPageContextInput } from '@open-mercato/ai-assistant/modules/ai_assistant/lib/ai-agent-definition'
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

  it('gives no context for a record the user may not read, a missing record or another entity type', async () => {
    expect(await resolve(input(ITAD_JOB_ENTITY_ID, 'job-1', { record: job, allowed: false }))).toBeNull()
    expect(await resolve(input(ITAD_JOB_ENTITY_ID, 'job-1', { record: null, allowed: true }))).toBeNull()
    expect(await resolve(input('customers:customer_entity', 'x', { record: job, allowed: true }))).toBeNull()
  })
})

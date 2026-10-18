import { describe, expect, it, jest } from '@jest/globals'

// The write path pulls in the request container; registration only needs the definitions.
jest.mock('../_writes', () => ({ requireApprovedAction: jest.fn(), runApprovedWrite: jest.fn() }))

import aiTools from '../../ai-tools'
import aiAgents, { ITAD_ASSISTANT_ALLOWED_TOOLS } from '../../ai-agents'

/** AI assistant spec AI-REQ-06 / AI-REQ-07 / AI-REQ-20: an explicit allowlist, writes only behind confirmation, a loop budget. */
describe('itad.operations_assistant registration', () => {
  const [agent] = aiAgents

  it('allows exactly the ITAD tools of this phase plus meta.describe_agent', () => {
    const itadTools = aiTools.map((tool) => tool.name).sort()
    expect(itadTools).toHaveLength(13)
    expect([...ITAD_ASSISTANT_ALLOWED_TOOLS].sort()).toEqual([...itadTools, 'meta.describe_agent'].sort())
    expect(agent.allowedTools).toEqual([...ITAD_ASSISTANT_ALLOWED_TOOLS])
  })

  it('confirms every write and marks exactly the write tools as mutations with a preview', () => {
    expect(agent).toMatchObject({ id: 'itad.operations_assistant', readOnly: false, mutationPolicy: 'confirm-required' })
    const writes = aiTools.filter((tool) => tool.isMutation)
    expect(writes.map((tool) => tool.name).sort()).toEqual(['itad.reschedule_pickup', 'itad.resolve_exception'])
    for (const tool of writes) expect(typeof tool.loadBeforeRecord).toBe('function')
  })

  it('declares a loop budget', () => {
    expect(agent.loop).toEqual({ maxSteps: 8, budget: { maxToolCalls: 12, maxWallClockMs: 60_000, maxTokens: 16_000 } })
  })

  it('gives every tool a feature gate and an itad. name', () => {
    for (const tool of aiTools) {
      expect(tool.name.startsWith('itad.')).toBe(true)
      expect(tool.requiredFeatures?.length).toBeGreaterThan(0)
    }
  })

  it('accepts only positive focus filters, so "without failures" is never silently ignored', () => {
    const focus = aiTools.find((tool) => tool.name === 'itad.get_focus_today')!
    expect(focus.inputSchema.safeParse({ filters: { failed: true } }).success).toBe(true)
    expect(focus.inputSchema.safeParse({ filters: { failed: false } }).success).toBe(false)
    expect(focus.inputSchema.safeParse({}).success).toBe(true)
  })
})

import { describe, expect, it } from '@jest/globals'
import aiTools from '../../ai-tools'
import aiAgents, { ITAD_ASSISTANT_ALLOWED_TOOLS } from '../../ai-agents'

/** AI assistant spec AI-REQ-06 / AI-REQ-20: an explicit allowlist, read-only in phase 1, a loop budget. */
describe('itad.operations_assistant registration', () => {
  const [agent] = aiAgents

  it('allows exactly the ITAD tools of this phase plus meta.describe_agent', () => {
    const itadTools = aiTools.map((tool) => tool.name).sort()
    expect(itadTools).toHaveLength(11)
    expect([...ITAD_ASSISTANT_ALLOWED_TOOLS].sort()).toEqual([...itadTools, 'meta.describe_agent'].sort())
    expect(agent.allowedTools).toEqual([...ITAD_ASSISTANT_ALLOWED_TOOLS])
  })

  it('is read only in phase 1 and has no write tool', () => {
    expect(agent).toMatchObject({ id: 'itad.operations_assistant', readOnly: true, mutationPolicy: 'read-only' })
    expect(aiTools.filter((tool) => tool.isMutation)).toEqual([])
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
})

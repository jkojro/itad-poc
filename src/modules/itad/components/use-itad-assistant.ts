"use client"
import { useQuery } from '@tanstack/react-query'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { useAiAssistantAvailable } from '@open-mercato/ui/ai/useAiAssistantAvailable'

export const ITAD_ASSISTANT_AGENT_ID = 'itad.operations_assistant'

type AgentsResponse = { agents?: Array<{ id: string }>; aiConfigured?: boolean }

export type ItadAssistantState =
  | { state: 'hidden' }
  | { state: 'loading' }
  | { state: 'not_configured' }
  | { state: 'ready' }

/**
 * Whether the ITAD assistant can be offered on a page (AI assistant spec, UI states):
 * hidden without the module, the `ai_assistant.view` feature or access to the agent;
 * `not_configured` when no LLM provider is set up.
 */
export function useItadAssistant(): ItadAssistantState {
  const available = useAiAssistantAvailable()
  const agents = useQuery<AgentsResponse>({
    queryKey: ['ai-assistant-agents'],
    queryFn: async () => readApiResultOrThrow('/api/ai_assistant/ai/agents'),
    enabled: available,
    staleTime: 60_000,
    retry: false,
  })
  if (!available || agents.isError) return { state: 'hidden' }
  if (agents.isLoading || !agents.data) return { state: 'loading' }
  if (!agents.data.agents?.some((agent) => agent.id === ITAD_ASSISTANT_AGENT_ID)) return { state: 'hidden' }
  return agents.data.aiConfigured === false ? { state: 'not_configured' } : { state: 'ready' }
}

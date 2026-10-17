"use client"
import * as React from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { AiIcon } from '@open-mercato/ui/ai/AiIcon'
import { useAiDock } from '@open-mercato/ui/ai/AiDock'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { ITAD_ASSISTANT_AGENT_ID, useItadAssistant } from './use-itad-assistant'

/**
 * "Ask the assistant" (AI assistant spec Q8): opens the assistant dock with this page's
 * context, because the global launcher is page-agnostic. Hidden when the user cannot use
 * the assistant; disabled with an explanation when no AI provider is configured.
 */
export function AskAssistantButton({ pageContext }: { pageContext: Record<string, unknown> }) {
  const t = useT()
  const assistant = useItadAssistant()
  const dock = useAiDock()
  if (assistant.state === 'hidden') return null
  const notConfigured = assistant.state === 'not_configured'
  const label = t('itad.ai.ask', 'Ask the assistant')
  return (
    <Button
      type="button"
      variant="outline"
      disabled={assistant.state !== 'ready'}
      title={notConfigured ? t('itad.ai.notConfigured', 'The AI assistant is not configured. Ask an administrator to set up an AI provider.') : undefined}
      onClick={() =>
        dock.dock({
          agent: ITAD_ASSISTANT_AGENT_ID,
          label: t('itad.ai.agentLabel', 'ITAD Operations Assistant'),
          pageContext,
          placeholder: t('itad.ai.dockPlaceholder', 'Ask about ITAD operations…'),
        })
      }
      data-testid="itad-ask-assistant"
    >
      <AiIcon className="mr-2 h-4 w-4" aria-hidden />
      {label}
    </Button>
  )
}

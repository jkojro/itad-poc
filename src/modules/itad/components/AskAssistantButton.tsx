"use client"
import * as React from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { AiIcon } from '@open-mercato/ui/ai/AiIcon'
import { useAiDock } from '@open-mercato/ui/ai/AiDock'
import { useAiChatSessions } from '@open-mercato/ui/ai/AiChatSessions'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { shouldRebindDock, type ItadPageContext } from '../lib/ai-page-context'
import { ITAD_ASSISTANT_AGENT_ID, useItadAssistant } from './use-itad-assistant'

/**
 * "Ask the page assistant" (AI assistant spec Q8). Opens the assistant dock bound to this
 * page — the global launcher is page-agnostic — always with a fresh conversation, so a
 * previous page's thread never answers for this one. When the dock is already bound to
 * another ITAD page, it is re-bound here (new conversation) as soon as this page opens.
 * Hidden when the user cannot use the assistant; disabled when no AI provider is set up.
 */
export function AskAssistantButton({ pageContext, pageLabel }: { pageContext: ItadPageContext; pageLabel: string }) {
  const t = useT()
  const assistant = useItadAssistant()
  const dock = useAiDock()
  const sessions = useAiChatSessions()

  const bindHere = React.useCallback(() => {
    sessions.createSession(ITAD_ASSISTANT_AGENT_ID)
    dock.dock({
      agent: ITAD_ASSISTANT_AGENT_ID,
      label: t('itad.ai.pageAssistantLabel', 'Page assistant · {page}', { page: pageLabel }),
      pageContext,
      placeholder: t('itad.ai.dockPlaceholder', 'Ask about ITAD operations…'),
    })
  }, [dock, pageContext, pageLabel, sessions, t])

  const docked = dock.state.assistant
  const rebind = assistant.state === 'ready' && shouldRebindDock(docked, ITAD_ASSISTANT_AGENT_ID, pageContext)
  React.useEffect(() => {
    if (rebind) bindHere()
  }, [rebind, bindHere])

  if (assistant.state === 'hidden') return null
  const notConfigured = assistant.state === 'not_configured'
  return (
    <Button
      type="button"
      variant="outline"
      disabled={assistant.state !== 'ready'}
      title={notConfigured ? t('itad.ai.notConfigured', 'The AI assistant is not configured. Ask an administrator to set up an AI provider.') : undefined}
      onClick={bindHere}
      data-testid="itad-ask-assistant"
    >
      <AiIcon className="mr-2 h-4 w-4" aria-hidden />
      {t('itad.ai.ask', 'Ask the page assistant')}
    </Button>
  )
}

"use client"
import * as React from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { AiIcon } from '@open-mercato/ui/ai/AiIcon'
import { useAiDock } from '@open-mercato/ui/ai/AiDock'
import { useAiChatSessions } from '@open-mercato/ui/ai/AiChatSessions'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { shouldRebindDock, type ItadPageContext } from '../lib/ai-page-context'
import { ITAD_ASSISTANT_AGENT_ID, useItadAssistant } from './use-itad-assistant'
import { CLEANUP_DELAY_MS, closeEmptyAssistantTabs, openPageConversation, pageKey, useOrganizationScopeReady } from './page-assistant-session'

/**
 * "Ask the page assistant" (AI assistant spec Q8). Opens the assistant dock bound to this
 * page — the global launcher is page-agnostic — with this page's own conversation, so a
 * previous page's thread never answers for this one. One conversation per page, at most
 * one open page-assistant tab: leaving a page closes its tab into the dock's history
 * (named after the page), coming back reopens it. Tabs the user opened are left alone.
 * When the dock is bound to another ITAD page, it is re-bound here as soon as this page
 * opens. Hidden when the user cannot use the assistant; disabled without an AI provider.
 */
export function AskAssistantButton({ pageContext, pageLabel }: { pageContext: ItadPageContext; pageLabel: string }) {
  const t = useT()
  const assistant = useItadAssistant()
  const dock = useAiDock()
  const sessions = useAiChatSessions()
  const scopeReady = useOrganizationScopeReady()
  // Async work (cleanup) must see the latest tabs, not the ones of the render that started it.
  const sessionsRef = React.useRef(sessions)
  sessionsRef.current = sessions

  const bindHere = React.useCallback(() => {
    openPageConversation(sessionsRef, pageContext, pageLabel)
    dock.dock({
      agent: ITAD_ASSISTANT_AGENT_ID,
      label: t('itad.ai.pageAssistantLabel', 'Page assistant · {page}', { page: pageLabel }),
      pageContext,
      placeholder: t('itad.ai.dockPlaceholder', 'Ask about ITAD operations…'),
    })
  }, [dock, pageContext, pageLabel, t])

  const docked = dock.state.assistant
  const rebind = scopeReady && assistant.state === 'ready' && shouldRebindDock(docked, ITAD_ASSISTANT_AGENT_ID, pageContext)
  // Re-bind once per page: effects can run twice before the dock and session state settle
  // (React strict mode, re-renders), and a second run would open a second tab.
  const autoBoundKey = React.useRef<string | null>(null)
  const key = pageKey(pageContext)
  React.useEffect(() => {
    if (!rebind || autoBoundKey.current === key) return
    autoBoundKey.current = key
    bindHere()
  }, [rebind, key, bindHere])

  // Dock already bound to this page (e.g. after a reload): only tidy the default tabs.
  const boundHere =
    scopeReady && assistant.state === 'ready' && docked?.agent === ITAD_ASSISTANT_AGENT_ID && !rebind && docked.pageContext?.recordId === pageContext.recordId
  React.useEffect(() => {
    if (!boundHere) return
    // Idempotent, so a repeated effect run (strict mode) is harmless.
    const timer = window.setTimeout(() => void closeEmptyAssistantTabs(sessionsRef, null), CLEANUP_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [boundHere, key])

  if (assistant.state === 'hidden') return null
  const notConfigured = assistant.state === 'not_configured'
  return (
    <Button
      type="button"
      variant="outline"
      disabled={assistant.state !== 'ready' || !scopeReady}
      title={notConfigured ? t('itad.ai.notConfigured', 'The AI assistant is not configured. Ask an administrator to set up an AI provider.') : undefined}
      onClick={bindHere}
      data-testid="itad-ask-assistant"
    >
      <AiIcon className="mr-2 h-4 w-4" aria-hidden />
      {t('itad.ai.ask', 'Ask the page assistant')}
    </Button>
  )
}

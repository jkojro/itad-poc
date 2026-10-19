"use client"
import * as React from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { AiIcon } from '@open-mercato/ui/ai/AiIcon'
import { useAiDock } from '@open-mercato/ui/ai/AiDock'
import { useAiChatSessions } from '@open-mercato/ui/ai/AiChatSessions'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { shouldRebindDock, type ItadPageContext } from '../lib/ai-page-context'
import { ITAD_ASSISTANT_AGENT_ID, useItadAssistant } from './use-itad-assistant'

/** Per-browser map page → conversation tab of the page assistant (a convenience; safe to lose). */
const PAGE_SESSIONS_KEY = 'itad-ai-page-sessions-v1'

function readPageSessions(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(PAGE_SESSIONS_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

/** Same bound as the dock's history: older page conversations drop out of both. */
const PAGE_SESSIONS_LIMIT = 50

function writePageSessions(map: Record<string, string>): void {
  try {
    const kept = Object.fromEntries(Object.entries(map).slice(-PAGE_SESSIONS_LIMIT))
    window.localStorage.setItem(PAGE_SESSIONS_KEY, JSON.stringify(kept))
  } catch {
    // Storage unavailable: the page assistant still works, it just starts a new tab next time.
  }
}

const pageKey = (context: ItadPageContext) => `${context.pageId}:${context.recordId}`

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

  const bindHere = React.useCallback(() => {
    const map = readPageSessions()
    const key = pageKey(pageContext)
    const pageSessionIds = new Set(Object.values(map))
    const active = sessions.getActiveSession(ITAD_ASSISTANT_AGENT_ID)
    // Close the previous page's tab (ours only) into history instead of piling up tabs.
    if (active && pageSessionIds.has(active.id) && map[key] !== active.id) sessions.closeSession(active.id)
    const known = map[key]
      ? [...sessions.getOpenSessions(ITAD_ASSISTANT_AGENT_ID), ...sessions.getClosedSessions(ITAD_ASSISTANT_AGENT_ID)].find((session) => session.id === map[key])
      : undefined
    if (known?.status === 'closed') sessions.reopenSession(known.id)
    else if (known) sessions.setActiveSession(known.id)
    else {
      const created = sessions.createSession(ITAD_ASSISTANT_AGENT_ID)
      sessions.renameSession(created.id, pageLabel)
      writePageSessions({ ...map, [key]: created.id })
    }
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

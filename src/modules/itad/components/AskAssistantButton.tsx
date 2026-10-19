"use client"
import * as React from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { AiIcon } from '@open-mercato/ui/ai/AiIcon'
import { useAiDock } from '@open-mercato/ui/ai/AiDock'
import { useAiChatSessions } from '@open-mercato/ui/ai/AiChatSessions'
import { listAiServerConversations, updateAiServerConversation } from '@open-mercato/ui/ai/conversation-store'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { getCurrentOrganizationScope, subscribeOrganizationScopeChanged } from '@open-mercato/shared/lib/frontend/organizationEvents'
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
 * The dock's tabs are stored per tenant and organization; on a full page load they start in
 * a temporary unscoped bucket until the topbar resolves the scope. Binding before that would
 * close and open tabs in the wrong bucket (and leave a stray default tab in the real one).
 */
function useOrganizationScopeReady(): boolean {
  const [ready, setReady] = React.useState(() => Boolean(getCurrentOrganizationScope().tenantId))
  React.useEffect(() => {
    if (getCurrentOrganizationScope().tenantId) setReady(true)
    return subscribeOrganizationScopeChanged((detail) => setReady(Boolean(detail.tenantId)))
  }, [])
  return ready
}

/**
 * "Ask the page assistant" (AI assistant spec Q8). Opens the assistant dock bound to this
 * page — the global launcher is page-agnostic — with this page's own conversation, so a
 * previous page's thread never answers for this one. One conversation per page, at most
 * one open page-assistant tab: leaving a page closes its tab into the dock's history
 * (named after the page), coming back reopens it. Tabs the user opened are left alone.
 * When the dock is bound to another ITAD page, it is re-bound here as soon as this page
 * opens. Hidden when the user cannot use the assistant; disabled without an AI provider.
 */
/** Lets the framework finish creating the default tab it opens on a full page load. */
const CLEANUP_DELAY_MS = 2000

/**
 * Closes open assistant conversations that are empty and untitled — default tabs the dock
 * opens on its own (e.g. on every full page load) and leftovers of earlier pages. A
 * conversation with any message or a title is never touched; nothing is lost.
 */
async function closeEmptyAssistantTabs(
  sessionsRef: React.MutableRefObject<ReturnType<typeof useAiChatSessions>>,
  keepConversationId: string | null,
): Promise<void> {
  const conversations = await listAiServerConversations({ limit: 100 }).catch(() => null)
  if (!conversations) return
  const sessions = sessionsRef.current
  const open = sessions.getOpenSessions(ITAD_ASSISTANT_AGENT_ID)
  const active = sessions.getActiveSession(ITAD_ASSISTANT_AGENT_ID)
  for (const conversation of conversations) {
    if (conversation.agentId !== ITAD_ASSISTANT_AGENT_ID || conversation.status !== 'open') continue
    if (conversation.isOwner === false || conversation.lastMessageAt || conversation.title) continue
    if (conversation.conversationId === keepConversationId || conversation.conversationId === active?.conversationId) continue
    const local = open.find((session) => session.conversationId === conversation.conversationId)
    if (local) sessions.closeSession(local.id)
    else await updateAiServerConversation(conversation.conversationId, { status: 'closed' }).catch(() => null)
  }
}

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
    const map = readPageSessions()
    const key = pageKey(pageContext)
    const pageSessionIds = new Set(Object.values(map))
    const active = sessions.getActiveSession(ITAD_ASSISTANT_AGENT_ID)
    // Close the previous page's tab (ours only) into history instead of piling up tabs.
    if (active && pageSessionIds.has(active.id) && map[key] !== active.id) sessions.closeSession(active.id)
    const known = map[key]
      ? [...sessions.getOpenSessions(ITAD_ASSISTANT_AGENT_ID), ...sessions.getClosedSessions(ITAD_ASSISTANT_AGENT_ID)].find((session) => session.id === map[key])
      : undefined
    let boundConversationId: string | null = known?.conversationId ?? null
    let newTitle: string | null = null
    if (known?.status === 'closed') sessions.reopenSession(known.id)
    else if (known) sessions.setActiveSession(known.id)
    else {
      const created = sessions.createSession(ITAD_ASSISTANT_AGENT_ID)
      sessions.renameSession(created.id, pageLabel)
      writePageSessions({ ...map, [key]: created.id })
      boundConversationId = created.conversationId
      newTitle = pageLabel
    }
    window.setTimeout(() => {
      // The framework's rename cannot reach the server for a tab created in the same tick
      // (and the conversation is created asynchronously), so the page name is stored here,
      // once the conversation exists; without it the tab comes back dated after a reload.
      const titled = boundConversationId && newTitle
        ? updateAiServerConversation(boundConversationId, { title: newTitle }).catch(() => null)
        : Promise.resolve(null)
      void titled.then(() => closeEmptyAssistantTabs(sessionsRef, boundConversationId))
    }, CLEANUP_DELAY_MS)
    dock.dock({
      agent: ITAD_ASSISTANT_AGENT_ID,
      label: t('itad.ai.pageAssistantLabel', 'Page assistant · {page}', { page: pageLabel }),
      pageContext,
      placeholder: t('itad.ai.dockPlaceholder', 'Ask about ITAD operations…'),
    })
  }, [dock, pageContext, pageLabel, sessions, t])

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

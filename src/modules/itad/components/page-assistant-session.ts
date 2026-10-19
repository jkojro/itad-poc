"use client"
import * as React from 'react'
import { useAiChatSessions } from '@open-mercato/ui/ai/AiChatSessions'
import { listAiServerConversations, updateAiServerConversation } from '@open-mercato/ui/ai/conversation-store'
import { getCurrentOrganizationScope, subscribeOrganizationScopeChanged } from '@open-mercato/shared/lib/frontend/organizationEvents'
import type { ItadPageContext } from '../lib/ai-page-context'
import { ITAD_ASSISTANT_AGENT_ID } from './use-itad-assistant'

/**
 * The page assistant's conversations (AI assistant spec Q8): one conversation per ITAD page
 * in the "Ask the page assistant" dock (at most one open page tab), and one per job in the
 * job page's inline panel. Works around three framework behaviours: the dock's tabs are
 * never closed or expired, a chat without a conversation id shares one legacy conversation
 * per agent across every page, and a default empty tab is opened on every full page load.
 */

export type ChatSessionsApi = ReturnType<typeof useAiChatSessions>

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

export const pageKey = (context: ItadPageContext) => `${context.pageId}:${context.recordId}`

/**
 * The dock's tabs are stored per tenant and organization; on a full page load they start in
 * a temporary unscoped bucket until the topbar resolves the scope. Binding before that would
 * close and open tabs in the wrong bucket (and leave a stray default tab in the real one).
 */
export function useOrganizationScopeReady(): boolean {
  const [ready, setReady] = React.useState(() => Boolean(getCurrentOrganizationScope().tenantId))
  React.useEffect(() => {
    if (getCurrentOrganizationScope().tenantId) setReady(true)
    return subscribeOrganizationScopeChanged((detail) => setReady(Boolean(detail.tenantId)))
  }, [])
  return ready
}

/** Lets the framework finish creating the default tab it opens on a full page load. */
export const CLEANUP_DELAY_MS = 2000

/**
 * Closes open assistant conversations that are empty and untitled — default tabs the dock
 * opens on its own (e.g. on every full page load) and leftovers of earlier pages. A
 * conversation with any message or a title is never touched; nothing is lost.
 */
export async function closeEmptyAssistantTabs(
  sessionsRef: React.MutableRefObject<ChatSessionsApi>,
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

/**
 * Activates this page's conversation tab: reopens it when the page had one, otherwise
 * creates it named after the page. The previous page's tab (ours only) closes into the
 * dock history. Returns the conversation to show. Titles and empty default tabs are
 * settled shortly after, once the server has the new conversation.
 */
export function openPageConversation(
  sessionsRef: React.MutableRefObject<ChatSessionsApi>,
  pageContext: ItadPageContext,
  pageLabel: string,
): { sessionId: string; conversationId: string } {
  const sessions = sessionsRef.current
  const map = readPageSessions()
  const key = pageKey(pageContext)
  const pageSessionIds = new Set(Object.values(map))
  const active = sessions.getActiveSession(ITAD_ASSISTANT_AGENT_ID)
  if (active && pageSessionIds.has(active.id) && map[key] !== active.id) sessions.closeSession(active.id)
  const known = map[key]
    ? [...sessions.getOpenSessions(ITAD_ASSISTANT_AGENT_ID), ...sessions.getClosedSessions(ITAD_ASSISTANT_AGENT_ID)].find((session) => session.id === map[key])
    : undefined
  let bound: { sessionId: string; conversationId: string }
  let newTitle: string | null = null
  if (known) {
    if (known.status === 'closed') sessions.reopenSession(known.id)
    else sessions.setActiveSession(known.id)
    bound = { sessionId: known.id, conversationId: known.conversationId }
  } else {
    const created = sessions.createSession(ITAD_ASSISTANT_AGENT_ID)
    sessions.renameSession(created.id, pageLabel)
    writePageSessions({ ...map, [key]: created.id })
    bound = { sessionId: created.id, conversationId: created.conversationId }
    newTitle = pageLabel
  }
  window.setTimeout(() => {
    // The framework's rename cannot reach the server for a tab created in the same tick
    // (and the conversation is created asynchronously), so the page name is stored here,
    // once the conversation exists; without it the tab comes back dated after a reload.
    const titled = newTitle ? updateAiServerConversation(bound.conversationId, { title: newTitle }).catch(() => null) : Promise.resolve(null)
    void titled.then(() => closeEmptyAssistantTabs(sessionsRef, bound.conversationId))
  }, CLEANUP_DELAY_MS)
  return bound
}

/** Per-browser map job → conversation of the job page's inline panel (a convenience; safe to lose). */
const PANEL_CONVERSATIONS_KEY = 'itad-ai-panel-conversations-v1'

function newConversationId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `itad-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * The inline panel's conversation for this job. A chat without a conversation id would
 * reuse the agent's single legacy conversation — the one last used on any page, e.g. an
 * asset — so the panel always pins its own: the same one when the job is reopened, never
 * another job's. The server creates the conversation with the first message.
 */
export function panelConversationId(jobId: string): string {
  let map: Record<string, string> = {}
  try {
    const raw = window.localStorage.getItem(PANEL_CONVERSATIONS_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    if (parsed && typeof parsed === 'object') map = parsed as Record<string, string>
  } catch {
    // Storage unavailable: a fresh conversation per visit.
  }
  if (typeof map[jobId] === 'string' && map[jobId]) return map[jobId]
  const conversationId = newConversationId()
  try {
    const kept = Object.fromEntries([...Object.entries(map), [jobId, conversationId]].slice(-PAGE_SESSIONS_LIMIT))
    window.localStorage.setItem(PANEL_CONVERSATIONS_KEY, JSON.stringify(kept))
  } catch {
    // See above.
  }
  return conversationId
}

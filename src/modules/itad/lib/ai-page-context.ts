/**
 * Page context of the ITAD page assistant (AI assistant spec Q8). The framework hydrates
 * page context only when `entityType` and `recordId` are both present, so every ITAD page
 * sends both — the dashboard uses a fixed record id that the resolver ignores. `source`
 * marks a dock opened by an ITAD page button, as opposed to the page-agnostic launcher.
 * Browser-supplied: it never grants access; the resolver re-reads the record in scope.
 */

export const ITAD_PAGE_CONTEXT_SOURCE = 'itad.page'
export const ITAD_OPERATIONS_DASHBOARD_ENTITY = 'itad:operations_dashboard'
export const ITAD_OPERATIONS_DASHBOARD_RECORD = 'operations'

export type ItadPageContext = {
  source: typeof ITAD_PAGE_CONTEXT_SOURCE
  pageId: 'itad.job' | 'itad.asset' | 'itad.operations'
  entityType: string
  recordId: string
}

export function operationsDashboardContext(): ItadPageContext {
  return {
    source: ITAD_PAGE_CONTEXT_SOURCE,
    pageId: 'itad.operations',
    entityType: ITAD_OPERATIONS_DASHBOARD_ENTITY,
    recordId: ITAD_OPERATIONS_DASHBOARD_RECORD,
  }
}

/**
 * Whether a docked assistant bound to another ITAD page must be re-bound to this page,
 * with a fresh conversation, so an answer never runs on the previous page's record.
 * A dock opened from the launcher (no ITAD page source) is left alone.
 */
export function shouldRebindDock(
  docked: { agent: string; pageContext?: Record<string, unknown> } | null | undefined,
  agentId: string,
  current: ItadPageContext,
): boolean {
  if (!docked || docked.agent !== agentId) return false
  const context = docked.pageContext ?? {}
  if (context.source !== ITAD_PAGE_CONTEXT_SOURCE) return false
  return context.pageId !== current.pageId || context.recordId !== current.recordId
}

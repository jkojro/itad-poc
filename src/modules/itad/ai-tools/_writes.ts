import type { EntityManager } from '@mikro-orm/postgresql'
import { AiPendingActionRepository } from '@open-mercato/ai-assistant/modules/ai_assistant/data/repositories/AiPendingActionRepository'
import type { AiToolDefinition } from '@open-mercato/ai-assistant/modules/ai_assistant/lib/types'
import { isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { enforceCommandOptimisticLock } from '@open-mercato/shared/lib/crud/optimistic-lock-command'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { RbacService } from '@open-mercato/core/modules/auth/services/rbacService'
import { runGuardedCommand } from '../lib/command-route'
import { loadReadableJob, resolveTrustedRecordRoute, type ItadRouteContext } from '../lib/route-context'
import { ItadToolError, routeErrorCode, type ItadToolContext } from './_shared'

/**
 * Shared execute path of the AI assistant's writes (AI assistant spec, "Re-check at
 * execute", "Audit and observability"). Runs only for a confirmed pending action:
 *
 * 1. the action exists, is this tool's, and was prepared by the confirming user;
 * 2. the confirming user still holds the tool's features in the record's organization;
 * 3. the record's job is still readable by that user (out of scope → not found);
 * 4. the record version still equals the previewed one;
 * 5. the existing ITAD command runs through the mutation guard, with the AI audit context.
 *
 * The framework's `/tools/execute` calls a tool handler directly, without approval; a
 * write handler without a confirmed pending action is therefore refused here.
 */

const logger = createLogger('itad').child({ component: 'ai-writes' })

export const ITAD_ASSISTANT_AGENT_ID = 'itad.operations_assistant'

/** Channel-neutral audit context shared with Inbox Ops (spec "Audit and observability"). */
export type ItadAiAuditContext = {
  source: 'ai'
  channel: 'chat' | 'email'
  actionId: string
  toolName: string
  origin: { type: 'user' | 'email'; userId?: string; messageId?: string }
  agentId?: string
  pendingActionId?: string
  proposalId?: string
}

export type ApprovedAction = {
  id: string
  createdByUserId: string
  recordVersion: string | null
  /** A batch action's records with the version each had in the preview. */
  records: Array<{ recordId: string; recordVersion: string | null }>
}

/** Steps 1: the confirmed pending action behind this handler call. */
export async function requireApprovedAction(ctx: ItadToolContext, tool: AiToolDefinition): Promise<ApprovedAction> {
  if (!ctx.approvedPendingActionId || !ctx.tenantId || !ctx.userId) {
    throw new ItadToolError('approval_required', 'This change needs a confirmed preview')
  }
  const em = ctx.container.resolve<EntityManager>('em').fork()
  const action = await new AiPendingActionRepository(em).getById(ctx.approvedPendingActionId, {
    tenantId: ctx.tenantId,
    organizationId: ctx.organizationId ?? null,
  })
  if (!action || action.toolName !== tool.name || action.agentId !== ITAD_ASSISTANT_AGENT_ID) {
    throw new ItadToolError('approval_required', 'This change needs a confirmed preview')
  }
  // Only the user who prepared the action may confirm it (AI-REQ-23).
  if (action.createdByUserId !== ctx.userId) {
    throw new ItadToolError('forbidden', 'Only the user who prepared this change can confirm it')
  }
  const records = Array.isArray(action.records)
    ? action.records.map((record) => ({ recordId: record.recordId, recordVersion: record.recordVersion ?? null }))
    : []
  return { id: action.id, createdByUserId: action.createdByUserId, recordVersion: action.recordVersion ?? null, records }
}

/** Key-order-independent form of a tool input, for comparing a stored input with a parsed one. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, raw) =>
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? Object.fromEntries(Object.entries(raw as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : raw,
  )
}

/**
 * Whether an unexpired pending action of this user already carries exactly this input.
 * `loadBeforeRecord(s)` runs at prepare and again at confirm with the same context; only
 * the confirm re-check (or a repeat of a still-pending proposal) finds one. A tool may then
 * refuse a state problem at prepare — the model never sees the preview, so it must hear why
 * — and still answer the re-check with a blocked preview: a throw there becomes a 500.
 */
export async function isPendingProposal(ctx: ItadToolContext, tool: AiToolDefinition, input: unknown): Promise<boolean> {
  if (!ctx.tenantId || !ctx.userId) return false
  const em = ctx.container.resolve<EntityManager>('em').fork()
  const rows = await new AiPendingActionRepository(em).listPendingForAgent(ITAD_ASSISTANT_AGENT_ID, {
    tenantId: ctx.tenantId,
    organizationId: ctx.organizationId ?? null,
  }, 200)
  const now = Date.now()
  const wanted = canonical(input)
  return rows.some((row) => {
    if (row.toolName !== tool.name || row.createdByUserId !== ctx.userId || new Date(row.expiresAt).getTime() <= now) return false
    const parsed = tool.inputSchema.safeParse(row.normalizedInput ?? {})
    return parsed.success && canonical(parsed.data) === wanted
  })
}

/** Route context of the confirming user, carrying the previewed version as the lock header. */
function routeForUser(ctx: ItadToolContext, lockVersion: string | null): Promise<ItadRouteContext> {
  return resolveTrustedRecordRoute({
    userId: ctx.userId!,
    tenantId: ctx.tenantId!,
    organizationId: ctx.organizationId!,
    isSuperAdmin: ctx.isSuperAdmin,
    lockVersion,
  })
}

/** Maps a command failure to a stable tool error; domain messages (localized, coded) pass, server errors do not. */
export function toToolError(err: unknown, what: string): ItadToolError {
  if (err instanceof ItadToolError) return err
  if (isCrudHttpError(err) && err.status < 500) {
    const domainCode = typeof err.body?.code === 'string' ? err.body.code : null
    const message = typeof err.body?.error === 'string' ? err.body.error : `${what} failed`
    return new ItadToolError(domainCode ?? routeErrorCode(err.status), message)
  }
  logger.error('ITAD AI write failed', { what, err })
  return new ItadToolError('route_failed', `${what} failed`)
}

export async function runApprovedWrite<TInput extends Record<string, unknown>, TResult>(
  ctx: ItadToolContext,
  tool: AiToolDefinition,
  input: {
    action: ApprovedAction
    jobId: string
    commandId: string
    commandInput: TInput
    resourceKind: string
    resourceId: string
    /** The record as it is now; its version must equal the previewed one. */
    current: { organizationId: string; updatedAt: string }
    /**
     * The version the command must find, when it is not the action's `recordVersion` — a
     * batch record's own version, or the record part of a composite version (A3).
     */
    expectedVersion?: string | null
    what: string
  },
): Promise<TResult> {
  const { action } = input
  const expected = input.expectedVersion !== undefined ? input.expectedVersion : action.recordVersion
  try {
    // 2: features, fresh from the database, in the record's organization.
    const rbac = ctx.container.resolve<RbacService>('rbacService')
    const allowed = await rbac.userHasAllFeatures(ctx.userId!, tool.requiredFeatures ?? [], {
      tenantId: ctx.tenantId!,
      organizationId: input.current.organizationId,
    })
    if (!allowed) throw new ItadToolError('forbidden', 'You no longer have permission for this change')

    // 3: the job is readable in the user's scope (404 otherwise, same as a missing record).
    const route = await routeForUser(ctx, expected)
    const job = await loadReadableJob(route, input.jobId)
    if (job.organizationId !== input.current.organizationId) throw new ItadToolError('not_found', `${input.what}: not found`)

    // 4: the version previewed is the version written.
    if (expected) {
      enforceCommandOptimisticLock({
        resourceKind: input.resourceKind,
        resourceId: input.resourceId,
        current: new Date(input.current.updatedAt),
        expected,
      })
    }

    // 5: the existing command, through the mutation guard, with the AI audit context.
    const context: ItadAiAuditContext = {
      source: 'ai',
      channel: 'chat',
      actionId: action.id,
      toolName: tool.name,
      origin: { type: 'user', userId: action.createdByUserId },
      agentId: ITAD_ASSISTANT_AGENT_ID,
      pendingActionId: action.id,
    }
    const outcome = await runGuardedCommand<TInput, TResult>(route, route.ctx.request as Request, {
      commandId: input.commandId,
      input: input.commandInput,
      resourceKind: input.resourceKind,
      resourceId: input.resourceId,
      operation: 'update',
      metadata: { context },
    })
    if (!outcome.ok) {
      const body = (await outcome.response.json().catch(() => null)) as { error?: string; code?: string } | null
      throw new ItadToolError(body?.code ?? routeErrorCode(outcome.response.status), body?.error ?? `${input.what} failed`)
    }
    return outcome.result
  } catch (err) {
    throw toToolError(err, input.what)
  }
}

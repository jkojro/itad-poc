import {
  createAiApiOperationRunner,
  type AiApiOperationRequest,
  type AiApiOperationResponse,
} from '@open-mercato/ai-assistant/modules/ai_assistant/lib/ai-api-operation-runner'
import { defineAiTool } from '@open-mercato/ai-assistant/modules/ai_assistant/lib/ai-tool-definition'
import type { AiToolDefinition, McpToolContext } from '@open-mercato/ai-assistant/modules/ai_assistant/lib/types'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { hasFeature } from '@open-mercato/shared/security/features'

const logger = createLogger('itad').child({ component: 'ai-tools' })

/**
 * Shared plumbing of the ITAD AI tools (AI assistant spec, "Thin tools"). Every read goes
 * through the existing ITAD API routes in process (the framework's API operation runner),
 * so tenant, organization scope and response shapes are exactly the UI's.
 */

export type ItadToolContext = McpToolContext

/** `defineAiTool` typed for the module's tool arrays (the registry stores tools as `AiToolDefinition`). */
export function defineItadTool<TInput, TOutput>(tool: AiToolDefinition<TInput, TOutput>): AiToolDefinition {
  return defineAiTool(tool) as unknown as AiToolDefinition
}

/** Wildcard-aware check of the caller's features (super admins hold every feature). */
export function can(ctx: ItadToolContext, feature: string): boolean {
  return ctx.isSuperAdmin || hasFeature(ctx.userFeatures, feature)
}

export class ItadToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ItadToolError'
  }
}

export function assertTenant(ctx: ItadToolContext): string {
  if (!ctx.tenantId) throw new ItadToolError('tenant_required', 'Tenant context is required for itad.* tools')
  return ctx.tenantId
}

/**
 * Runs one ITAD route for the tool. The runner refuses a route whose features the tool
 * does not declare; a composite tool may add a sub-route's feature (`extraFeatures`),
 * and this helper itself refuses unless the caller holds every one of them, so
 * degradation never depends on each call site remembering to check `can` first.
 */
export async function runItadRoute<T>(
  ctx: ItadToolContext,
  tool: AiToolDefinition,
  request: AiApiOperationRequest,
  extraFeatures: string[] = [],
): Promise<AiApiOperationResponse<T>> {
  assertTenant(ctx)
  for (const feature of extraFeatures) {
    if (!can(ctx, feature)) throw new ItadToolError('forbidden', 'Required feature is not available')
  }
  const requiredFeatures = [...new Set([...(tool.requiredFeatures ?? []), ...extraFeatures])]
  const runner = createAiApiOperationRunner({ ...ctx, tool: { ...tool, requiredFeatures } as AiToolDefinition })
  return runner.run<T>({ ...request, path: itadPath(request.path) })
}

/** `/jobs/…` → `/itad/jobs/…`; a path already under `/itad` (exactly or `/itad/…`) is kept. */
export function itadPath(path: string): string {
  return path === '/itad' || path.startsWith('/itad/') ? path : `/itad${path.startsWith('/') ? '' : '/'}${path}`
}

/** Stable error codes the model and the user see; the route's own message goes to the log only. */
export function routeErrorCode(statusCode: number): 'not_found' | 'forbidden' | 'conflict' | 'route_failed' {
  if (statusCode === 404) return 'not_found'
  if (statusCode === 401 || statusCode === 403) return 'forbidden'
  if (statusCode === 409 || statusCode === 412) return 'conflict'
  return 'route_failed'
}

/**
 * Data of a successful route call; `null` for 404 (out of scope reads as not found).
 * Any other failure throws a stable code with a generic message ("Asset lookup failed");
 * the route's raw error is logged, never passed to the model or the user.
 */
export function routeData<T>(response: AiApiOperationResponse<T>, what: string): T | null {
  if (response.success) return (response.data ?? null) as T | null
  if (response.statusCode === 404) return null
  logger.warn('ITAD AI tool route call failed', { what, statusCode: response.statusCode, error: response.error })
  throw new ItadToolError(routeErrorCode(response.statusCode), `${what} failed`)
}

/** Like `routeData`, but a missing record is an error the tool reports as not found. */
export function requireRouteData<T>(response: AiApiOperationResponse<T>, what: string): T {
  const data = routeData(response, what)
  if (data === null) throw new ItadToolError('not_found', `${what}: not found`)
  return data
}

export const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)

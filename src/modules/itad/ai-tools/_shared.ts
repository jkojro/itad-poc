import {
  createAiApiOperationRunner,
  type AiApiOperationRequest,
  type AiApiOperationResponse,
} from '@open-mercato/ai-assistant/modules/ai_assistant/lib/ai-api-operation-runner'
import { defineAiTool } from '@open-mercato/ai-assistant/modules/ai_assistant/lib/ai-tool-definition'
import type { AiToolDefinition, McpToolContext } from '@open-mercato/ai-assistant/modules/ai_assistant/lib/types'
import { hasFeature } from '@open-mercato/shared/security/features'

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
 * does not declare; a composite tool passes the extra feature of a sub-route only after
 * checking the caller holds it (`can`), which is how degradation is enforced.
 */
export async function runItadRoute<T>(
  ctx: ItadToolContext,
  tool: AiToolDefinition,
  request: AiApiOperationRequest,
  extraFeatures: string[] = [],
): Promise<AiApiOperationResponse<T>> {
  assertTenant(ctx)
  const requiredFeatures = [...new Set([...(tool.requiredFeatures ?? []), ...extraFeatures])]
  const runner = createAiApiOperationRunner({ ...ctx, tool: { ...tool, requiredFeatures } as AiToolDefinition })
  return runner.run<T>({ ...request, path: request.path.startsWith('/itad') ? request.path : `/itad${request.path}` })
}

/** Data of a successful route call; `null` for 404 (out of scope reads as not found); throws otherwise. */
export function routeData<T>(response: AiApiOperationResponse<T>, what: string): T | null {
  if (response.success) return (response.data ?? null) as T | null
  if (response.statusCode === 404) return null
  throw new ItadToolError(`route_${response.statusCode}`, `${what} failed: ${response.error ?? response.statusCode}`)
}

/** Like `routeData`, but a missing record is an error the tool reports as not found. */
export function requireRouteData<T>(response: AiApiOperationResponse<T>, what: string): T {
  const data = routeData(response, what)
  if (data === null) throw new ItadToolError('not_found', `${what}: not found`)
  return data
}

export const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)

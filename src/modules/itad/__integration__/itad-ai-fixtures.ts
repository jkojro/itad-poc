import { expect, type APIRequestContext } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createRoleFixture, createUserFixture, setRoleAclFeatures } from '@open-mercato/core/helpers/integration/authFixtures'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'

/**
 * AI assistant tests (AI assistant spec, phase 1) call the ITAD tools without a model,
 * through `POST /api/ai_assistant/tools/execute`, with the caller's own features.
 */

export type AiToolResponse<T> = { status: number; body: { success: boolean; result?: T; error?: string } | null }

export async function runAiTool<T = Record<string, unknown>>(
  request: APIRequestContext,
  token: string,
  toolName: string,
  args: Record<string, unknown> = {},
): Promise<AiToolResponse<T>> {
  const response = await apiRequest(request, 'POST', '/api/ai_assistant/tools/execute', { token, data: { toolName, args } })
  return { status: response.status(), body: await readJsonSafe<AiToolResponse<T>['body']>(response) }
}

// Tool results are open-ended JSON; tests assert on the fields they need.
export async function aiToolOk<T = any>(request: APIRequestContext, token: string, toolName: string, args: Record<string, unknown> = {}): Promise<T> {
  const { status, body } = await runAiTool<T>(request, token, toolName, args)
  expect(status, `${toolName} failed: ${JSON.stringify(body)}`).toBe(200)
  expect(body?.success).toBe(true)
  return body!.result as T
}

export type Cleanup = { roleIds: string[]; userIds: string[] }

/** A user of `organizationId` whose only role grants `features` (plus the AI assistant feature). */
export async function tokenWithFeatures(
  request: APIRequestContext,
  adminToken: string,
  input: { label: string; suffix: string; tenantId: string; organizationId: string; features: string[]; cleanup: Cleanup },
): Promise<string> {
  const safe = input.suffix.replace(/[^a-z0-9]/gi, '_')
  const roleName = `qa_itad_ai_${input.label}_${safe}`
  const roleId = await createRoleFixture(request, adminToken, { name: roleName, tenantId: input.tenantId })
  input.cleanup.roleIds.push(roleId)
  await setRoleAclFeatures(request, adminToken, { roleId, features: ['ai_assistant.view', ...input.features] })
  const email = `qa-itad-ai-${input.label}-${input.suffix}@example.test`
  const password = `Qa-${input.suffix}-Secret!`
  input.cleanup.userIds.push(await createUserFixture(request, adminToken, { email, password, organizationId: input.organizationId, roles: [roleName] }))
  return getAuthToken(request, email, password)
}

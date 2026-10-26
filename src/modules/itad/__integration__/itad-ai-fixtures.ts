import { randomUUID } from 'node:crypto'
import { expect, type APIRequestContext } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createRoleFixture, createUserFixture, setRoleAclFeatures } from '@open-mercato/core/helpers/integration/authFixtures'
import { withClient } from '@open-mercato/core/helpers/integration/dbFixtures'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { advanceToReceiving, createSchedulableJob, transitionOk, uniqueSuffix } from './itad-job-fixtures'
import { csv, importManifestOk } from './itad-manifest-fixtures'
import { classifyUndecided, scanOk } from './itad-receiving-fixtures'

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
  headers?: Record<string, string>,
): Promise<AiToolResponse<T>> {
  const response = await apiRequest(request, 'POST', '/api/ai_assistant/tools/execute', { token, data: { toolName, args }, headers })
  return { status: response.status(), body: await readJsonSafe<AiToolResponse<T>['body']>(response) }
}

// Tool results are open-ended JSON; tests assert on the fields they need.
export async function aiToolOk<T = any>(
  request: APIRequestContext,
  token: string,
  toolName: string,
  args: Record<string, unknown> = {},
  headers?: Record<string, string>,
): Promise<T> {
  const { status, body } = await runAiTool<T>(request, token, toolName, args, headers)
  expect(status, `${toolName} failed: ${JSON.stringify(body)}`).toBe(200)
  expect(body?.success).toBe(true)
  return body!.result as T
}

export type Cleanup = { roleIds: string[]; userIds: string[] }

/** A user of `organizationId` whose only role grants `features` (plus the AI assistant feature). */
type FeatureUserInput = { label: string; suffix: string; tenantId: string; organizationId: string; features: string[]; cleanup: Cleanup }

/** A user whose only role grants `features`; returns the credentials too, for UI logins. */
export async function userWithFeatures(
  request: APIRequestContext,
  adminToken: string,
  input: FeatureUserInput,
): Promise<{ email: string; password: string; token: string }> {
  const safe = input.suffix.replace(/[^a-z0-9]/gi, '_')
  const roleName = `qa_itad_ai_${input.label}_${safe}`
  const roleId = await createRoleFixture(request, adminToken, { name: roleName, tenantId: input.tenantId })
  input.cleanup.roleIds.push(roleId)
  await setRoleAclFeatures(request, adminToken, { roleId, features: ['ai_assistant.view', ...input.features] })
  const email = `qa-itad-ai-${input.label}-${input.suffix}@example.test`
  const password = `Qa-${input.suffix}-Secret!`
  input.cleanup.userIds.push(await createUserFixture(request, adminToken, { email, password, organizationId: input.organizationId, roles: [roleName] }))
  return { email, password, token: await getAuthToken(request, email, password) }
}

export async function tokenWithFeatures(request: APIRequestContext, adminToken: string, input: FeatureUserInput): Promise<string> {
  return (await userWithFeatures(request, adminToken, input)).token
}

// ─── Pending actions (phase 2) ────────────────────────────────────────────────
// There is no public route that creates a pending action (it is born only inside the
// framework's prepareMutation, during a model turn), so tests seed the row the way the
// framework's own tests do and then use the real confirm / cancel routes.

export type SeedPendingActionInput = {
  tenantId: string
  organizationId: string
  createdByUserId: string
  toolName: string
  normalizedInput: Record<string, unknown>
  recordVersion: string | null
  targetEntityType: string
  targetRecordId: string | null
  expiresInMinutes?: number
  /** A batch action's records with their previewed versions (A1). */
  records?: Array<{ recordId: string; recordVersion: string | null }>
}

export async function seedPendingAction(input: SeedPendingActionInput): Promise<string> {
  return withClient(async (client) => {
    const result = await client.query<{ id: string }>(
      `insert into ai_pending_actions
         (id, tenant_id, organization_id, agent_id, tool_name, normalized_input, field_diff, attachment_ids,
          idempotency_key, created_by_user_id, status, queue_mode, record_version, target_entity_type,
          target_record_id, records, created_at, expires_at)
       values
         (gen_random_uuid(), $1, $2, 'itad.operations_assistant', $3, $4::jsonb, '[]'::jsonb, '[]'::jsonb,
          $5, $6, 'pending', 'inline', $7, $8, $9, $11::jsonb, now(), now() + make_interval(mins => $10::int))
       returning id`,
      [
        input.tenantId,
        input.organizationId,
        input.toolName,
        JSON.stringify(input.normalizedInput),
        `itad-ai-${randomUUID()}`,
        input.createdByUserId,
        input.recordVersion,
        input.targetEntityType,
        input.targetRecordId,
        input.expiresInMinutes ?? 30,
        input.records
          ? JSON.stringify(input.records.map((record) => ({ ...record, entityType: input.targetEntityType, label: record.recordId, fieldDiff: [] })))
          : null,
      ],
    )
    return result.rows[0].id
  })
}

export async function deletePendingActions(ids: string[]): Promise<void> {
  if (!ids.length) return
  await withClient(async (client) => {
    await client.query('delete from ai_pending_actions where id = any($1::uuid[])', [ids])
  })
}

export type ConfirmBody = {
  ok?: boolean
  code?: string
  error?: string
  pendingAction?: { status: string }
  mutationResult?: { error?: { message?: string }; [key: string]: unknown }
}

export async function confirmAction(request: APIRequestContext, token: string, id: string) {
  const response = await apiRequest(request, 'POST', `/api/ai_assistant/ai/actions/${id}/confirm`, { token, data: {} })
  return { status: response.status(), body: await readJsonSafe<ConfirmBody>(response) }
}

export async function cancelAction(request: APIRequestContext, token: string, id: string) {
  const response = await apiRequest(request, 'POST', `/api/ai_assistant/ai/actions/${id}/cancel`, { token, data: {} })
  return { status: response.status(), body: await readJsonSafe<ConfirmBody>(response) }
}

/** The newest action log entry of a resource, read through the audit API (columns are encrypted at rest). */
export async function latestActionLog(
  request: APIRequestContext,
  token: string,
  resourceId: string,
): Promise<{ actorUserId: string | null; commandId: string; context: Record<string, unknown> | null } | null> {
  const response = await apiRequest(request, 'GET', `/api/audit_logs/audit-logs/actions?resourceId=${resourceId}&pageSize=5`, { token })
  expect(response.status()).toBe(200)
  const items = (await readJsonSafe<{ items: Array<{ actorUserId: string | null; commandId: string; context: Record<string, unknown> | null; createdAt: string }> }>(response))?.items ?? []
  const newest = [...items].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
  return newest ? { actorUserId: newest.actorUserId, commandId: newest.commandId, context: newest.context } : null
}

export type OpenException = { id: string; type: string; serial: string; updatedAt: string; status: string }

/**
 * A processing job with one open MISSING_FROM_DELIVERY exception (2 expected, 1 received)
 * and one open UNEXPECTED_ASSET exception (an extra device), as exceptions spec E4-010/011.
 */
export async function jobWithOpenReconciliationExceptions(
  request: APIRequestContext,
  token: string,
  companyId: string,
  label: string,
): Promise<{ jobId: string; reference: string; missing: OpenException; unexpected: OpenException }> {
  const tag = uniqueSuffix().slice(-6).toUpperCase().replace(/[^A-Z0-9]/g, 'X')
  const job = await createSchedulableJob(request, token, companyId, label)
  const [received, missing] = [`AW1${tag}`, `AW2${tag}`]
  await importManifestOk(
    request,
    token,
    job.id,
    { name: `aw-${tag}.csv`, content: csv([['Serial', 'Carries data'], [received, 'no'], [missing, 'no']]) },
    { serial: 'Serial', dataBearing: 'Carries data' },
  )
  await advanceToReceiving(request, token, job.id)
  await scanOk(request, token, job.id, received)
  await scanOk(request, token, job.id, `AWX${tag}`)
  await classifyUndecided(request, token, job.id, false)
  await transitionOk(request, token, job.id, { action: 'start_processing' })
  const response = await apiRequest(request, 'GET', `/api/itad/jobs/${job.id}/exceptions?status=open`, { token })
  const items = (await readJsonSafe<{ items: OpenException[] }>(response))?.items ?? []
  const byType = (type: string) => {
    const found = items.find((item) => item.type === type)
    expect(found, `open ${type} exception`).toBeDefined()
    return found!
  }
  return { jobId: job.id, reference: job.internalReference, missing: byType('missing_from_delivery'), unexpected: byType('unexpected_asset') }
}

export async function exceptionState(request: APIRequestContext, token: string, jobId: string, exceptionId: string) {
  const response = await apiRequest(request, 'GET', `/api/itad/jobs/${jobId}/exceptions/${exceptionId}`, { token })
  expect(response.status()).toBe(200)
  return (await readJsonSafe<OpenException & { resolutionOutcome: string | null; resolutionReason: string | null }>(response))!
}

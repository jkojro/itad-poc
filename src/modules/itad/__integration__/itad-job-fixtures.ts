import { expect, type APIRequestContext } from '@playwright/test'
import { apiRequest } from '@open-mercato/core/helpers/integration/api'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'

export type JobPayload = {
  customerId: string
  name: string
  customerReference?: string | null
  expectedAssetEstimate?: number | null
  scheduledPickupAt?: string | null
  [key: string]: unknown
}

export type JobListItem = {
  id: string
  internalReference: string
  customerReference: string | null
  name: string
  customerName: string | null
  status: string
  statusBeforeHold?: string | null
  heldBy?: { id: string; name: string | null } | null
  holdReason?: string | null
  startedAt?: string | null
  completedAt?: string | null
  scheduledPickupAt?: string | null
  expectedAssetEstimate?: number | null
  updatedAt: string | null
  editableFields?: string[]
}

export const JOB_REFERENCE_PATTERN = /^ITAD-(\d{4})-(\d{5,})$/

export function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export async function createJob(
  request: APIRequestContext,
  token: string,
  payload: JobPayload,
): Promise<{ id: string; internalReference: string }> {
  const response = await apiRequest(request, 'POST', '/api/itad/jobs', { token, data: payload })
  const body = await readJsonSafe<{ id?: string; internalReference?: string }>(response)
  expect(response.status(), `POST /api/itad/jobs failed: ${JSON.stringify(body)}`).toBe(201)
  expect(typeof body?.id).toBe('string')
  expect(typeof body?.internalReference).toBe('string')
  return { id: body!.id!, internalReference: body!.internalReference! }
}

export async function getJob(request: APIRequestContext, token: string, id: string): Promise<JobListItem | null> {
  const response = await apiRequest(request, 'GET', `/api/itad/jobs?id=${encodeURIComponent(id)}&pageSize=1`, { token })
  expect(response.status()).toBe(200)
  const body = await readJsonSafe<{ items?: JobListItem[] }>(response)
  return body?.items?.[0] ?? null
}

export async function deleteJobIfExists(
  request: APIRequestContext,
  token: string | null,
  id: string | null,
): Promise<void> {
  if (!token || !id) return
  await apiRequest(request, 'DELETE', '/api/itad/jobs', { token, data: { id } }).catch(() => undefined)
}

export function referenceNumber(reference: string): number {
  const match = JOB_REFERENCE_PATTERN.exec(reference)
  expect(match, `Unexpected reference format: ${reference}`).not.toBeNull()
  return Number(match![2])
}

export type TransitionBody = {
  action: string
  reason?: string
  confirmations?: Array<{ condition: string; comment?: string }>
}

export const LOCK_HEADER = 'x-om-ext-optimistic-lock-expected-updated-at'

/** POSTs one status transition; returns the raw response for status/body assertions. */
export async function postTransition(
  request: APIRequestContext,
  token: string,
  jobId: string,
  body: TransitionBody,
  headers?: Record<string, string>,
) {
  return apiRequest(request, 'POST', `/api/itad/jobs/${encodeURIComponent(jobId)}/transitions`, {
    token,
    data: body,
    ...(headers ? { headers } : {}),
  })
}

/** Runs a transition that must succeed and returns the new status. */
export async function transitionOk(
  request: APIRequestContext,
  token: string,
  jobId: string,
  body: TransitionBody,
): Promise<string> {
  const response = await postTransition(request, token, jobId, body)
  const payload = await readJsonSafe<{ status?: string }>(response)
  expect(response.status(), `${body.action} failed: ${JSON.stringify(payload)}`).toBe(200)
  return String(payload?.status)
}

export async function errorCode(response: { json: () => Promise<unknown> }): Promise<string | undefined> {
  const body = (await response.json().catch(() => null)) as { code?: string } | null
  return body?.code
}

/** Draft job with a pickup date, ready to be scheduled. */
export async function createSchedulableJob(
  request: APIRequestContext,
  token: string,
  customerId: string,
  name: string,
  extra: Partial<JobPayload> = {},
): Promise<{ id: string; internalReference: string }> {
  return createJob(request, token, {
    customerId,
    name,
    scheduledPickupAt: new Date(Date.now() + 86_400_000).toISOString(),
    ...extra,
  })
}

/** Moves a fresh schedulable job forward to `receiving` with admin rights. */
export async function advanceToReceiving(request: APIRequestContext, token: string, jobId: string): Promise<void> {
  await transitionOk(request, token, jobId, { action: 'schedule' })
  await transitionOk(request, token, jobId, { action: 'dispatch' })
  await transitionOk(request, token, jobId, { action: 'start_receiving' })
}

export const CONFIRM = (condition: string) => ({ condition, comment: `QA confirmed ${condition}` })

/**
 * Browser session for an arbitrary user (the core `login` helper only knows fixed roles).
 * Only sets the session cookie through the login API; the caller navigates afterwards.
 */
export async function loginAs(page: import('@playwright/test').Page, email: string, password: string): Promise<void> {
  const form = new URLSearchParams({ email, password })
  const response = await page.request.post('/api/auth/login', {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    data: form.toString(),
  })
  expect(response.ok(), `login failed for ${email}: ${response.status()}`).toBe(true)
}

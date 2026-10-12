import { expect, type APIRequestContext } from '@playwright/test'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'

/** Exception API helpers for TC-ITAD-301+. */
const BASE_URL = process.env.BASE_URL?.trim() || ''

export type ExceptionBody = {
  id: string
  type: string
  status: string
  serial: string
  assetId: string | null
  manifestItemId: string | null
  intakeScanId: string | null
  sanitizationRunId: string | null
  assignedTo: { id: string; name: string | null } | null
  resolutionOutcome: string | null
  resolutionReason: string | null
  resolvedBy: { id: string; name: string | null } | null
  resolvedAt: string | null
  updatedAt: string
}

export type ExceptionEventBody = { kind: string; outcome: string | null; reason: string | null; actor: { id: string } | null }

function headers(token: string, selectedOrgId?: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, ...(selectedOrgId ? { Cookie: `om_selected_org=${selectedOrgId}` } : {}) }
}

export async function getExceptions(request: APIRequestContext, token: string, jobId: string, query = '', selectedOrgId?: string) {
  return request.fetch(`${BASE_URL}/api/itad/jobs/${encodeURIComponent(jobId)}/exceptions${query ? `?${query}` : ''}`, {
    method: 'GET',
    headers: headers(token, selectedOrgId),
  })
}

export async function listExceptions(
  request: APIRequestContext,
  token: string,
  jobId: string,
  query = '',
): Promise<{ items: ExceptionBody[]; total: number; openCounts: Record<string, number> }> {
  const response = await getExceptions(request, token, jobId, query)
  expect(response.status()).toBe(200)
  return (await readJsonSafe(response))!
}

export async function exceptionDetail(
  request: APIRequestContext,
  token: string,
  jobId: string,
  exceptionId: string,
): Promise<ExceptionBody & { events: ExceptionEventBody[] }> {
  const response = await request.fetch(`${BASE_URL}/api/itad/jobs/${encodeURIComponent(jobId)}/exceptions/${encodeURIComponent(exceptionId)}`, {
    method: 'GET',
    headers: headers(token),
  })
  expect(response.status()).toBe(200)
  return (await readJsonSafe(response))!
}

const LOCK = 'x-om-ext-optimistic-lock-expected-updated-at'

export async function assignExceptionApi(
  request: APIRequestContext,
  token: string,
  jobId: string,
  exception: { id: string; updatedAt: string },
  assignedToUserId: string | null,
) {
  return request.fetch(`${BASE_URL}/api/itad/jobs/${encodeURIComponent(jobId)}/exceptions/${encodeURIComponent(exception.id)}/assign`, {
    method: 'POST',
    headers: { ...headers(token), 'Content-Type': 'application/json', [LOCK]: exception.updatedAt },
    data: { assignedToUserId },
  })
}

export async function resolveExceptionApi(
  request: APIRequestContext,
  token: string,
  jobId: string,
  exception: { id: string; updatedAt: string },
  outcome: string,
  reason: string | null,
) {
  return request.fetch(`${BASE_URL}/api/itad/jobs/${encodeURIComponent(jobId)}/exceptions/${encodeURIComponent(exception.id)}/resolve`, {
    method: 'POST',
    headers: { ...headers(token), 'Content-Type': 'application/json', [LOCK]: exception.updatedAt },
    data: { outcome, reason },
  })
}

export async function setAsideDuplicate(request: APIRequestContext, token: string, jobId: string, scanId: string, reason: string | null) {
  return request.fetch(`${BASE_URL}/api/itad/jobs/${encodeURIComponent(jobId)}/scans/${encodeURIComponent(scanId)}/set-aside`, {
    method: 'POST',
    headers: { ...headers(token), 'Content-Type': 'application/json' },
    data: { reason },
  })
}

export async function getAssignees(request: APIRequestContext, token: string, search = '') {
  return request.fetch(`${BASE_URL}/api/itad/exceptions/assignees${search ? `?search=${encodeURIComponent(search)}` : ''}`, {
    method: 'GET',
    headers: headers(token),
  })
}

export type TimelineItemBody = { at: string; kind: string; category: string; actor: { id: string } | null; details: Record<string, unknown> }

export async function getTimeline(request: APIRequestContext, token: string, jobId: string, assetId: string) {
  return request.fetch(`${BASE_URL}/api/itad/jobs/${encodeURIComponent(jobId)}/assets/${encodeURIComponent(assetId)}/timeline`, {
    method: 'GET',
    headers: headers(token),
  })
}

export async function timelineOf(request: APIRequestContext, token: string, jobId: string, assetId: string): Promise<TimelineItemBody[]> {
  const response = await getTimeline(request, token, jobId, assetId)
  expect(response.status()).toBe(200)
  return ((await readJsonSafe<{ items: TimelineItemBody[] }>(response))?.items) ?? []
}

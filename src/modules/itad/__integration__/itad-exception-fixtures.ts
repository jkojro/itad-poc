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

import { expect, type APIRequestContext } from '@playwright/test'
import { apiRequest } from '@open-mercato/core/helpers/integration/api'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'

export type OverviewBody = {
  counters: Record<string, number>
  signals: Array<{ key: string; severity: 'red' | 'orange'; count: number; href: string }>
  severity: 'red' | 'orange' | 'none'
  group: string
}

/** `GET /api/itad/jobs/{id}/overview` (operations dashboard spec "Job Overview"). */
export async function jobOverviewOk(request: APIRequestContext, token: string, jobId: string): Promise<OverviewBody> {
  const response = await apiRequest(request, 'GET', `/api/itad/jobs/${encodeURIComponent(jobId)}/overview`, { token })
  const body = await readJsonSafe<OverviewBody>(response)
  expect(response.status(), `overview failed: ${JSON.stringify(body)}`).toBe(200)
  return body!
}

export type OperationsItem = OverviewBody & {
  id: string
  internalReference: string
  status: string
  statusBeforeHold: string | null
  customer: { id: string; name: string | null }
}

export type OperationsBody = { items: OperationsItem[]; customers: Array<{ id: string; name: string | null }>; truncated: boolean }

/** `GET /api/itad/operations` (operations dashboard spec); `selectedOrgId` switches the organization scope. */
export async function operations(request: APIRequestContext, token: string, query = '', selectedOrgId?: string) {
  return request.fetch(`/api/itad/operations${query ? `?${query}` : ''}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(selectedOrgId ? { Cookie: `om_selected_org=${selectedOrgId}` } : {}) },
  })
}

export async function operationsOk(request: APIRequestContext, token: string, query = '', selectedOrgId?: string): Promise<OperationsBody> {
  const response = await operations(request, token, query, selectedOrgId)
  const body = await readJsonSafe<OperationsBody>(response)
  expect(response.status(), `operations failed: ${JSON.stringify(body)}`).toBe(200)
  return body!
}

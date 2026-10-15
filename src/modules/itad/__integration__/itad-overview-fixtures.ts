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

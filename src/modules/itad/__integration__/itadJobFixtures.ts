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

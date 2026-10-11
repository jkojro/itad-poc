import { expect, type APIRequestContext } from '@playwright/test'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { LOCK_HEADER } from './itad-job-fixtures'

/** Receiving API helpers for TC-ITAD-108+ (scans, duplicate actions, assets). */
const BASE_URL = process.env.BASE_URL?.trim() || ''

export type ScanBody = {
  result: 'MATCHED' | 'UNEXPECTED' | 'DUPLICATE'
  scan: { id: string; rawSerial: string }
  asset: {
    id: string
    serial: string
    customerAssetTag: string | null
    manufacturer: string | null
    model: string | null
    dataBearing: boolean | null
    dataBearingSource: string | null
    status: string
  }
  manifestItem: { id: string; serial: string } | null
}

export type AssetBody = {
  id: string
  serial: string
  customerAssetTag: string | null
  manufacturer: string | null
  model: string | null
  dataBearing: boolean | null
  dataBearingSource: string | null
  status: string
  manifestItemId: string | null
  updatedAt: string
  [key: string]: unknown
}

export type ScanListBody = {
  id: string
  result: string
  pending: boolean
  asset: { id: string; serial: string; deleted: boolean }
  resolution: string | null
  resolvedAt: string | null
  flaggedDifferentDeviceAt: string | null
  flaggedDifferentDeviceNote: string | null
}

function url(jobId: string, path: string): string {
  return `${BASE_URL}/api/itad/jobs/${encodeURIComponent(jobId)}${path}`
}

function headers(token: string, extra: Record<string, string> = {}, selectedOrgId?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...(selectedOrgId ? { Cookie: `om_selected_org=${selectedOrgId}` } : {}),
    ...extra,
  }
}

export async function postScan(request: APIRequestContext, token: string, jobId: string, serial: string) {
  return request.fetch(url(jobId, '/scans'), { method: 'POST', headers: headers(token), data: { serial } })
}

/** Scans a serial that must be accepted; returns the scan response. */
export async function scanOk(request: APIRequestContext, token: string, jobId: string, serial: string): Promise<ScanBody> {
  const response = await postScan(request, token, jobId, serial)
  const body = await readJsonSafe<ScanBody>(response)
  expect(response.status(), `scan ${serial} failed: ${JSON.stringify(body)}`).toBe(201)
  return body!
}

export async function getReceiving(request: APIRequestContext, token: string, jobId: string, path: string, selectedOrgId?: string) {
  return request.fetch(url(jobId, path), { method: 'GET', headers: headers(token, {}, selectedOrgId) })
}

export async function listAssets(request: APIRequestContext, token: string, jobId: string, query = ''): Promise<{ items: AssetBody[]; total: number }> {
  const response = await getReceiving(request, token, jobId, `/assets${query ? `?${query}` : ''}`)
  expect(response.status()).toBe(200)
  return (await readJsonSafe<{ items: AssetBody[]; total: number }>(response))!
}

export async function listScans(request: APIRequestContext, token: string, jobId: string, query = ''): Promise<{ items: ScanListBody[]; total: number }> {
  const response = await getReceiving(request, token, jobId, `/scans${query ? `?${query}` : ''}`)
  expect(response.status()).toBe(200)
  return (await readJsonSafe<{ items: ScanListBody[]; total: number }>(response))!
}

export async function scanAction(
  request: APIRequestContext,
  token: string,
  jobId: string,
  scanId: string,
  action: 'resolve' | 'flag-different-device',
  note?: string | null,
) {
  return request.fetch(url(jobId, `/scans/${encodeURIComponent(scanId)}/${action}`), {
    method: 'POST',
    headers: headers(token),
    data: { note: note ?? null },
  })
}

export async function updateAsset(
  request: APIRequestContext,
  token: string,
  jobId: string,
  assetId: string,
  data: Record<string, unknown>,
  expectedUpdatedAt?: string,
) {
  return request.fetch(url(jobId, `/assets/${encodeURIComponent(assetId)}`), {
    method: 'PUT',
    headers: headers(token, expectedUpdatedAt ? { [LOCK_HEADER]: expectedUpdatedAt } : {}),
    data,
  })
}

export async function deleteAsset(
  request: APIRequestContext,
  token: string,
  jobId: string,
  assetId: string,
  reason: string | null,
  expectedUpdatedAt?: string,
) {
  return request.fetch(url(jobId, `/assets/${encodeURIComponent(assetId)}`), {
    method: 'DELETE',
    headers: headers(token, expectedUpdatedAt ? { [LOCK_HEADER]: expectedUpdatedAt } : {}),
    data: { reason },
  })
}

/** `itad.assets.classify` (sanitization spec REQ-304); returns the raw response. */
export async function classifyAssets(
  request: APIRequestContext,
  token: string,
  jobId: string,
  assetIds: string[],
  dataBearing: boolean,
  reason?: string,
) {
  return request.fetch(url(jobId, '/assets/classify'), {
    method: 'POST',
    headers: headers(token),
    data: { assetIds, dataBearing, ...(reason ? { reason } : {}) },
  })
}

/** Classifies every not yet determined asset of a job (at most 100) as `dataBearing`. */
export async function classifyUndecided(request: APIRequestContext, token: string, jobId: string, dataBearing: boolean): Promise<string[]> {
  const ids = (await listAssets(request, token, jobId, 'dataBearing=unknown&pageSize=100')).items.map((asset) => asset.id)
  if (ids.length === 0) return []
  const response = await classifyAssets(request, token, jobId, ids, dataBearing)
  expect(response.status(), `classify failed: ${JSON.stringify(await readJsonSafe(response))}`).toBe(200)
  return ids
}

export type ReconciliationBody = {
  expectedAssetCount: number
  receivedAssetCount: number
  matched: number
  missing: number
  unexpected: number
  pendingDuplicates: number
  differentDeviceUnresolved: number
  dataBearingUndecided: number
  hasManifest: boolean
}

export async function getReconciliation(request: APIRequestContext, token: string, jobId: string): Promise<ReconciliationBody> {
  const response = await getReceiving(request, token, jobId, '/reconciliation')
  expect(response.status()).toBe(200)
  return (await readJsonSafe<ReconciliationBody>(response))!
}

export type ConditionView = { key: string; state: string; detailKey: string | null; canConfirm: boolean }

/** The `receivingComplete` condition as the transitions read model shows it for `start_processing`. */
export async function receivingCompleteView(request: APIRequestContext, token: string, jobId: string): Promise<ConditionView | undefined> {
  const response = await getReceiving(request, token, jobId, '/transitions')
  const body = await readJsonSafe<{ actions: Array<{ id: string; conditions: ConditionView[] }> }>(response)
  return body?.actions.find((action) => action.id === 'start_processing')?.conditions.find((condition) => condition.key === 'receivingComplete')
}

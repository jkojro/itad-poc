import { expect, type APIRequestContext } from '@playwright/test'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { advanceToReceiving, LOCK_HEADER, transitionOk, uniqueSuffix } from './itad-job-fixtures'
import { csv, importManifestOk } from './itad-manifest-fixtures'
import { listAssets, scanOk } from './itad-receiving-fixtures'

/** Sanitization API helpers for TC-ITAD-204+ (runs, results, retry, evidence, history). */
const BASE_URL = process.env.BASE_URL?.trim() || ''

function url(jobId: string, path: string): string {
  return `${BASE_URL}/api/itad/jobs/${encodeURIComponent(jobId)}${path}`
}

function headers(token: string, extra: Record<string, string> = {}, selectedOrgId?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    ...(selectedOrgId ? { Cookie: `om_selected_org=${selectedOrgId}` } : {}),
    ...extra,
  }
}

export type DataBearingAsset = { id: string; serial: string; updatedAt: string; status: string }

/**
 * Moves a fresh schedulable job to `processing` with `count` data-bearing devices (the
 * manifest says "yes"), all in `sanitization_required`.
 */
export async function processingJobWithDataBearingAssets(
  request: APIRequestContext,
  token: string,
  jobId: string,
  count: number,
): Promise<DataBearingAsset[]> {
  const tag = uniqueSuffix().slice(-6).toUpperCase().replace(/[^A-Z0-9]/g, 'X')
  const serials = Array.from({ length: count }, (_, index) => `SD${index + 1}${tag}`)
  await importManifestOk(
    request,
    token,
    jobId,
    { name: `sd-${tag}.csv`, content: csv([['Serial', 'Carries data'], ...serials.map((serial) => [serial, 'yes'])]) },
    { serial: 'Serial', dataBearing: 'Carries data' },
  )
  await advanceToReceiving(request, token, jobId)
  for (const serial of serials) await scanOk(request, token, jobId, serial)
  await transitionOk(request, token, jobId, { action: 'start_processing' })
  return currentAssets(request, token, jobId, serials)
}

/** Current version and status of the job's assets, in the order of `serials`. */
export async function currentAssets(request: APIRequestContext, token: string, jobId: string, serials: string[]): Promise<DataBearingAsset[]> {
  const items = (await listAssets(request, token, jobId, 'pageSize=100')).items
  return serials.map((serial) => {
    const asset = items.find((item) => item.serial === serial)
    if (!asset) throw new Error(`asset ${serial} not found`)
    return { id: asset.id, serial: asset.serial, updatedAt: asset.updatedAt, status: String(asset.status) }
  })
}

export async function startRun(
  request: APIRequestContext,
  token: string,
  jobId: string,
  asset: { id: string; updatedAt: string },
  body: Record<string, unknown> = { method: 'purge', tool: 'Blancco Drive Eraser', toolVersion: '7.9' },
) {
  return request.fetch(url(jobId, `/assets/${encodeURIComponent(asset.id)}/sanitization/runs`), {
    method: 'POST',
    headers: headers(token, { 'Content-Type': 'application/json', [LOCK_HEADER]: asset.updatedAt }),
    data: body,
  })
}

export async function startRunOk(request: APIRequestContext, token: string, jobId: string, asset: { id: string; updatedAt: string }): Promise<string> {
  const response = await startRun(request, token, jobId, asset)
  const body = await readJsonSafe<{ runId: string }>(response)
  expect(response.status(), `start failed: ${JSON.stringify(body)}`).toBe(201)
  return body!.runId
}

export async function recordResult(request: APIRequestContext, token: string, jobId: string, runId: string, body: Record<string, unknown>) {
  return request.fetch(url(jobId, `/sanitization/runs/${encodeURIComponent(runId)}/result`), {
    method: 'POST',
    headers: headers(token, { 'Content-Type': 'application/json' }),
    data: body,
  })
}

export async function abortRun(request: APIRequestContext, token: string, jobId: string, runId: string, reason: string | null) {
  return request.fetch(url(jobId, `/sanitization/runs/${encodeURIComponent(runId)}/abort`), {
    method: 'POST',
    headers: headers(token, { 'Content-Type': 'application/json' }),
    data: { reason },
  })
}

export async function approveRetry(
  request: APIRequestContext,
  token: string,
  jobId: string,
  asset: { id: string; updatedAt: string },
  reason: string | null,
) {
  return request.fetch(url(jobId, `/assets/${encodeURIComponent(asset.id)}/sanitization/retry`), {
    method: 'POST',
    headers: headers(token, { 'Content-Type': 'application/json', [LOCK_HEADER]: asset.updatedAt }),
    data: { reason },
  })
}

export async function attachEvidence(
  request: APIRequestContext,
  token: string,
  jobId: string,
  runIds: string[],
  file: { name: string; content: string },
) {
  const form = new FormData()
  form.append('file', new Blob([file.content], { type: 'text/plain' }), file.name)
  for (const runId of runIds) form.append('runIds', runId)
  return request.fetch(url(jobId, '/sanitization/evidence'), { method: 'POST', headers: headers(token), multipart: form })
}

export async function getSanitization(request: APIRequestContext, token: string, jobId: string, path: string, selectedOrgId?: string) {
  return request.fetch(url(jobId, path), { method: 'GET', headers: headers(token, {}, selectedOrgId) })
}

export type AssetSanitizationBody = {
  asset: { id: string; status: string; updatedAt: string }
  runs: Array<{
    id: string
    result: string | null
    tool: string
    toolVersion: string
    method: string
    verificationMethod: string | null
    verificationNotes: string | null
    abortReason: string | null
    evidence: Array<{ attachmentId: string; fileName: string }>
  }>
  history: Array<{ action: string; fromStatus: string | null; toStatus: string; reason: string | null; runId: string | null }>
}

export async function assetSanitization(request: APIRequestContext, token: string, jobId: string, assetId: string): Promise<AssetSanitizationBody> {
  const response = await getSanitization(request, token, jobId, `/assets/${encodeURIComponent(assetId)}/sanitization`)
  expect(response.status()).toBe(200)
  return (await readJsonSafe<AssetSanitizationBody>(response))!
}

/** `GET /api/itad/sanitization/tools` (tool and version suggestions). */
export async function getTools(request: APIRequestContext, token: string, search?: string) {
  const query = search ? `?search=${encodeURIComponent(search)}` : ''
  return request.fetch(`${BASE_URL}/api/itad/sanitization/tools${query}`, { method: 'GET', headers: headers(token) })
}

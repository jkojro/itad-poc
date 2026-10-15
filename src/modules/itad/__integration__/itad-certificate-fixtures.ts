import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, type APIRequestContext } from '@playwright/test'
import { apiRequest } from '@open-mercato/core/helpers/integration/api'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { LOCK_HEADER } from './itad-job-fixtures'
import { currentAssets, recordResult, startRunOk, type DataBearingAsset } from './itad-sanitization-fixtures'

export const CERTIFICATE_NUMBER = /^CDS-\d{4}-\d{5,}$/

export type CertificateItem = {
  id: string
  certificateNumber: string
  status: string
  locale: string
  sourceRun: { id: string; method: string; tool: string; toolVersion: string; completedAt: string }
  issuedBy: { id: string; name: string | null }
  supersedesCertificateId: string | null
  supersededByCertificateId: string | null
  supersedeReason: string | null
  voidReason: string | null
  voidReasonCode: string | null
  voidedBy: { id: string; name: string | null } | null
  updatedAt: string
}

export type AssetCertificatesBody = {
  items: CertificateItem[]
  currentCertificateId: string | null
  jobStatus: string
  issue: { allowed: boolean; code?: string; detail?: string | null }
  reissue: { allowed: boolean; detail: string | null }
  void: { allowed: boolean }
}

export type ReissuePreviewBody = {
  certificateId: string
  certificateNumber: string
  source: Record<string, unknown>
  differences: Array<{ field: string; from: unknown; to: unknown }>
  previewHash: string
}

const base = (jobId: string) => `/api/itad/jobs/${encodeURIComponent(jobId)}`

/** Starts and passes a run for one asset; returns the run id. */
export async function passAsset(
  request: APIRequestContext,
  token: string,
  jobId: string,
  asset: DataBearingAsset,
  mediaIdentifiers: string[] = [],
): Promise<string> {
  const runId = await startRunOk(request, token, jobId, asset)
  const response = await recordResult(request, token, jobId, runId, {
    result: 'PASS',
    verificationMethod: 'full_verification',
    mediaIdentifiers,
  })
  expect(response.status(), await response.text()).toBe(200)
  return runId
}

export async function refreshAsset(request: APIRequestContext, token: string, jobId: string, asset: DataBearingAsset) {
  const [fresh] = await currentAssets(request, token, jobId, [asset.serial])
  return fresh
}

export async function issueCertificate(request: APIRequestContext, token: string, jobId: string, assetId: string, locale: unknown = 'en') {
  return apiRequest(request, 'POST', `${base(jobId)}/assets/${encodeURIComponent(assetId)}/certificates`, { token, data: { locale } })
}

export async function issueCertificateOk(request: APIRequestContext, token: string, jobId: string, assetId: string, locale = 'en') {
  const response = await issueCertificate(request, token, jobId, assetId, locale)
  const body = await readJsonSafe<{ id: string; certificateNumber: string }>(response)
  expect(response.status(), `issue failed: ${JSON.stringify(body)}`).toBe(201)
  expect(body?.certificateNumber).toMatch(CERTIFICATE_NUMBER)
  return body!
}

export async function assetCertificates(request: APIRequestContext, token: string, jobId: string, assetId: string) {
  return apiRequest(request, 'GET', `${base(jobId)}/assets/${encodeURIComponent(assetId)}/certificates`, { token })
}

export async function assetCertificatesOk(request: APIRequestContext, token: string, jobId: string, assetId: string) {
  const response = await assetCertificates(request, token, jobId, assetId)
  expect(response.status()).toBe(200)
  return (await readJsonSafe<AssetCertificatesBody>(response))!
}

export async function downloadPdf(request: APIRequestContext, token: string, jobId: string, certificateId: string) {
  return apiRequest(request, 'GET', `${base(jobId)}/certificates/${encodeURIComponent(certificateId)}/pdf`, { token })
}

export async function downloadPdfOk(request: APIRequestContext, token: string, jobId: string, certificateId: string): Promise<Buffer> {
  const response = await downloadPdf(request, token, jobId, certificateId)
  expect(response.status()).toBe(200)
  expect(response.headers()['content-type']).toContain('application/pdf')
  return response.body()
}

/** Text of every page of a PDF, read with pdfjs-dist in a child process (ESM-only library). */
export function pdfText(bytes: Buffer): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'itad-cert-it-'))
  const file = path.join(dir, 'certificate.pdf')
  writeFileSync(file, bytes)
  const script = path.join(process.cwd(), 'src/modules/itad/services/__tests__/fixtures/extract-pdf-text.mjs')
  const pages = JSON.parse(execFileSync(process.execPath, [script, file], { encoding: 'utf8' })) as string[][]
  return pages.flat().join('\n')
}

export async function errorBody(response: { json: () => Promise<unknown> }) {
  return (await response.json().catch(() => null)) as { code?: string; detail?: string; fields?: string[] } | null
}

export async function reissuePreview(request: APIRequestContext, token: string, jobId: string, certificateId: string) {
  return apiRequest(request, 'GET', `${base(jobId)}/certificates/${encodeURIComponent(certificateId)}/reissue-preview`, { token })
}

export async function reissuePreviewOk(request: APIRequestContext, token: string, jobId: string, certificateId: string) {
  const response = await reissuePreview(request, token, jobId, certificateId)
  const body = await readJsonSafe<ReissuePreviewBody>(response)
  expect(response.status(), `preview failed: ${JSON.stringify(body)}`).toBe(200)
  return body!
}

/** `POST …/reissue` with the certificate version in the optimistic-lock header. */
export async function reissueCertificate(
  request: APIRequestContext,
  token: string,
  jobId: string,
  certificate: { id: string; updatedAt: string },
  data: { reason?: string | null; locale?: string; previewHash?: string },
) {
  return apiRequest(request, 'POST', `${base(jobId)}/certificates/${encodeURIComponent(certificate.id)}/reissue`, {
    token,
    data,
    headers: { [LOCK_HEADER]: certificate.updatedAt },
  })
}

/** `POST …/void` with the certificate version in the optimistic-lock header. */
export async function voidCertificate(
  request: APIRequestContext,
  token: string,
  jobId: string,
  certificate: { id: string; updatedAt: string },
  reason: string | null,
) {
  return apiRequest(request, 'POST', `${base(jobId)}/certificates/${encodeURIComponent(certificate.id)}/void`, {
    token,
    data: { reason },
    headers: { [LOCK_HEADER]: certificate.updatedAt },
  })
}

/** The asset's certificate with this id, from a fresh listing. */
export async function certificateById(request: APIRequestContext, token: string, jobId: string, assetId: string, id: string) {
  const body = await assetCertificatesOk(request, token, jobId, assetId)
  const item = body.items.find((entry) => entry.id === id)
  if (!item) throw new Error(`certificate ${id} not listed`)
  return item
}

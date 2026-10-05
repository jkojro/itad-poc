import { createHash } from 'node:crypto'
import { expect, type APIRequestContext } from '@playwright/test'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'

/** Manifest API helpers for TC-ITAD-1xx (multipart uploads are not covered by the core `apiRequest`). */
export type ManifestFile = { name: string; content: string; mimeType?: string }
export type ManifestMapping = { serial: string; customerAssetTag?: string; manufacturer?: string; model?: string }

export type ManifestPreviewBody = {
  sha256: string
  columns: string[]
  suggestedMapping: Partial<ManifestMapping>
  mapping: Partial<ManifestMapping>
  mappingError: string | null
  unusedColumns: string[]
  totalRows: number
  counts: { valid: number; invalid: number; skippedExisting: number; blankIgnored: number } | null
  rows: Array<{ rowNumber: number; state: string; serial: string | null; errors: string[] }>
  errors: Array<{ row: number; code: string; column?: string }>
  errorCount: number
  warningCount: number
}

export type ManifestItemBody = {
  id: string
  serial: string
  customerAssetTag: string | null
  manufacturer: string | null
  model: string | null
  sourceRow: number
  sourceData: Array<{ column: string; value: string }>
  importId: string
  importFileName: string
}

const BASE_URL = process.env.BASE_URL?.trim() || ''

export function sha256(content: string): string {
  return createHash('sha256').update(Buffer.from(content, 'utf-8')).digest('hex')
}

function manifestPath(jobId: string, suffix: string): string {
  return `${BASE_URL}/api/itad/jobs/${encodeURIComponent(jobId)}/manifest${suffix}`
}

function headers(token: string, selectedOrgId?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    ...(selectedOrgId ? { Cookie: `om_selected_org=${selectedOrgId}` } : {}),
  }
}

function filePart(file: ManifestFile) {
  return { name: file.name, mimeType: file.mimeType ?? 'text/csv', buffer: Buffer.from(file.content, 'utf-8') }
}

export async function previewManifest(
  request: APIRequestContext,
  token: string,
  jobId: string,
  file: ManifestFile,
  options: { mapping?: ManifestMapping; selectedOrgId?: string } = {},
) {
  return request.fetch(manifestPath(jobId, '/preview'), {
    method: 'POST',
    headers: headers(token, options.selectedOrgId),
    multipart: {
      file: filePart(file),
      ...(options.mapping ? { mapping: JSON.stringify(options.mapping) } : {}),
    },
  })
}

export async function importManifest(
  request: APIRequestContext,
  token: string,
  jobId: string,
  file: ManifestFile,
  options: { mapping: ManifestMapping; expectedSha256?: string; acceptWarnings?: boolean; selectedOrgId?: string },
) {
  return request.fetch(manifestPath(jobId, '/imports'), {
    method: 'POST',
    headers: headers(token, options.selectedOrgId),
    multipart: {
      file: filePart(file),
      mapping: JSON.stringify(options.mapping),
      expectedSha256: options.expectedSha256 ?? sha256(file.content),
      acceptWarnings: options.acceptWarnings ? 'true' : 'false',
    },
  })
}

/** Imports a file that must succeed; returns the import result. */
export async function importManifestOk(
  request: APIRequestContext,
  token: string,
  jobId: string,
  file: ManifestFile,
  mapping: ManifestMapping,
): Promise<{ importId: string; importedCount: number; skippedCount: number }> {
  const response = await importManifest(request, token, jobId, file, { mapping })
  const body = await readJsonSafe<{ importId: string; importedCount: number; skippedCount: number }>(response)
  expect(response.status(), `manifest import failed: ${JSON.stringify(body)}`).toBe(201)
  return body!
}

export async function getManifest(
  request: APIRequestContext,
  token: string,
  jobId: string,
  path: string,
  selectedOrgId?: string,
) {
  return request.fetch(manifestPath(jobId, path), { method: 'GET', headers: headers(token, selectedOrgId) })
}

export async function listManifestItems(
  request: APIRequestContext,
  token: string,
  jobId: string,
  query = '',
): Promise<{ items: ManifestItemBody[]; total: number }> {
  const response = await getManifest(request, token, jobId, `/items${query ? `?${query}` : ''}`)
  expect(response.status()).toBe(200)
  return (await readJsonSafe<{ items: ManifestItemBody[]; total: number }>(response))!
}

/** CSV text from rows of cells (no quoting needed for the values used in tests). */
export function csv(rows: string[][], delimiter = ','): string {
  return `${rows.map((row) => row.join(delimiter)).join('\r\n')}\r\n`
}

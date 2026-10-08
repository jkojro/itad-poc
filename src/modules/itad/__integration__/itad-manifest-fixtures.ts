import { createHash } from 'node:crypto'
import { expect, type APIRequestContext } from '@playwright/test'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'

/** Manifest API helpers for TC-ITAD-1xx (multipart uploads are not covered by the core `apiRequest`). */
/** A manifest upload: text `content` (CSV) or raw `buffer` (XLSX). */
export type ManifestFile = { name: string; content?: string; buffer?: Buffer; mimeType?: string }
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

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export function fileBytes(file: ManifestFile): Buffer {
  return file.buffer ?? Buffer.from(file.content ?? '', 'utf-8')
}

export function sha256(file: ManifestFile | string): string {
  const bytes = typeof file === 'string' ? Buffer.from(file, 'utf-8') : fileBytes(file)
  return createHash('sha256').update(bytes).digest('hex')
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
  return { name: file.name, mimeType: file.mimeType ?? 'text/csv', buffer: fileBytes(file) }
}

export async function previewManifest(
  request: APIRequestContext,
  token: string,
  jobId: string,
  file: ManifestFile,
  options: { mapping?: ManifestMapping; sheet?: string; selectedOrgId?: string } = {},
) {
  return request.fetch(manifestPath(jobId, '/preview'), {
    method: 'POST',
    headers: headers(token, options.selectedOrgId),
    multipart: {
      file: filePart(file),
      ...(options.mapping ? { mapping: JSON.stringify(options.mapping) } : {}),
      ...(options.sheet ? { sheet: options.sheet } : {}),
    },
  })
}

export async function importManifest(
  request: APIRequestContext,
  token: string,
  jobId: string,
  file: ManifestFile,
  options: { mapping: ManifestMapping; expectedSha256?: string; acceptWarnings?: boolean; sheet?: string; selectedOrgId?: string },
) {
  return request.fetch(manifestPath(jobId, '/imports'), {
    method: 'POST',
    headers: headers(token, options.selectedOrgId),
    multipart: {
      file: filePart(file),
      mapping: JSON.stringify(options.mapping),
      expectedSha256: options.expectedSha256 ?? sha256(file),
      acceptWarnings: options.acceptWarnings ? 'true' : 'false',
      ...(options.sheet ? { sheet: options.sheet } : {}),
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

/** Removes one manifest item; returns the raw response for status/body assertions. */
export async function deleteManifestItem(
  request: APIRequestContext,
  token: string,
  jobId: string,
  itemId: string,
  reason?: string | null,
) {
  return request.fetch(manifestPath(jobId, `/items/${encodeURIComponent(itemId)}`), {
    method: 'DELETE',
    headers: { ...headers(token), 'Content-Type': 'application/json' },
    data: { reason: reason ?? null },
  })
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

/** XLSX workbook bytes built in the test (`exceljs`), one entry per sheet: rows of cell values. */
export async function xlsxBuffer(sheets: Record<string, Array<Array<string | number | null>>>): Promise<Buffer> {
  const ExcelJS = (await import('exceljs')).default
  const workbook = new ExcelJS.Workbook()
  for (const [name, rows] of Object.entries(sheets)) {
    const worksheet = workbook.addWorksheet(name)
    for (const row of rows) worksheet.addRow(row)
  }
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

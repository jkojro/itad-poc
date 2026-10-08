import { createHash } from 'node:crypto'
import type { ManifestSheet } from '../../domain/manifest-mapping'
import { detectDelimiter, parseCsv } from './csv'

/**
 * Turns an uploaded manifest file into a `ManifestSheet` (spec "Import flow"). The
 * format is decided by extension and confirmed by content sniffing. Phase 1 reads CSV;
 * XLSX is recognized and reported as unsupported until its reader lands (Phase 2).
 */
export const MANIFEST_MAX_FILE_BYTES = 10 * 1024 * 1024

export type ManifestFileFormat = 'csv' | 'xlsx'

export type ManifestFileErrorCode = 'file_unreadable' | 'file_type_unsupported' | 'file_too_large' | 'file_empty'

export type ReadManifestFileResult =
  | {
      ok: true
      format: ManifestFileFormat
      sha256: string
      /** Sheet names (XLSX); empty for CSV. */
      sheets: string[]
      /** Sheet that was read; `null` for CSV. */
      sheetName: string | null
      sheet: ManifestSheet
    }
  | { ok: false; code: ManifestFileErrorCode }

const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04]

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  return dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : ''
}

function startsWith(buffer: Buffer, bytes: number[]): boolean {
  return bytes.every((byte, index) => buffer[index] === byte)
}

export function sha256Of(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

function readCsv(buffer: Buffer): ReadManifestFileResult {
  // Binary content (e.g. a renamed spreadsheet) is not a CSV.
  if (buffer.includes(0) || startsWith(buffer, ZIP_SIGNATURE)) return { ok: false, code: 'file_type_unsupported' }
  // Non-UTF-8 bytes decode to replacement characters, visible in the preview (spec Edge Cases).
  let text = new TextDecoder('utf-8').decode(buffer)
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  if (!text.trim()) return { ok: false, code: 'file_empty' }
  const parsed = parseCsv(text, detectDelimiter(text))
  if (!parsed.ok) return parsed
  return {
    ok: true,
    format: 'csv',
    sha256: sha256Of(buffer),
    sheets: [],
    sheetName: null,
    sheet: { rows: parsed.rows.map((row) => row.map((value) => ({ value }))) },
  }
}

export async function readManifestFile(input: { fileName: string; buffer: Buffer }): Promise<ReadManifestFileResult> {
  const { fileName, buffer } = input
  if (buffer.length > MANIFEST_MAX_FILE_BYTES) return { ok: false, code: 'file_too_large' }
  if (buffer.length === 0) return { ok: false, code: 'file_empty' }
  const extension = extensionOf(fileName)
  if (extension === 'csv') return readCsv(buffer)
  return { ok: false, code: 'file_type_unsupported' }
}

import type { CellValue, Worksheet } from 'exceljs'
import type { ManifestCell, ManifestSheet } from '../../domain/manifest-mapping'

/**
 * XLSX reader for manifest files (`exceljs`, loaded on demand so it never reaches a
 * client bundle or another route's startup). Cells become logical text values:
 * rich text → plain text, formula → cached result, date → ISO string, boolean →
 * TRUE/FALSE, error → its code. Flags tell the domain which warnings to raise.
 */

/** Columns read per row before the domain's own `too_many_columns` check decides. */
const MAX_COLUMNS_READ = 200
/** Physical rows read; the domain counts data rows against its 5,000 limit. */
const MAX_ROWS_READ = 6000

export type XlsxReadResult =
  | { ok: true; sheets: string[]; sheetName: string; sheet: ManifestSheet }
  | { ok: false; code: 'file_unreadable' | 'sheet_not_found' | 'file_empty' | 'too_many_rows' | 'too_many_columns' }

type RichTextLike = { richText: Array<{ text?: string }> }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !(value instanceof Date)
}

function textOf(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString()
  if (isObject(value)) {
    if (Array.isArray((value as RichTextLike).richText)) {
      return (value as RichTextLike).richText.map((part) => part.text ?? '').join('')
    }
    if ('text' in value) return textOf(value.text)
    if ('error' in value) return String(value.error ?? '')
  }
  return ''
}

export function toManifestCell(value: CellValue): ManifestCell {
  if (isObject(value) && ('formula' in value || 'sharedFormula' in value)) {
    const result = (value as { result?: unknown }).result
    return {
      value: textOf(result),
      formula: true,
      ...(typeof result === 'number' ? { numeric: true } : {}),
      ...(result instanceof Date ? { date: true } : {}),
    }
  }
  if (typeof value === 'number') return { value: textOf(value), numeric: true }
  if (value instanceof Date) return { value: textOf(value), date: true }
  return { value: textOf(value) }
}

function readSheet(worksheet: Worksheet): XlsxReadResult | ManifestSheet {
  if (worksheet.rowCount > MAX_ROWS_READ) return { ok: false, code: 'too_many_rows' }
  if (worksheet.columnCount > MAX_COLUMNS_READ) return { ok: false, code: 'too_many_columns' }
  const width = worksheet.columnCount
  const rows: ManifestCell[][] = []
  for (let rowNumber = 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber)
    const cells: ManifestCell[] = []
    for (let column = 1; column <= width; column += 1) cells.push(toManifestCell(row.getCell(column).value))
    rows.push(cells)
  }
  return { rows }
}

export async function readXlsx(buffer: Buffer, sheet?: string | null): Promise<XlsxReadResult> {
  // CommonJS package: the namespace sits on `default` under ESM interop, directly otherwise.
  const loaded = (await import('exceljs')) as unknown as { default?: typeof import('exceljs') } & typeof import('exceljs')
  const ExcelJS = loaded.default ?? loaded
  const workbook = new ExcelJS.Workbook()
  try {
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer)
  } catch {
    return { ok: false, code: 'file_unreadable' }
  }
  const sheets = workbook.worksheets.map((worksheet) => worksheet.name)
  if (sheets.length === 0) return { ok: false, code: 'file_empty' }
  const worksheet = sheet ? workbook.worksheets.find((candidate) => candidate.name === sheet) : workbook.worksheets[0]
  if (!worksheet) return { ok: false, code: 'sheet_not_found' }
  const read = readSheet(worksheet)
  if ('ok' in read) return read
  return { ok: true, sheets, sheetName: worksheet.name, sheet: read }
}

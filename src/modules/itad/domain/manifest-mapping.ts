import { validateSerial } from './serial'

/**
 * Manifest file rules: source column naming, mapping suggestion and validation, and
 * row evaluation. Pure — the file readers (`services/manifest-file/`) turn bytes into
 * `ManifestSheet`s; the import command persists the result.
 */

export const MANIFEST_TARGET_FIELDS = ['serial', 'customerAssetTag', 'manufacturer', 'model'] as const
export type ManifestTargetField = (typeof MANIFEST_TARGET_FIELDS)[number]

/** Target field → source column name. `serial` is required for an import. */
export type ManifestFieldMapping = Partial<Record<ManifestTargetField, string>>

export const MANIFEST_LIMITS = {
  maxDataRows: 5000,
  maxColumns: 100,
  maxCellLength: 4000,
  maxMappedFieldLength: 200,
  previewRows: 20,
  maxReportedErrors: 100,
} as const

/** One parsed cell: its logical value as text, plus how the reader obtained it. */
export type ManifestCell = {
  value: string
  /** XLSX: the cell held a number (leading zeros may already be gone). */
  numeric?: boolean
  /** XLSX: the cell held a formula; `value` is its cached result. */
  formula?: boolean
  /** XLSX: the cell held a date; `value` is its ISO string. */
  date?: boolean
}

/** Raw rows of one sheet in file order, blank rows included. */
export type ManifestSheet = { rows: ManifestCell[][] }

export type ManifestFileErrorCode = 'file_empty' | 'too_many_rows' | 'too_many_columns'

export type ManifestTable = {
  /** Unique, ordered names of every source column (empty/repeated headers renamed). */
  columns: string[]
  /** Data rows (blank rows dropped) with their 1-based row number in the sheet. */
  rows: Array<{ rowNumber: number; cells: ManifestCell[] }>
  blankRows: number
}

export type SourceDataEntry = { column: string; value: string }

export type RowErrorCode =
  | 'serial_missing'
  | 'serial_too_long'
  | 'serial_invalid_cell'
  | 'serial_duplicate_in_file'
  | 'field_too_long'

export type RowWarningCode = 'numeric_serial_cell' | 'formula_cell'

export type RowIssue<C extends string> = { row: number; code: C; column?: string }

export type EvaluatedRow = {
  rowNumber: number
  state: 'valid' | 'invalid' | 'skipped_existing'
  serial: string | null
  serialNormalized: string | null
  customerAssetTag: string | null
  manufacturer: string | null
  model: string | null
  sourceData: SourceDataEntry[]
  errors: RowErrorCode[]
}

export type ManifestEvaluation = {
  rows: EvaluatedRow[]
  counts: { valid: number; invalid: number; skippedExisting: number; blankIgnored: number }
  errors: RowIssue<RowErrorCode>[]
  warnings: RowIssue<RowWarningCode>[]
}

export type MappingErrorCode = 'serial_required' | 'unknown_column' | 'column_used_twice'

const HEADER_ALIASES: Record<ManifestTargetField, string[]> = {
  serial: ['serial', 'serial number', 'serial no', 'serial no.', 'serialnumber', 'sn', 's/n', 'numer seryjny', 'nr seryjny'],
  customerAssetTag: ['asset tag', 'tag', 'customer tag', 'customer asset tag', 'nr inwentarzowy', 'numer inwentarzowy'],
  manufacturer: ['manufacturer', 'make', 'vendor', 'brand', 'producent'],
  model: ['model', 'device model', 'model name', 'model number', 'nazwa modelu'],
}

/** Spreadsheet column letter for a 0-based index: 0 → A, 25 → Z, 26 → AA. */
export function columnLetter(index: number): string {
  let letters = ''
  let n = index + 1
  while (n > 0) {
    const remainder = (n - 1) % 26
    letters = String.fromCharCode(65 + remainder) + letters
    n = Math.floor((n - 1) / 26)
  }
  return letters
}

function isBlankRow(row: ManifestCell[]): boolean {
  return row.every((cell) => cell.value.trim() === '')
}

/** Names every column: trimmed header text, `Column {letter}` when empty, `Name (2)` when repeated. */
export function buildSourceColumns(header: ManifestCell[], width: number): string[] {
  const used = new Map<string, number>()
  const names: string[] = []
  for (let index = 0; index < width; index += 1) {
    const base = (header[index]?.value ?? '').trim() || `Column ${columnLetter(index)}`
    const key = base.toLocaleLowerCase('en-US')
    const seen = used.get(key) ?? 0
    used.set(key, seen + 1)
    names.push(seen === 0 ? base : `${base} (${seen + 1})`)
  }
  return names
}

/**
 * Splits a sheet into the header (first non-blank row) and data rows. The table is as
 * wide as the last column holding a value in any row, so no source value is dropped.
 */
export function buildManifestTable(
  sheet: ManifestSheet,
): { ok: true; table: ManifestTable } | { ok: false; code: ManifestFileErrorCode } {
  const headerIndex = sheet.rows.findIndex((row) => !isBlankRow(row))
  if (headerIndex < 0) return { ok: false, code: 'file_empty' }

  const dataRows: ManifestTable['rows'] = []
  let blankRows = 0
  let width = 0
  const widthOf = (row: ManifestCell[]) => {
    for (let index = row.length - 1; index >= 0; index -= 1) {
      if (row[index].value.trim() !== '') return index + 1
    }
    return 0
  }
  width = widthOf(sheet.rows[headerIndex])
  for (let index = headerIndex + 1; index < sheet.rows.length; index += 1) {
    const row = sheet.rows[index]
    if (isBlankRow(row)) {
      blankRows += 1
      continue
    }
    dataRows.push({ rowNumber: index + 1, cells: row })
    if (dataRows.length > MANIFEST_LIMITS.maxDataRows) return { ok: false, code: 'too_many_rows' }
    width = Math.max(width, widthOf(row))
  }
  if (dataRows.length === 0) return { ok: false, code: 'file_empty' }
  if (width > MANIFEST_LIMITS.maxColumns) return { ok: false, code: 'too_many_columns' }

  return {
    ok: true,
    table: { columns: buildSourceColumns(sheet.rows[headerIndex], width), rows: dataRows, blankRows },
  }
}

function aliasKey(value: string): string {
  return value.trim().toLocaleLowerCase('en-US').replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ')
}

/** Suggests a mapping from header aliases; each column is used at most once. */
export function suggestMapping(columns: string[]): ManifestFieldMapping {
  const mapping: ManifestFieldMapping = {}
  const taken = new Set<string>()
  for (const field of MANIFEST_TARGET_FIELDS) {
    const aliases = HEADER_ALIASES[field]
    const match = columns.find((column) => !taken.has(column) && aliases.includes(aliasKey(column)))
    if (match) {
      mapping[field] = match
      taken.add(match)
    }
  }
  return mapping
}

export function validateMapping(mapping: ManifestFieldMapping, columns: string[]): MappingErrorCode | null {
  if (!mapping.serial) return 'serial_required'
  const used = new Set<string>()
  for (const field of MANIFEST_TARGET_FIELDS) {
    const column = mapping[field]
    if (!column) continue
    if (!columns.includes(column)) return 'unknown_column'
    if (used.has(column)) return 'column_used_twice'
    used.add(column)
  }
  return null
}

/** Source columns not mapped to any process field, in file order. */
export function unusedColumns(mapping: ManifestFieldMapping, columns: string[]): string[] {
  const mapped = new Set(MANIFEST_TARGET_FIELDS.map((field) => mapping[field]).filter(Boolean))
  return columns.filter((column) => !mapped.has(column))
}

function optionalText(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed ? trimmed : null
}

/**
 * Evaluates every data row against the mapping and the serials already in the job.
 * Errors block the import; `skipped_existing` rows are reported and not imported;
 * warnings must be accepted by the operator. Expects a mapping that passed
 * `validateMapping`.
 */
export function evaluateManifestRows(input: {
  table: ManifestTable
  mapping: ManifestFieldMapping
  existingSerials: ReadonlySet<string>
}): ManifestEvaluation {
  const { table, mapping, existingSerials } = input
  const columnIndex = new Map(table.columns.map((column, index) => [column, index]))
  const indexOf = (field: ManifestTargetField) => (mapping[field] ? columnIndex.get(mapping[field]!) : undefined)
  const serialIndex = indexOf('serial')

  const errors: RowIssue<RowErrorCode>[] = []
  const warnings: RowIssue<RowWarningCode>[] = []
  const rows: EvaluatedRow[] = table.rows.map(({ rowNumber, cells }) => {
    const cellAt = (index: number | undefined) => (index === undefined ? undefined : cells[index])
    const rowErrors: Array<{ code: RowErrorCode; column?: string }> = []

    const sourceData = table.columns.map((column, index) => ({ column, value: cells[index]?.value ?? '' }))
    for (const [index, cell] of cells.entries()) {
      if (index >= table.columns.length) break
      if (cell.value.length > MANIFEST_LIMITS.maxCellLength) {
        rowErrors.push({ code: 'field_too_long', column: table.columns[index] })
      }
      if (cell.formula) warnings.push({ row: rowNumber, code: 'formula_cell', column: table.columns[index] })
    }

    const serialCell = cellAt(serialIndex)
    let serial: string | null = null
    let serialNormalized: string | null = null
    if (serialCell?.date) {
      rowErrors.push({ code: 'serial_invalid_cell', column: mapping.serial })
    } else {
      const validation = validateSerial(serialCell?.value)
      if (validation.ok) {
        serial = validation.serial
        serialNormalized = validation.normalized
        if (serialCell?.numeric) warnings.push({ row: rowNumber, code: 'numeric_serial_cell', column: mapping.serial })
      } else {
        rowErrors.push({ code: validation.code, column: mapping.serial })
      }
    }

    const mappedText = (field: Exclude<ManifestTargetField, 'serial'>) => {
      const value = optionalText(cellAt(indexOf(field))?.value)
      if (value && value.length > MANIFEST_LIMITS.maxMappedFieldLength) {
        rowErrors.push({ code: 'field_too_long', column: mapping[field] })
      }
      return value
    }
    const customerAssetTag = mappedText('customerAssetTag')
    const manufacturer = mappedText('manufacturer')
    const model = mappedText('model')

    for (const error of rowErrors) errors.push({ row: rowNumber, ...error })
    return {
      rowNumber,
      state: rowErrors.length > 0 ? 'invalid' : 'valid',
      serial,
      serialNormalized,
      customerAssetTag,
      manufacturer,
      model,
      sourceData,
      errors: rowErrors.map((error) => error.code),
    }
  })

  // Every row of a serial repeated inside the file is an error (spec Q5).
  const occurrences = new Map<string, number>()
  for (const row of rows) {
    if (row.serialNormalized) occurrences.set(row.serialNormalized, (occurrences.get(row.serialNormalized) ?? 0) + 1)
  }
  for (const row of rows) {
    if (row.serialNormalized && (occurrences.get(row.serialNormalized) ?? 0) > 1) {
      row.state = 'invalid'
      row.errors.push('serial_duplicate_in_file')
      errors.push({ row: row.rowNumber, code: 'serial_duplicate_in_file', column: mapping.serial })
    }
  }
  for (const row of rows) {
    if (row.state === 'valid' && row.serialNormalized && existingSerials.has(row.serialNormalized)) {
      row.state = 'skipped_existing'
    }
  }

  errors.sort((a, b) => a.row - b.row)
  return {
    rows,
    counts: {
      valid: rows.filter((row) => row.state === 'valid').length,
      invalid: rows.filter((row) => row.state === 'invalid').length,
      skippedExisting: rows.filter((row) => row.state === 'skipped_existing').length,
      blankIgnored: table.blankRows,
    },
    errors,
    warnings,
  }
}

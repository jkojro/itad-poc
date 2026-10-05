import { describe, expect, it } from '@jest/globals'
import {
  MANIFEST_LIMITS,
  buildManifestTable,
  columnLetter,
  evaluateManifestRows,
  suggestMapping,
  unusedColumns,
  validateMapping,
  type ManifestCell,
  type ManifestSheet,
  type ManifestTable,
} from '../manifest-mapping'

const row = (...values: string[]): ManifestCell[] => values.map((value) => ({ value }))
const sheet = (...rows: ManifestCell[][]): ManifestSheet => ({ rows })

function table(...rows: ManifestCell[][]): ManifestTable {
  const result = buildManifestTable(sheet(...rows))
  if (!result.ok) throw new Error(result.code)
  return result.table
}

describe('columnLetter', () => {
  it('follows spreadsheet lettering', () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(columnLetter)).toEqual(['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA'])
  })
})

describe('buildManifestTable (TEST-103)', () => {
  it('uses the first non-blank row as header and skips blank rows', () => {
    const result = table(row('', ''), row('Serial', 'Model'), row('A1', 'X'), row(' ', ''), row('A2', 'Y'))
    expect(result.columns).toEqual(['Serial', 'Model'])
    expect(result.rows.map((entry) => entry.rowNumber)).toEqual([3, 5])
    expect(result.blankRows).toBe(1)
  })

  it('names empty and repeated headers', () => {
    const result = table(row('Serial', '', 'Notes', 'notes', 'Notes'), row('A1', 'x', 'n1', 'n2', 'n3'))
    expect(result.columns).toEqual(['Serial', 'Column B', 'Notes', 'notes (2)', 'Notes (3)'])
  })

  it('widens to values beyond the header so nothing is dropped', () => {
    const result = table(row('Serial'), row('A1', '', 'extra'))
    expect(result.columns).toEqual(['Serial', 'Column B', 'Column C'])
  })

  it('reports empty files, missing data rows and limits', () => {
    expect(buildManifestTable(sheet())).toEqual({ ok: false, code: 'file_empty' })
    expect(buildManifestTable(sheet(row('', '')))).toEqual({ ok: false, code: 'file_empty' })
    expect(buildManifestTable(sheet(row('Serial')))).toEqual({ ok: false, code: 'file_empty' })
    const wide = Array.from({ length: MANIFEST_LIMITS.maxColumns + 1 }, (_, index) => `C${index}`)
    expect(buildManifestTable(sheet(row(...wide), row(...wide)))).toEqual({ ok: false, code: 'too_many_columns' })
    const tall = [row('Serial'), ...Array.from({ length: MANIFEST_LIMITS.maxDataRows + 1 }, (_, index) => row(`S${index}`))]
    expect(buildManifestTable(sheet(...tall))).toEqual({ ok: false, code: 'too_many_rows' })
  })
})

describe('mapping (TEST-103)', () => {
  it('suggests mappings from header aliases, case- and separator-insensitive', () => {
    expect(suggestMapping(['S/N', 'Asset_Tag', 'Vendor', 'Model', 'Cost Center'])).toEqual({
      serial: 'S/N',
      customerAssetTag: 'Asset_Tag',
      manufacturer: 'Vendor',
      model: 'Model',
    })
    expect(suggestMapping(['Numer seryjny', 'Producent'])).toEqual({ serial: 'Numer seryjny', manufacturer: 'Producent' })
    expect(suggestMapping(['Foo'])).toEqual({})
    expect(suggestMapping(['Serial Number', 'Device Model'])).toEqual({ serial: 'Serial Number', model: 'Device Model' })
  })

  it('validates the mapping against the columns', () => {
    const columns = ['SN', 'Model']
    expect(validateMapping({}, columns)).toBe('serial_required')
    expect(validateMapping({ serial: 'Missing' }, columns)).toBe('unknown_column')
    expect(validateMapping({ serial: 'SN', model: 'SN' }, columns)).toBe('column_used_twice')
    expect(validateMapping({ serial: 'SN', model: 'Model' }, columns)).toBeNull()
  })

  it('lists unused columns in file order', () => {
    expect(unusedColumns({ serial: 'SN' }, ['Dept', 'SN', 'Cost Center'])).toEqual(['Dept', 'Cost Center'])
  })
})

describe('evaluateManifestRows (TEST-103)', () => {
  const header = row('SN', 'Make', 'Cost Center', 'Notes')

  it('maps fields and captures the full row as parsed values, empty cells included', () => {
    const evaluation = evaluateManifestRows({
      table: table(header, row(' abc 123 ', 'Dell', 'CC-100', '')),
      mapping: { serial: 'SN', manufacturer: 'Make' },
      existingSerials: new Set(),
    })
    expect(evaluation.rows[0]).toMatchObject({
      rowNumber: 2,
      state: 'valid',
      serial: 'abc 123',
      serialNormalized: 'ABC123',
      manufacturer: 'Dell',
      customerAssetTag: null,
      model: null,
      sourceData: [
        { column: 'SN', value: ' abc 123 ' },
        { column: 'Make', value: 'Dell' },
        { column: 'Cost Center', value: 'CC-100' },
        { column: 'Notes', value: '' },
      ],
    })
    expect(evaluation.counts).toEqual({ valid: 1, invalid: 0, skippedExisting: 0, blankIgnored: 0 })
  })

  it('marks missing and too long serials and too long fields', () => {
    const evaluation = evaluateManifestRows({
      table: table(header, row('', 'Dell'), row('A'.repeat(101)), row('OK1', 'x'.repeat(201)), row('OK2', '', 'y'.repeat(4001))),
      mapping: { serial: 'SN', manufacturer: 'Make' },
      existingSerials: new Set(),
    })
    expect(evaluation.errors).toEqual([
      { row: 2, code: 'serial_missing', column: 'SN' },
      { row: 3, code: 'serial_too_long', column: 'SN' },
      { row: 4, code: 'field_too_long', column: 'Make' },
      { row: 5, code: 'field_too_long', column: 'Cost Center' },
    ])
    expect(evaluation.counts.invalid).toBe(4)
  })

  it('marks every row of a serial repeated in the file, after normalization', () => {
    const evaluation = evaluateManifestRows({
      table: table(header, row('abc 1'), row('X9'), row('ABC1')),
      mapping: { serial: 'SN' },
      existingSerials: new Set(),
    })
    expect(evaluation.rows.map((entry) => entry.state)).toEqual(['invalid', 'valid', 'invalid'])
    expect(evaluation.errors.map((error) => [error.row, error.code])).toEqual([
      [2, 'serial_duplicate_in_file'],
      [4, 'serial_duplicate_in_file'],
    ])
  })

  it('skips serials already in the job without making them errors', () => {
    const evaluation = evaluateManifestRows({
      table: table(header, row('abc1'), row('NEW1')),
      mapping: { serial: 'SN' },
      existingSerials: new Set(['ABC1']),
    })
    expect(evaluation.rows.map((entry) => entry.state)).toEqual(['skipped_existing', 'valid'])
    expect(evaluation.counts).toMatchObject({ valid: 1, skippedExisting: 1, invalid: 0 })
    expect(evaluation.errors).toEqual([])
  })

  it('reports reader warnings and rejects date cells as serials', () => {
    const evaluation = evaluateManifestRows({
      table: table(
        header,
        [{ value: '123', numeric: true }, { value: 'Dell', formula: true }],
        [{ value: '2026-01-01T00:00:00.000Z', date: true }],
      ),
      mapping: { serial: 'SN' },
      existingSerials: new Set(),
    })
    expect(evaluation.warnings).toEqual([
      { row: 2, code: 'formula_cell', column: 'Make' },
      { row: 2, code: 'numeric_serial_cell', column: 'SN' },
    ])
    expect(evaluation.errors).toEqual([{ row: 3, code: 'serial_invalid_cell', column: 'SN' }])
  })
})

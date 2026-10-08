import { describe, expect, it } from '@jest/globals'
import ExcelJS from 'exceljs'
import { readManifestFile } from '../read-manifest-file'
import { toManifestCell } from '../xlsx'

async function workbookBuffer(build: (workbook: ExcelJS.Workbook) => void): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  build(workbook)
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

describe('toManifestCell (TEST-102, XLSX part)', () => {
  it('turns cell values into logical text with reader flags', () => {
    expect(toManifestCell('ABC 1')).toEqual({ value: 'ABC 1' })
    expect(toManifestCell(123)).toEqual({ value: '123', numeric: true })
    expect(toManifestCell(new Date('2023-02-14T00:00:00.000Z'))).toEqual({ value: '2023-02-14T00:00:00.000Z', date: true })
    expect(toManifestCell({ richText: [{ text: 'Lap' }, { text: 'top' }] })).toEqual({ value: 'Laptop' })
    expect(toManifestCell({ formula: 'A1&"X"', result: 'SN1X' })).toEqual({ value: 'SN1X', formula: true })
    expect(toManifestCell({ formula: 'B1*2', result: 4 })).toEqual({ value: '4', formula: true, numeric: true })
    expect(toManifestCell({ text: 'link', hyperlink: 'https://example.test' })).toEqual({ value: 'link' })
    expect(toManifestCell({ error: '#N/A' })).toEqual({ value: '#N/A' })
    expect(toManifestCell(true)).toEqual({ value: 'TRUE' })
    expect(toManifestCell(null)).toEqual({ value: '' })
  })
})

describe('readManifestFile — XLSX (TEST-102, XLSX part)', () => {
  it('reads the first sheet by default, lists sheets and keeps empty cells', async () => {
    const buffer = await workbookBuffer((workbook) => {
      const laptops = workbook.addWorksheet('Laptops')
      laptops.addRow(['Serial', 'Model', 'Notes'])
      laptops.addRow(['ABC001', 'T14', null])
      laptops.addRow([123, { formula: 'B2&"s"', result: 'T14s' }, 'ok'])
      workbook.addWorksheet('Monitors').addRow(['Serial'])
    })
    const result = await readManifestFile({ fileName: 'Manifest.XLSX', buffer })
    if (!result.ok) throw new Error(result.code)
    expect(result).toMatchObject({ format: 'xlsx', sheets: ['Laptops', 'Monitors'], sheetName: 'Laptops' })
    expect(result.sheet.rows.map((row) => row.map((cell) => cell.value))).toEqual([
      ['Serial', 'Model', 'Notes'],
      ['ABC001', 'T14', ''],
      ['123', 'T14s', 'ok'],
    ])
    expect(result.sheet.rows[2][0]).toMatchObject({ numeric: true })
    expect(result.sheet.rows[2][1]).toMatchObject({ formula: true })
  })

  it('reads a requested sheet and reports an unknown one', async () => {
    const buffer = await workbookBuffer((workbook) => {
      workbook.addWorksheet('Laptops').addRow(['Serial'])
      const monitors = workbook.addWorksheet('Monitors')
      monitors.addRow(['Serial'])
      monitors.addRow(['MON-1'])
    })
    const monitors = await readManifestFile({ fileName: 'm.xlsx', buffer, sheet: 'Monitors' })
    expect(monitors).toMatchObject({ ok: true, sheetName: 'Monitors' })
    expect(await readManifestFile({ fileName: 'm.xlsx', buffer, sheet: 'Printers' })).toEqual({ ok: false, code: 'sheet_not_found' })
  })

  it('rejects a renamed non-zip file and a corrupt package', async () => {
    expect(await readManifestFile({ fileName: 'm.xlsx', buffer: Buffer.from('Serial\nA1\n') })).toEqual({
      ok: false,
      code: 'file_type_unsupported',
    })
    expect(await readManifestFile({ fileName: 'm.xlsx', buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]) })).toEqual({
      ok: false,
      code: 'file_unreadable',
    })
  })
})

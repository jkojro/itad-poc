import { describe, expect, it } from '@jest/globals'
import { detectDelimiter, parseCsv } from '../csv'
import { MANIFEST_MAX_FILE_BYTES, readManifestFile, sha256Of } from '../read-manifest-file'

const values = (result: Awaited<ReturnType<typeof readManifestFile>>) => {
  if (!result.ok) throw new Error(result.code)
  return result.sheet.rows.map((row) => row.map((cell) => cell.value))
}

describe('parseCsv (TEST-102, CSV part)', () => {
  it('handles quotes, escaped quotes and delimiters/line breaks inside quotes', () => {
    const parsed = parseCsv('SN,Notes\n"A,1","say ""hi""\nline 2"\n', ',')
    expect(parsed).toEqual({ ok: true, rows: [['SN', 'Notes'], ['A,1', 'say "hi"\nline 2']] })
  })

  it('accepts CRLF, CR and a missing final line break; keeps blank lines as rows', () => {
    expect(parseCsv('a;b\r\nc;d\r\n\r\ne;f', ';')).toEqual({ ok: true, rows: [['a', 'b'], ['c', 'd'], [''], ['e', 'f']] })
    expect(parseCsv('a\rb', ',')).toEqual({ ok: true, rows: [['a'], ['b']] })
  })

  it('keeps empty fields', () => {
    expect(parseCsv('a,,c\n,,\n', ',')).toEqual({ ok: true, rows: [['a', '', 'c'], ['', '', '']] })
  })

  it('rejects an unterminated quote', () => {
    expect(parseCsv('a,"b\n', ',')).toEqual({ ok: false, code: 'file_unreadable' })
  })
})

describe('detectDelimiter', () => {
  it('picks the most frequent delimiter of the header line, ignoring quoted text', () => {
    expect(detectDelimiter('SN;Model;Notes\nA,1;B;C')).toBe(';')
    expect(detectDelimiter('SN\tModel\n')).toBe('\t')
    expect(detectDelimiter('"a;b;c",d\n')).toBe(',')
    expect(detectDelimiter('\n\nSN;Model')).toBe(';')
    expect(detectDelimiter('SN\nA1')).toBe(',')
  })
})

describe('readManifestFile (TEST-102, CSV part)', () => {
  it('strips the UTF-8 BOM and returns the hash of the original bytes', async () => {
    const buffer = Buffer.from('﻿SN;Model\r\nabc 1;T14\r\n', 'utf-8')
    const result = await readManifestFile({ fileName: 'Manifest.CSV', buffer })
    expect(values(result)).toEqual([['SN', 'Model'], ['abc 1', 'T14']])
    expect(result).toMatchObject({ ok: true, format: 'csv', sheetName: null, sheets: [], sha256: sha256Of(buffer) })
  })

  it('rejects unsupported, binary, empty and oversized files', async () => {
    expect(await readManifestFile({ fileName: 'm.txt', buffer: Buffer.from('SN\nA') })).toEqual({ ok: false, code: 'file_type_unsupported' })
    expect(await readManifestFile({ fileName: 'm.xls', buffer: Buffer.from('SN\nA') })).toEqual({ ok: false, code: 'file_type_unsupported' })
    expect(await readManifestFile({ fileName: 'm.csv', buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]) })).toEqual({
      ok: false,
      code: 'file_type_unsupported',
    })
    expect(await readManifestFile({ fileName: 'm.csv', buffer: Buffer.alloc(0) })).toEqual({ ok: false, code: 'file_empty' })
    expect(await readManifestFile({ fileName: 'm.csv', buffer: Buffer.from(' \n \n') })).toEqual({ ok: false, code: 'file_empty' })
    expect(await readManifestFile({ fileName: 'm.csv', buffer: Buffer.alloc(MANIFEST_MAX_FILE_BYTES + 1, 0x41) })).toEqual({
      ok: false,
      code: 'file_too_large',
    })
  })
})

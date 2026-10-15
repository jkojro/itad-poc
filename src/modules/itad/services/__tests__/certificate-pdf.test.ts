import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from '@jest/globals'
import fontkit from '@pdf-lib/fontkit'
import { PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, decodePDFRawStream } from 'pdf-lib'
import type { CertificateSnapshot } from '../../domain/certificates'
import { createGlyphChecker, renderCertificatePdf, wrapText, type Translate } from '../certificate-pdf'

const translate: Translate = (_key, fallback, params) =>
  fallback.replace(/\{(\w+)\}/g, (_match, name: string) => params?.[name] ?? '')

const snapshot = (overrides: Partial<CertificateSnapshot> = {}): CertificateSnapshot => ({
  certificateNumber: 'CDS-2026-00001',
  issuedAt: '2026-10-14T10:00:00.000Z',
  issuedBy: 'Maria Kowalska',
  locale: 'en',
  supersedes: null,
  customerName: 'Müller & Söhne',
  jobReference: 'ITAD-2026-00010',
  customerReference: 'Česká společnost',
  jobName: 'Ștefan Industries refresh',
  assetSerial: 'SN-ABC-123',
  customerAssetTag: 'Αθήνα Systems',
  manufacturer: 'ООО Ромашка',
  model: 'Zażółć gęślą jaźń',
  mediaIdentifiers: ['NVME-A', 'NVME-B'],
  method: 'purge',
  methodDetail: null,
  tool: 'Blancco',
  toolVersion: '7.1',
  result: 'PASS',
  verificationMethod: 'full_verification',
  startedAt: '2026-10-14T07:00:00.000Z',
  completedAt: '2026-10-14T09:00:00.000Z',
  startedBy: 'Anna Nowak',
  resultRecordedBy: 'Piotr Wiśniewski',
  sourceRunId: 'r1',
  ...overrides,
})

/** Page texts of a rendered PDF, read back with pdfjs-dist in a child process. */
function extractPages(bytes: Uint8Array): string[][] {
  const dir = mkdtempSync(path.join(tmpdir(), 'itad-cert-'))
  const file = path.join(dir, 'certificate.pdf')
  writeFileSync(file, bytes)
  const script = path.join(__dirname, 'fixtures', 'extract-pdf-text.mjs')
  return JSON.parse(execFileSync(process.execPath, [script, file], { encoding: 'utf8' })) as string[][]
}

/**
 * The TrueType programs embedded in a PDF (the `/FontFile2` of each font descriptor).
 * Text extraction reads `/ToUnicode` and passes even when the glyphs cannot be drawn, so
 * the drawing side is checked on the font programs themselves.
 */
async function embeddedFontPrograms(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes)
  const programs = []
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict) || object.get(PDFName.of('Type')) !== PDFName.of('FontDescriptor')) continue
    const ref = object.get(PDFName.of('FontFile2'))
    const stream = ref instanceof PDFRef ? doc.context.lookup(ref) : null
    if (stream instanceof PDFRawStream) programs.push(fontkit.create(Buffer.from(decodePDFRawStream(stream).decode())))
  }
  return programs
}

describe('renderCertificatePdf (certificates spec "PDF", REQ-622)', () => {
  it('embeds font programs that draw every printed character', async () => {
    const bytes = await renderCertificatePdf(snapshot(), translate)
    const programs = await embeddedFontPrograms(bytes)
    expect(programs).toHaveLength(2)
    const printed = 'Certificate of Data Sanitization CDS-2026-00001 Müller & Söhne Česká společnost Ștefan Αθήνα ООО Ромашка Zażółć gęślą jaźń'
    for (const font of programs) {
      // A program without `cmap` (a broken subset) cannot map any character to a glyph.
      const mapped = Boolean((font as unknown as { directory: { tables: Record<string, unknown> } }).directory.tables.cmap)
      const missing = [...new Set(printed.replace(/\s/g, ''))].filter((char) => {
        if (!mapped) return true
        const glyph = font.glyphForCodePoint(char.codePointAt(0) as number)
        return glyph.id === 0 || glyph.path.toSVG() === ''
      })
      expect(missing).toEqual([])
    }
  })

  it('prints every snapshot text exactly, in every supported script', async () => {
    const bytes = await renderCertificatePdf(snapshot(), translate)
    expect(Buffer.from(bytes.slice(0, 5)).toString('latin1')).toBe('%PDF-')
    // Every value is drawn as one text run unless it wraps; manufacturer and model share a row.
    const text = extractPages(bytes).flat().join('\n')
    for (const value of [
      'CDS-2026-00001',
      'Müller & Söhne',
      'Česká společnost',
      'Ștefan Industries refresh',
      'Αθήνα Systems',
      'ООО Ромашка',
      'Zażółć gęślą jaźń',
      'Piotr Wiśniewski',
      'NVME-A',
      'NVME-B',
      'Blancco 7.1',
      'PASS',
      'ООО Ромашка Zażółć gęślą jaźń',
    ]) {
      expect(text).toContain(value)
    }
  })

  it('wraps a 100-character token without losing a character', async () => {
    const serial = Array.from({ length: 100 }, (_, i) => String.fromCharCode(65 + (i % 26))).join('')
    const text = extractPages(await renderCertificatePdf(snapshot({ assetSerial: serial }), translate)).flat()
    const index = text.findIndex((line) => serial.startsWith(line) && line.length > 0 && line.length < serial.length)
    expect(index).toBeGreaterThanOrEqual(0)
    let joined = ''
    for (let cursor = index; joined.length < serial.length && cursor < text.length; cursor += 1) joined += text[cursor]
    expect(joined).toBe(serial)
  })

  it('breaks onto more pages and repeats the number with "page N of M"', async () => {
    const mediaIdentifiers = Array.from({ length: 10 }, (_, i) => `${String(i).padStart(2, '0')}-${'M'.repeat(97)}`)
    const pages = extractPages(
      await renderCertificatePdf(snapshot({ mediaIdentifiers, methodDetail: 'x '.repeat(400).trim() }), translate),
    )
    expect(pages.length).toBeGreaterThan(1)
    pages.forEach((page, index) => {
      expect(page).toContain('CDS-2026-00001')
      expect(page).toContain(`Page ${index + 1} of ${pages.length}`)
    })
    // Read the body across pages without the repeated footer, which sits between them.
    const body = pages
      .map((page, index) =>
        page.filter((line) => line.trim() !== '' && line !== 'CDS-2026-00001' && line !== `Page ${index + 1} of ${pages.length}`),
      )
      .flat()
      .join('')
    for (const identifier of mediaIdentifiers) expect(body).toContain(identifier)
  })

  it('renders the same bytes for the same snapshot', async () => {
    const first = await renderCertificatePdf(snapshot(), translate)
    const second = await renderCertificatePdf(snapshot(), translate)
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true)
  })
})

describe('createGlyphChecker', () => {
  it('knows Latin, Greek and Cyrillic and refuses CJK', async () => {
    const hasGlyph = await createGlyphChecker()
    for (const char of 'ÜČȘΑЖął') expect(hasGlyph(char.codePointAt(0) as number)).toBe(true)
    expect(hasGlyph('東'.codePointAt(0) as number)).toBe(false)
  })
})

describe('wrapText', () => {
  const mono = { widthOfTextAtSize: (text: string) => text.length * 10 }
  it('keeps words together and breaks only an over-long token', () => {
    expect(wrapText('aa bb cc', mono, 1, 50)).toEqual(['aa bb', 'cc'])
    expect(wrapText('abcdefghijkl', mono, 1, 50)).toEqual(['abcde', 'fghij', 'kl'])
    expect(wrapText('one\ntwo', mono, 1, 50)).toEqual(['one', 'two'])
  })
})

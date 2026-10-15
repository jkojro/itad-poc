import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import type { CertificateSnapshot } from '../domain/certificates'

/**
 * Renders a Certificate of Data Sanitization (certificates spec "PDF"). A function of the
 * snapshot and the labels only: the stored PDF is generated once at issue and never again.
 *
 * Text is drawn exactly as stored, in Noto Sans (OFL, `assets/fonts/`) embedded in full,
 * so Latin with every European diacritic, Greek and Cyrillic print faithfully (REQ-622). Characters without a glyph are refused before issue (`createGlyphChecker`),
 * never substituted. Long values wrap and pages break; nothing is truncated.
 */
const FONT_DIR = path.join(process.cwd(), 'src', 'modules', 'itad', 'assets', 'fonts')

type FontBytes = { regular: Uint8Array; bold: Uint8Array }
let fontBytes: Promise<FontBytes> | null = null

function loadFontBytes(): Promise<FontBytes> {
  if (!fontBytes) {
    fontBytes = Promise.all([
      readFile(path.join(FONT_DIR, 'NotoSans-Regular.ttf')),
      readFile(path.join(FONT_DIR, 'NotoSans-Bold.ttf')),
    ]).then(([regular, bold]) => ({ regular: new Uint8Array(regular), bold: new Uint8Array(bold) }))
  }
  return fontBytes
}

/** Whether both certificate fonts have a glyph for a code point. */
export async function createGlyphChecker(): Promise<(codePoint: number) => boolean> {
  const { regular, bold } = await loadFontBytes()
  const fonts = [fontkit.create(regular as Buffer), fontkit.create(bold as Buffer)]
  return (codePoint) => fonts.every((font) => font.hasGlyphForCodePoint(codePoint))
}

export type Translate = (key: string, fallback: string, params?: Record<string, string>) => string

const PAGE = { width: 595.28, height: 841.89 }
const MARGIN = { top: 60, bottom: 60, side: 50 }
const LABEL_WIDTH = 170
const LINE = { body: 11, heading: 13, title: 20 }
const LEADING = 1.45
const MUTED = rgb(0.35, 0.35, 0.35)

type Fonts = { regular: PDFFont; bold: PDFFont }

/** Splits a value into lines that fit `maxWidth`; an over-long token is broken by character. */
export function wrapText(text: string, font: Pick<PDFFont, 'widthOfTextAtSize'>, size: number, maxWidth: number): string[] {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    const pushToken = (token: string) => {
      const candidate = line ? `${line} ${token}` : token
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        line = candidate
        return
      }
      if (line) lines.push(line)
      line = ''
      if (font.widthOfTextAtSize(token, size) <= maxWidth) {
        line = token
        return
      }
      // Break a token that cannot fit on any line (e.g. a long serial) by character.
      let chunk = ''
      for (const char of token) {
        if (font.widthOfTextAtSize(chunk + char, size) > maxWidth && chunk) {
          lines.push(chunk)
          chunk = char
        } else {
          chunk += char
        }
      }
      line = chunk
    }
    for (const token of paragraph.split(/ +/).filter((part) => part.length > 0)) pushToken(token)
    lines.push(line)
  }
  return lines
}

class Layout {
  readonly pages: PDFPage[] = []
  private page!: PDFPage
  private y = 0

  constructor(private readonly doc: PDFDocument, private readonly fonts: Fonts) {
    this.newPage()
  }

  private newPage() {
    this.page = this.doc.addPage([PAGE.width, PAGE.height])
    this.pages.push(this.page)
    this.y = PAGE.height - MARGIN.top
  }

  private ensure(height: number) {
    if (this.y - height < MARGIN.bottom) this.newPage()
  }

  title(text: string) {
    for (const line of wrapText(text, this.fonts.bold, LINE.title, PAGE.width - 2 * MARGIN.side)) {
      this.ensure(LINE.title * LEADING)
      this.page.drawText(line, { x: MARGIN.side, y: this.y - LINE.title, size: LINE.title, font: this.fonts.bold })
      this.y -= LINE.title * LEADING
    }
    this.y -= 6
  }

  heading(text: string) {
    this.y -= 8
    this.ensure(LINE.heading * LEADING + LINE.body * LEADING)
    this.page.drawText(text, { x: MARGIN.side, y: this.y - LINE.heading, size: LINE.heading, font: this.fonts.bold })
    this.y -= LINE.heading * LEADING
    this.page.drawLine({
      start: { x: MARGIN.side, y: this.y + 2 },
      end: { x: PAGE.width - MARGIN.side, y: this.y + 2 },
      thickness: 0.5,
      color: MUTED,
    })
    this.y -= 4
  }

  /** A label/value row; the value wraps in the value column and may continue on the next page. */
  row(label: string, value: string | null) {
    if (value === null || value === '') return
    const valueWidth = PAGE.width - 2 * MARGIN.side - LABEL_WIDTH
    const labelLines = wrapText(label, this.fonts.regular, LINE.body, LABEL_WIDTH - 10)
    const valueLines = wrapText(value, this.fonts.regular, LINE.body, valueWidth)
    const count = Math.max(labelLines.length, valueLines.length)
    for (let index = 0; index < count; index += 1) {
      this.ensure(LINE.body * LEADING)
      const baseline = this.y - LINE.body
      if (labelLines[index]) {
        this.page.drawText(labelLines[index], { x: MARGIN.side, y: baseline, size: LINE.body, font: this.fonts.regular, color: MUTED })
      }
      if (valueLines[index]) {
        this.page.drawText(valueLines[index], { x: MARGIN.side + LABEL_WIDTH, y: baseline, size: LINE.body, font: this.fonts.regular })
      }
      this.y -= LINE.body * LEADING
    }
  }

  paragraph(text: string) {
    for (const line of wrapText(text, this.fonts.regular, LINE.body, PAGE.width - 2 * MARGIN.side)) {
      this.ensure(LINE.body * LEADING)
      this.page.drawText(line, { x: MARGIN.side, y: this.y - LINE.body, size: LINE.body, font: this.fonts.regular })
      this.y -= LINE.body * LEADING
    }
  }

  footer(number: string, pageLabel: (page: number, total: number) => string) {
    const total = this.pages.length
    this.pages.forEach((page, index) => {
      const size = 9
      page.drawText(number, { x: MARGIN.side, y: MARGIN.bottom / 2, size, font: this.fonts.regular, color: MUTED })
      const label = pageLabel(index + 1, total)
      const width = this.fonts.regular.widthOfTextAtSize(label, size)
      page.drawText(label, { x: PAGE.width - MARGIN.side - width, y: MARGIN.bottom / 2, size, font: this.fonts.regular, color: MUTED })
    })
  }
}

function formatDate(iso: string, locale: string): string {
  const date = new Date(iso)
  const text = new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' }).format(date)
  return `${text} UTC`
}

export async function renderCertificatePdf(snapshot: CertificateSnapshot, t: Translate): Promise<Uint8Array> {
  const bytes = await loadFontBytes()
  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)
  // Embedded in full: the `@pdf-lib/fontkit` subsetter writes a Noto Sans program whose
  // glyphs mostly do not draw, while the text layer still reads correctly.
  const fonts: Fonts = {
    regular: await doc.embedFont(bytes.regular, { subset: false }),
    bold: await doc.embedFont(bytes.bold, { subset: false }),
  }
  const issuedAt = new Date(snapshot.issuedAt)
  doc.setTitle(`${t('itad.certificates.pdf.title', 'Certificate of Data Sanitization')} ${snapshot.certificateNumber}`)
  doc.setSubject(snapshot.certificateNumber)
  doc.setProducer('Open Mercato ITAD')
  doc.setCreator('Open Mercato ITAD')
  doc.setCreationDate(issuedAt)
  doc.setModificationDate(issuedAt)

  const layout = new Layout(doc, fonts)
  const date = (iso: string) => formatDate(iso, snapshot.locale)
  layout.title(t('itad.certificates.pdf.title', 'Certificate of Data Sanitization'))
  layout.row(t('itad.certificates.pdf.number', 'Certificate number'), snapshot.certificateNumber)
  layout.row(t('itad.certificates.pdf.issuedAt', 'Issued'), date(snapshot.issuedAt))
  if (snapshot.supersedes) {
    layout.row(t('itad.certificates.pdf.supersedes', 'Replaces certificate'), snapshot.supersedes)
  }

  layout.heading(t('itad.certificates.pdf.section.customer', 'Customer and job'))
  layout.row(t('itad.certificates.pdf.customer', 'Customer'), snapshot.customerName)
  layout.row(t('itad.certificates.pdf.job', 'ITAD job'), snapshot.jobReference)
  layout.row(t('itad.certificates.pdf.jobName', 'Job name'), snapshot.jobName)
  layout.row(t('itad.certificates.pdf.customerReference', 'Customer reference'), snapshot.customerReference)

  layout.heading(t('itad.certificates.pdf.section.device', 'Device'))
  layout.row(t('itad.certificates.pdf.serial', 'Serial number'), snapshot.assetSerial)
  layout.row(t('itad.certificates.pdf.assetTag', 'Customer asset tag'), snapshot.customerAssetTag)
  const makeModel = [snapshot.manufacturer, snapshot.model].filter(Boolean).join(' ')
  layout.row(t('itad.certificates.pdf.device', 'Manufacturer / model'), makeModel || null)
  layout.row(
    t('itad.certificates.pdf.mediaIdentifiers', 'Media identifiers'),
    snapshot.mediaIdentifiers.length ? snapshot.mediaIdentifiers.join('\n') : null,
  )

  layout.heading(t('itad.certificates.pdf.section.sanitization', 'Sanitization'))
  layout.row(
    t('itad.certificates.pdf.method', 'Method'),
    t(`itad.sanitization.method.${snapshot.method}`, snapshot.method),
  )
  layout.row(t('itad.certificates.pdf.methodDetail', 'Method detail'), snapshot.methodDetail)
  layout.row(t('itad.certificates.pdf.tool', 'Tool'), `${snapshot.tool} ${snapshot.toolVersion}`.trim())
  layout.row(t('itad.certificates.pdf.result', 'Result'), snapshot.result)
  layout.row(
    t('itad.certificates.pdf.verification', 'Verification'),
    snapshot.verificationMethod ? t(`itad.sanitization.verification.${snapshot.verificationMethod}`, snapshot.verificationMethod) : null,
  )
  layout.row(t('itad.certificates.pdf.startedAt', 'Started'), date(snapshot.startedAt))
  layout.row(t('itad.certificates.pdf.completedAt', 'Completed'), date(snapshot.completedAt))
  layout.row(t('itad.certificates.pdf.startedBy', 'Sanitization started by'), snapshot.startedBy)
  layout.row(t('itad.certificates.pdf.resultRecordedBy', 'Result recorded by'), snapshot.resultRecordedBy)

  layout.heading(t('itad.certificates.pdf.section.issue', 'Issue'))
  layout.row(t('itad.certificates.pdf.issuedBy', 'Issued by'), snapshot.issuedBy)
  layout.paragraph(
    t(
      'itad.certificates.pdf.statement',
      'This certificate confirms that the device above was sanitized with the recorded method and tool, and that the sanitization ended with the result PASS.',
    ),
  )

  layout.footer(snapshot.certificateNumber, (page, total) =>
    t('itad.certificates.pdf.page', 'Page {page} of {total}', { page: String(page), total: String(total) }),
  )
  return doc.save({ useObjectStreams: false })
}

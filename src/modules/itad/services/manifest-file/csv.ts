/**
 * Minimal RFC 4180 CSV reader for manifest files: quoted fields, escaped quotes (`""`),
 * delimiters and line breaks inside quotes, CRLF/LF/CR line endings. Input is decoded
 * text (BOM already removed).
 */
export type CsvDelimiter = ',' | ';' | '\t'

const CANDIDATE_DELIMITERS: CsvDelimiter[] = [',', ';', '\t']

/** Picks the delimiter that occurs most often outside quotes in the first non-empty line. */
export function detectDelimiter(text: string): CsvDelimiter {
  const counts = new Map<CsvDelimiter, number>(CANDIDATE_DELIMITERS.map((delimiter) => [delimiter, 0]))
  let inQuotes = false
  let sawContent = false
  for (const char of text) {
    if (char === '"') inQuotes = !inQuotes
    if (!inQuotes && (char === '\n' || char === '\r')) {
      if (sawContent) break
      continue
    }
    if (!inQuotes && counts.has(char as CsvDelimiter)) counts.set(char as CsvDelimiter, counts.get(char as CsvDelimiter)! + 1)
    if (char.trim()) sawContent = true
  }
  let best: CsvDelimiter = ','
  for (const delimiter of CANDIDATE_DELIMITERS) {
    if (counts.get(delimiter)! > counts.get(best)!) best = delimiter
  }
  return best
}

export type CsvParseResult = { ok: true; rows: string[][] } | { ok: false; code: 'file_unreadable' }

export function parseCsv(text: string, delimiter: CsvDelimiter): CsvParseResult {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let index = 0

  const endField = () => {
    row.push(field)
    field = ''
  }
  const endRow = () => {
    endField()
    rows.push(row)
    row = []
  }

  while (index < text.length) {
    const char = text[index]
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 2
          continue
        }
        inQuotes = false
      } else {
        field += char
      }
      index += 1
      continue
    }
    if (char === '"' && field === '') {
      inQuotes = true
    } else if (char === delimiter) {
      endField()
    } else if (char === '\r') {
      endRow()
      if (text[index + 1] === '\n') index += 1
    } else if (char === '\n') {
      endRow()
    } else {
      field += char
    }
    index += 1
  }
  if (inQuotes) return { ok: false, code: 'file_unreadable' }
  // A trailing line break does not open another row.
  if (field !== '' || row.length > 0) endRow()
  return { ok: true, rows }
}

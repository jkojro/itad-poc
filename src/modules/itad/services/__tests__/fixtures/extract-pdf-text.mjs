// Test helper: prints the text of every page of a PDF as JSON (`[["line", …], …]`).
// Runs as a separate node process because `pdfjs-dist` is ESM-only and Jest runs CommonJS.
import { readFileSync } from 'node:fs'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

const data = new Uint8Array(readFileSync(process.argv[2]))
const pdf = await pdfjs.getDocument({ data, verbosity: 0 }).promise
const pages = []
for (let index = 1; index <= pdf.numPages; index += 1) {
  const content = await (await pdf.getPage(index)).getTextContent()
  pages.push(content.items.map((item) => item.str).filter((text) => text.length > 0))
}
process.stdout.write(JSON.stringify(pages))

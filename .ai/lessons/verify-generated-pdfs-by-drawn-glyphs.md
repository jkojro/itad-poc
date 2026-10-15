---
title: "Verify generated PDFs by drawn glyphs, not only extracted text"
modules: ["itad"]
areas: ["testing", "debugging"]
topics: ["pdf", "fonts"]
---

# Verify generated PDFs by drawn glyphs, not only extracted text

**Context**: Certificates of Data Sanitization were rendered with `pdf-lib` + `@pdf-lib/fontkit` and Noto Sans embedded with `subset: true`. Most letters did not draw, yet every `pdfjs-dist` text-extraction test passed and the issue reached a user (fixed in PR #20, 2026-10-15).

**Problem**: Text extraction reads the `/ToUnicode` map, which stays correct even when the embedded font program cannot draw the glyphs. The `@pdf-lib/fontkit` subsetter produced exactly such a program (no `cmap`, empty outlines) for Noto Sans.

**Rule**: A PDF test must check the drawing side too: read the embedded `/FontFile2` programs and assert a glyph with an outline for every printed character, or rasterize a page (`pdftoppm`) and look at it before shipping a PDF change. Keep `subset: false` with `@pdf-lib/fontkit` unless a drawn-glyph test proves a subset renders.

**Applies to**: `src/modules/itad/services/certificate-pdf.ts` and its tests; any future PDF generator in the app.

# ITAD Certificates of Data Sanitization

**Date**: 2026-10-14
**Status**: Ready

> Spec 6 of the app-owned `itad` module. It follows `2026-10-02-itad-jobs.md`, `2026-10-05-itad-manifest-reconciliation.md`, `2026-10-09-itad-asset-sanitization.md`, `2026-10-11-itad-exceptions.md` and `2026-10-12-itad-pickup-calendar.md`.
>
> Source: "Documents & Certificate of Data Sanitization" domain brief (2026-10-14), requirements REQ-601 … REQ-618 and acceptance scenarios AC-601 … AC-605. The brief calls it "Epic 5", but Epic 5 in this repository is the pickup calendar, so this is **Epic 6**; the REQ-6xx numbering already fits. Module rules: `src/modules/itad/AGENTS.md`.

## TLDR

A **Certificate of Data Sanitization** is a customer-facing document. It proves that one device (asset) of one job passed sanitization, using the method, tool and people the workflow recorded. It is **evidence of a fact the workflow already recorded**, never the place where that fact is created. Job, asset and sanitization run stay the source of truth.

- **Scope.** One certificate covers one asset and is based on exactly one PASS sanitization run of that asset and job. A run can carry an optional list of **media identifiers** (e.g. the serials of two SSDs). There is no media entity.
- **Issue.** Issuing is an explicit action by a user holding `itad.certificates.issue`, never automatic after PASS. It works per asset or as "Issue all missing" on the job; bulk issue is many independent issues.
- **Snapshot and PDF.** At issue the certificate stores a **business snapshot** of what it shows and a **PDF generated once**. The PDF is kept through the installed `attachments` module, so a download years later returns exactly the issued bytes. The certificate shows only recorded facts:
  - "Sanitization started by";
  - "Result recorded by";
  - method, tool and tool version.
  It never shows a derived "operator".
- **Numbers.** Certificate numbers follow `CDS-{YYYY}-{NNNNN}`, a yearly sequence per organization, unique and never reused.
- **Statuses.** `issued` → `superseded` (reissue) or `void` (with a reason).
  - A reissue takes a fresh snapshot of the corrected source data, after a **preview** and a required reason, and gets a new number.
  - Reclassifying the asset to non-data-bearing voids its current certificate.
  - Nothing is deleted.
- **Closeout.** **`requiredDocumentsComplete` becomes a data condition with no manual confirmation.** Every active, data-bearing, sanitized asset of the job needs an `issued` certificate before `complete`.
- **Where users see it:**
  - Job: a "Documents" tab with counts (data-bearing, sanitized, required, issued, missing) and the list.
  - Asset detail: a "Certificates" section with the full history.

## Decisions (answers 2026-10-14)

| # | Question | Decision |
|---|---|---|
| Q1 | Media identifier | (a) with a change: an optional **list** of media identifiers recorded on the run (`mediaIdentifiers: string[]`). It is not a media entity; it is the snapshot of the identifiers the run covered. |
| Q2 | PDF generation | **Changed by Q12:** `pdf-lib` (MIT) with `@pdf-lib/fontkit` (MIT) and an embedded OFL Unicode font. The first answer (a dependency-free writer like `staff`'s) would have meant writing our own font-embedding engine. |
| Q3 | What is stored | (a) The snapshot in the database plus the PDF stored once in `attachments`. |
| Q4 | Number format | (a) `CDS-{YYYY}-{NNNNN}`, a yearly sequence per organization, never reused. |
| Q5 | "Operator" | **Changed.** No "operator" is derived from who started the run, because the system does not know who physically sanitized the device. The certificate states only recorded facts: "Sanitization started by" (`operatorUserId`, the user who started the run), "Result recorded by" (`finishedByUserId`), and the tool, tool version and method. |
| Q6 | Bulk issue | (a) Per asset, plus "Issue all missing" on the job. Every asset gets its own certificate; the bulk call reports per-asset failures. |
| Q7 | Reissue data | (a) plus **preview**. Correct the source, preview the data the new certificate will carry, give a required reason, then reissue. The certificate's data can never be edited by hand. |
| Q8 | Permissions | (a) Capabilities, not roles: `itad.certificates.view`, `itad.certificates.issue` and `itad.certificates.manage` (reissue, void). Admin is only the default grant of `issue` and `manage`; any role can receive them, e.g. a future Operations Manager. No sanitization feature implies them. |
| Q9 | Language | (a) Polish or English, chosen at issue and stored in the snapshot. |
| Q10 | Job-level PDF | (a) Out of scope. A Job Completion Report or Certificate Pack is a separate document. |
| Q11 | Manual void | (a) A user with `itad.certificates.manage` voids an `issued` certificate with a required reason. If the asset still requires a certificate, it counts as missing again. |

| Q12 | Characters the PDF cannot print | **(b)** An embedded Unicode font. The certificate is a formal customer document, so the invariant is: *text accepted as business data must be printed faithfully*, not *business data must fit our PDF generator's character set*. A correct company name must never block a certificate or come out altered. Latin-1 plus Latin Extended-A would not suffice even in Europe: Romanian `Ș`/`Ț`, Greek and Cyrillic fall outside it. |

## Problem Statement

- Sanitization results live only inside the module. Customers need a formal, per-device document that proves the data was sanitized according to the recorded method (clear, purge or destroy). Only `destroy` means physical destruction.
- Closeout today relies on a manual "required documents complete" confirmation that nothing checks.

## Facts from the current code

- **Sanitization run** (`itad_sanitization_runs`):
  - `method`, `methodDetail`, `tool`, `toolVersion` (required);
  - `operatorUserId`, which is the user who started the run (the start command sets it to the actor);
  - `startedAt`, `finishedAt`, `finishedByUserId`;
  - `result` (`PASS` / `FAIL`; an aborted run has `abortReason`), `verificationMethod`, `verificationNotes`;
  - evidence in `itad_sanitization_evidence`.
  - A completed run is immutable; only evidence can still be linked. There is no media identifier.
- **Asset** (`itad_assets`): `serial`, `customerAssetTag`, `manufacturer`, `model`, `dataBearing`, `status` (`sanitized` after PASS), soft delete (`deletedAt`).
- **Classification.** `itad.assets.classify` is the only writer of `dataBearing`. In processing and closeout review it needs `itad.sanitization.manage` and a reason (Epic 3).
- **Job conditions** (`domain/job-conditions.ts`): `requiredDocumentsComplete` is a manual condition today. Epic 4 already turned `noBlockingExceptions` into a data condition; this epic does the same for documents.
- **PDF:**
  - The app has no PDF library.
  - Core's `staff` module writes PDF 1.4 directly: base-14 fonts, with Polish glyphs mapped through a `/Differences` array. It lives in a private installed file, so it is a reference only and must not be imported.
- **Storage:**
  - `module-integrations/attachments.ts` is a port onto the installed `attachmentService`.
  - `createScoped({ …, buffer, persistLink })` runs `persistLink(tx, attachmentId)` inside the attachment's transaction; a throw rolls both back and removes the bytes.
  - `readScoped` returns the bytes for an owner check.

## Proposed Solution

### Eligibility (pure `domain/certificates.ts`)

An asset can get a certificate when **all** of these hold (REQ-601, REQ-605):
- the asset is active (not soft-deleted);
- `dataBearing === true`;
- `status === 'sanitized'`;
- the source run belongs to this asset and this job, is finished, and has `result === 'PASS'`;
- the asset has **no `issued` certificate at all**, whatever its run. This matches the rule of one current certificate per asset (REQ-621).
- the job status allows it (see "Job status" below).

The source run is the asset's **latest PASS run** (the run that made it `sanitized`). A FAIL or aborted run is never a source. If a later PASS run appears while an `issued` certificate exists, the way to a certificate for the new run is a **reissue**, which supersedes the old one. A plain issue is refused with `certificate_already_issued`. Every certificate keeps its own source run.

Rejection codes:
- `certificate_not_eligible`, with detail `not_data_bearing` / `not_sanitized` / `asset_voided` / `no_pass_run` / `job_status`;
- `certificate_already_issued`.

### Job status

| Job status | Issue | Reissue | Void |
|---|---|---|---|
| `draft`, `scheduled`, `in_transit`, `receiving` | no (nothing can be sanitized yet) | — | — |
| `processing`, `closeout_review` | yes | yes | yes |
| `on_hold` | as its pre-hold status | as pre-hold | as pre-hold |
| `completed` | yes (e.g. after a void) | **yes**: correcting a certificate after completion is a normal case | yes, with a warning that the completed job then lacks the certificate |
| `cancelled` | **no**: a cancelled job requires none (REQ-615) | yes: an existing document can still be corrected | yes |

Certificates are documents about facts that already happened. A finished or cancelled job does not freeze them; only new issues on a cancelled job are refused. Changing a certificate changes neither the job status nor its history.

### Required certificates (closeout condition)

For a job that is not cancelled:

```
required = active assets with dataBearing = true AND status = sanitized
missing  = required assets without an `issued` certificate
requiredDocumentsComplete = met ⇔ missing = 0
```

- It becomes a **data condition**: `manualAllowed: false`, detail `missingCertificates: N`.
- Assets with `dataBearing = false` are never required (REQ-613).
- Assets still waiting for sanitization are already blocked by `allAssetsProcessed`; they are not counted here.

### Snapshot

The fields mirror brief section 7. They are written once at issue and never change:

| Field | Source |
|---|---|
| `certificateNumber` | allocated at issue |
| `customerName` | `customers` company display name at issue (query engine) |
| `jobReference`, `customerReference`, `jobName` | job |
| `assetSerial`, `customerAssetTag`, `manufacturer`, `model` | asset |
| `mediaIdentifiers` | run (Q1) |
| `method`, `methodDetail`, `tool`, `toolVersion` | run |
| `result` | run (`PASS`) |
| `verificationMethod` | run |
| `startedAt`, `completedAt` | run `startedAt`, `finishedAt` |
| `startedBy`, `resultRecordedBy` | display names of run `operatorUserId` and `finishedByUserId` at issue (Q5) |
| `issuedAt`, `issuedBy` | issue time and the issuer's display name |
| `locale` | chosen at issue (Q9) |
| `supersedes` | number of the replaced certificate, on a reissue |

The certificate row stores the ids of the asset, job and source run, and of the issuing user. The users who started the run and recorded its result are traceable **through the source run**, which is immutable, so their ids are not duplicated (REQ-602).

### Issue (single and bulk)

`itad.certificates.issue` for one asset, in this order:
1. **Check.** Lock the job row, load the asset and its source run, and check eligibility.
2. **Build the source data** (everything on the certificate except number, issue time and issuer) and **validate printable characters**: every code point must have a glyph in the embedded font (see PDF). A failure is detectable up front, so it is refused here with 422 `certificate_unprintable_characters` and never burns a number. Every rejection happens before any number is allocated.
3. **Allocate the number** `CDS-{YYYY}-{NNNNN}` from `itad_reference_sequences` (kind `certificate`) in its own short transaction.
   - **The year follows the same convention as job references:** `referenceYearOf(at)`, the UTC year of the issue time, using the same allocator `allocateSequenceValue` and the existing `(tenant, organization, kind, year)` key.
   - The PDF must show the number, so the number exists before the file.
   - If a later step fails for a real reason (storage, a race found by the re-check), the number stays unused. The gap is accepted and logged, and a number is never used twice.
4. **Build** the snapshot and **render** the PDF (`services/certificate-pdf.ts`, a pure function from the snapshot to bytes).
5. **Store atomically** through `attachmentService.createScoped(…, persistLink)`. Inside `persistLink`, in the attachment's transaction:
   - lock the job row again (`SELECT … FOR UPDATE`);
   - **re-check the full eligibility** against fresh rows: the asset is active, `dataBearing = true`, `status = sanitized`, the source run is still the asset's latest PASS run, the asset has no `issued` certificate, and the job status allows it. Something may have changed between step 1 and here, e.g. a reclassification to non-data-bearing. If any check fails, throw: the attachment and its bytes roll back and the user gets the matching rejection code;
   - insert the certificate row with the attachment id (the partial unique index is the last guard against a race);
   - append the `issued` history row.

   The PDF and the certificate row commit together or not at all, and only for an asset that is eligible at commit time.

**Bulk** ("Issue all missing") runs the single issue for each missing asset of the job independently. One failure does not stop the others. The result lists the issued numbers and the per-asset failures with their codes.

### Reissue and void

- **Reissue preview** (`GET …/certificates/{id}/reissue-preview`) writes nothing. It returns a `ReissuePreview`:
  - the source data the new certificate would carry: customer, job, device, media identifiers, method, tool, times, started by, result recorded by, and the source run;
  - the differences against the current certificate;
  - a `previewHash`.

  It has **no certificate number, no issue time and no issuer**, because those exist only at the real issue. `previewHash` is a fingerprint of the canonical JSON of that source data (`node:crypto` SHA-256, used for change detection, not security).
- **Reissue** (`itad.certificates.reissue`, needs `itad.certificates.manage`), with `{ reason, locale, previewHash }`:
  1. Only for an `issued` certificate, in a job status that allows it.
  2. The reason is required (at least 3 characters).
  3. The source data is built again and its hash compared with `previewHash`. A mismatch means the data changed after the user saw it, so the reissue is refused with **409 `certificate_preview_stale`**, and the dialog loads a fresh preview. The user always confirms exactly what is issued.
  4. Character validation, number, snapshot and PDF follow the issue flow (steps 2–5), including the full re-check inside `persistLink`. In the reissue variant of that re-check, the old certificate being `issued` is expected rather than refused.
  5. **Order inside `persistLink`**, because the partial unique index allows only one `issued` certificate per asset:
     - set the old certificate to `superseded`, with the successor id filled after the insert, the reason, user and time;
     - flush;
     - insert the new `issued` certificate with `supersedes_certificate_id`;
     - link the old one's `superseded_by_certificate_id`;
     - append both history rows.

     All of this is one transaction, together with the attachment.
- **Void** (`itad.certificates.void`, needs `itad.certificates.manage`): `issued` → `void` with a required reason, user and time. The PDF and the snapshot stay.
- **Reclassification to non-data-bearing.** `itad.assets.classify` changing `dataBearing` true → false voids the asset's `issued` certificate inside the same transaction, with the system reason `reclassified_non_data_bearing` and the classifying user (REQ-614).
- **Job cancel** changes no certificate (REQ-615). A cancelled job requires none.

### PDF (`services/certificate-pdf.ts`, `pdf-lib` + `@pdf-lib/fontkit`)

- **Library.** `pdf-lib` builds the document and `@pdf-lib/fontkit` embeds TrueType fonts. Both are MIT-licensed, pure JavaScript and run server-side only. They are new dependencies, approved with Q12.
- **Font.** Noto Sans Regular and Bold (SIL Open Font License 1.1), stored in `src/modules/itad/assets/fonts/` with the `OFL.txt` licence file next to them. They are embedded **subset** (`subset: true`), so a certificate carries only the glyphs it uses. Noto Sans covers Latin with all European diacritics (including `Ș`, `Ț`, `Ő`, `Ű`), Greek, Cyrillic and typographic punctuation.
- **No substitution, no loss (REQ-622):**
  - Every snapshot text is drawn as the exact source string.
  - Before rendering, each code point is checked with fontkit `hasGlyphForCodePoint` against the embedded font. Scripts outside Noto Sans, such as CJK, Arabic or Hebrew, are **not printed wrongly**: the issue is refused with 422 `certificate_unprintable_characters`, naming the fields. This is a coverage limit of the shipped font, not a data error.
  - Additional scripts may require fallback fonts (e.g. Noto Sans CJK). Complex or right-to-left scripts such as Arabic and Hebrew also need shaping and BiDi layout support, which `pdf-lib` does not provide. The refusal rule (REQ-622) stays the same.
- **Layout:**
  - **Word wrapping** uses `font.widthOfTextAtSize`. A single token longer than a line, such as a long serial, is broken by character.
  - **Automatic page breaks**, with the certificate number and "page N of M" on every page.
  - Nothing is truncated; up to 10 media identifiers of 100 characters simply take more lines or pages.
- `services/certificate-pdf.ts` is a pure function `snapshot → bytes` (fonts are loaded once per process). It lays out:
  - title, number and issue date;
  - customer and job;
  - device: serial, tag, manufacturer/model, media identifiers;
  - sanitization: method, detail, tool and version, result, verification, started, completed, started by, result recorded by;
  - issued by and, for a reissue, "Replaces certificate {number}".
- **Labels** come from i18n in the certificate's locale. The document metadata (title, creation date) is set from the snapshot, so the same snapshot always renders the same content.
- **Tests:**
  - the PDF parses and contains the number;
  - text extracted with `pdfjs-dist` (already in the project) is **exactly** `Müller & Söhne`, `Česká společnost`, `Ștefan Industries`, `Αθήνα Systems` and a Cyrillic name;
  - a 100-character token wraps without losing a character;
  - 10 long media identifiers break onto a second page;
  - a CJK string refuses the issue with `certificate_unprintable_characters` instead of printing anything wrong.

### Auditability (REQ-618)

`itad_certificate_events` is append-only, one row per event:
- `issued` (with the `supersedes` link on a reissue);
- `superseded` (with reason and link to the successor);
- `voided` (with the reason; system reason for reclassification).

Each row records the actor and the time. Opening or downloading a certificate writes nothing (REQ-620). Every issue, reissue and void also goes through the command bus, which writes the platform audit log.

## Architecture

```
domain/certificates.ts            pure: eligibility, required/missing, snapshot shape, status transitions
services/certificate-pdf.ts        snapshot → PDF bytes with pdf-lib + fontkit, embedded Noto Sans (subset), wrapping, pages
assets/fonts/                      NotoSans-Regular.ttf, NotoSans-Bold.ttf, OFL.txt
services/certificate-reader.ts     certificates of an asset / job, counts, condition facts
services/certificate-writer.ts     issue / supersede / void inside a command's transaction; number allocation
commands/certificates.ts           itad.certificates.issue | issue_missing | reissue | void
commands/assets.ts                 classify true → false → voids the current certificate (same tx)
domain/job-conditions.ts           requiredDocumentsComplete becomes a data condition (ConditionDeps.loadDocumentFacts)
module-integrations/attachments.ts createScoped / readScoped for the PDF (partition privateAttachments)
api/jobs/[id]/certificates/…       list, issue, issue-missing, reissue-preview, reissue, void, download
components/…                       Asset "Certificates" section, Job "Documents" tab, issue/reissue/void dialogs
```

## Data Model

**`itad_certificates`:**

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `tenant_id`, `organization_id` | uuid | scope |
| `certificate_number` | text | `CDS-YYYY-NNNNN`; unique (tenant, org, number) across all statuses |
| `job_id`, `asset_id`, `sanitization_run_id` | uuid | same-module relations |
| `status` | text | `issued` / `superseded` / `void` |
| `snapshot` | jsonb | the snapshot above |
| `locale` | text | `pl` / `en` |
| `pdf_attachment_id` | uuid | scalar id of the stored PDF (`attachments`) |
| `issued_by_user_id`, `issued_at` | uuid, timestamptz | |
| `supersedes_certificate_id` | uuid null | on a reissue |
| `superseded_by_certificate_id`, `superseded_at`, `superseded_by_user_id`, `supersede_reason` | null | |
| `voided_at`, `voided_by_user_id`, `void_reason`, `void_reason_code` | null | `void_reason_code`: `manual` / `reclassified_non_data_bearing` |
| `created_at`, `updated_at` | timestamptz | `updated_at` is the optimistic-lock version for reissue and void |

Indexes:
- (tenant, org, `job_id`, `status`);
- (tenant, org, `asset_id`, `issued_at`);
- partial unique (tenant, org, `asset_id`) WHERE `status = 'issued'`, so at most one current certificate per asset.

**`itad_certificate_events`:** id, scope, `certificate_id`, `kind` (`issued` / `superseded` / `voided`), `reason`, `related_certificate_id`, `actor_user_id` (null = system), `created_at`. Append-only.

**`itad_sanitization_runs`:** add `media_identifiers jsonb null` (string array, at most 10 entries of up to 100 characters).
- It is set when the result is recorded on a single run.
- Bulk result recording leaves it empty.
- The run is still immutable after completion.

**`itad_reference_sequences`:** reused with a new kind `certificate`. Verified: its key is already `(tenant_id, organization_id, kind, year)` and `allocateSequenceValue` takes a kind, so no schema change is needed.

Migration: tables, indexes and the run column. There is no backfill; certificates exist only once issued. Reviewed before `yarn db:migrate`.

## API Contracts

Every route has `metadata` and `openApi`, is scoped to the tenant and readable organizations, and returns 404 for anything outside the caller's scope.

| Method & path | Feature | Purpose |
|---|---|---|
| `GET /api/itad/jobs/{id}/certificates` | `itad.certificates.view` | certificates of the job (all statuses) plus counts `{ dataBearing, sanitized, required, issued, missing }` and the missing assets |
| `GET /api/itad/jobs/{id}/assets/{assetId}/certificates` | `itad.certificates.view` | certificate history of one asset, with the current one marked |
| `POST /api/itad/jobs/{id}/assets/{assetId}/certificates` | `itad.certificates.issue` | issue `{ locale }` → 201 `{ id, certificateNumber }` |
| `POST /api/itad/jobs/{id}/certificates/issue-missing` | `itad.certificates.issue` | bulk issue `{ locale }` → `{ issued: [{ assetId, certificateNumber }], failed: [{ assetId, code }] }` |
| `GET /api/itad/jobs/{id}/certificates/{certId}/reissue-preview` | `itad.certificates.manage` | `ReissuePreview` (source data, differences, `previewHash`; no number, issue time or issuer); writes nothing |
| `POST /api/itad/jobs/{id}/certificates/{certId}/reissue` | `itad.certificates.manage` | `{ reason, locale, previewHash }` with the optimistic-lock header → 201 new certificate |
| `POST /api/itad/jobs/{id}/certificates/{certId}/void` | `itad.certificates.manage` | `{ reason }` with the optimistic-lock header → 200 |
| `GET /api/itad/jobs/{id}/certificates/{certId}/pdf` | `itad.certificates.view` | the stored PDF bytes (`readScoped`, owner = the certificate) |

**Errors:**

| Status | Codes |
|---|---|
| 400 | `reason_required`, `locale_invalid` |
| 409 | `certificate_not_eligible` (with detail), `certificate_already_issued`, `certificate_not_issued`, `certificate_preview_stale`; record conflict for a stale version |
| 422 | `certificate_unprintable_characters` (with the fields): a character has no glyph in the embedded font, e.g. CJK |
| 404 | outside scope |

**Changed:**
- `POST …/sanitization/runs/{runId}/result` accepts an optional `mediaIdentifiers: string[]`, an additive change.
- The `complete` transition: `requiredDocumentsComplete` becomes a data condition, so a manual confirmation of it is rejected with `confirmation_not_allowed`. This mirrors `noBlockingExceptions` in Epic 4. The jobs spec gets an amendment and changelog entry, as Epic 4 did.

**Events** (declared in `events.ts`):
- `itad.certificate.issued`, `itad.certificate.superseded`, `itad.certificate.voided`;
- payload `{ certificateId, certificateNumber, jobId, assetId, actorUserId, tenantId, organizationId }`;
- emitted after commit.

## UI/UX

- **Record result dialog:** an optional "Media identifiers" field, one per line, up to 10.
- **Asset detail → "Certificates" section** (`itad.certificates.view`):
  - a list with number, status badge (issued / superseded / void), issued at and by, source run (method, tool, completed), and "Open PDF";
  - the superseded/replaced-by link and the void reason;
  - "Issue certificate" when eligible and `issue` is granted, with a dialog for language and a summary of the data;
  - "Reissue" (preview, reason, language) and "Void" (reason) when `manage` is granted.
- **Job → "Documents" tab** (`itad.certificates.view`):
  - counts data-bearing / sanitized / required / issued / missing;
  - the list of missing assets with a link to each;
  - "Issue all missing" (`issue`), which shows the per-asset result;
  - a table of all certificates with filters by status, opening the PDF.
- **Status panel:** the `requiredDocumentsComplete` line shows "Missing certificates: N" when it is unmet.
- **Confirmation dialog of `complete`:** documents are no longer a checkbox; the condition shows met or unmet.
- **Quality:** the loading, empty, error and conflict states and the keyboard behaviour follow the module's existing dialogs. Strings are in all five locales; Polish uses "certyfikat", "wystaw", "wystaw ponownie" and "unieważnij".

## Requirements

REQ-601 … REQ-618 come from the brief; REQ-619 … REQ-622 are added by this spec.

| ID | Requirement |
|---|---|
| REQ-601 | A certificate can be issued only for an active, `dataBearing = true`, sanitized asset with a finished PASS run. |
| REQ-602 | Each certificate points to exactly one asset, job, customer (snapshot plus job link) and source PASS run. |
| REQ-603 | Each certificate has a unique, permanent number that is never reused. |
| REQ-604 | A certificate holds the customer-facing snapshot listed above. |
| REQ-605 | FAIL and aborted runs never become a certificate source. |
| REQ-606 | An issued certificate is immutable; corrections go through reissue. |
| REQ-607 | A reissue keeps the old certificate as `superseded`, records reason, user and time, and creates a new number. A preview comes first. |
| REQ-608 | Void needs a reason; the certificate stays in history. |
| REQ-609 | Asset detail shows every certificate of the asset and marks the current one. |
| REQ-610 | The job shows every certificate and the counts required / issued / missing. |
| REQ-611 | Before `complete`, every active data-bearing sanitized asset has an `issued` certificate. |
| REQ-612 | `requiredDocumentsComplete` is computed from data and cannot be confirmed manually. |
| REQ-613 | A non-data-bearing asset requires no certificate. |
| REQ-614 | Reclassifying to non-data-bearing voids the current certificate and keeps it. |
| REQ-615 | Cancelling a job does not change any certificate. |
| REQ-616 | Later changes to customer, job or user data never change an issued certificate (snapshot and stored PDF). |
| REQ-617 | Sanitization features do not grant issue, reissue or void. |
| REQ-618 | The full issue / supersede / void history is kept with user, time and reason. |
| REQ-619 | Downloading a certificate returns exactly the bytes stored at issue. |
| REQ-620 | Opening or downloading a certificate changes nothing. |
| REQ-621 | At most one `issued` certificate exists per asset at any time. |
| REQ-622 | The certificate PDF preserves all customer-facing snapshot text without character substitution or loss. A character the embedded font cannot print refuses the issue instead. |

## Edge Cases & Failure Scenarios

- **PDF or attachment write fails.**
  - No certificate row and no file are committed, because `persistLink` rolls back with the attachment.
  - The number allocated in step 3 stays unused; the gap is accepted and logged. Unprintable characters are refused earlier, in step 2, without spending a number.
  - The user sees an error and can retry.
- **Two users issue for the same asset at once.** The partial unique index lets one win. The other gets 409 `certificate_already_issued`.
- **Customer company deleted later.** The snapshot keeps the name; the certificate is unaffected.
- **Asset voided after issue** (removed in receiving). Not possible once processing has started, because asset removal is limited to receiving (Epic 2). The certificate would remain valid history either way.
- **Reclassified false → true after a void.** The asset needs sanitization again (Epic 3). After a new PASS it can get a new certificate whose source is the new run.
- **A job with no data-bearing assets.** `required = 0`, so the condition is met.
- **Reissue when the asset is no longer eligible** (e.g. reclassified meanwhile). The reissue is rejected with `certificate_not_eligible`; void remains possible.
- **Characters the embedded font cannot show** (CJK, Arabic, Hebrew with Noto Sans). The issue is refused with the fields named; nothing is substituted or dropped (REQ-622).
- **Data changes between check and commit** (reclassification, a new run, another issue). The full re-check in `persistLink` refuses it, and the attachment rolls back.
- **Data changes between preview and reissue.** 409 `certificate_preview_stale`; the dialog reloads the preview.
- **Later PASS run while a certificate is issued.** A plain issue is refused (`certificate_already_issued`); a reissue moves the certificate to the new run.

## Risks & Impact Review

- **Closeout contract change.** `requiredDocumentsComplete` can no longer be confirmed by hand. Jobs already in `closeout_review` with data-bearing sanitized assets will be blocked until their certificates are issued. This is intended and follows the same path as Epic 4. The jobs spec is amended; the existing TC-ITAD tests that confirm documents manually are updated.
- **New dependencies:** `pdf-lib` and `@pdf-lib/fontkit` (both MIT, server-side only), plus two Noto Sans font files (OFL 1.1, about 0.5 MB each) in the repository.
  - They are approved with Q12, because certificate correctness outweighs a minimal dependency count.
  - Versions are pinned. The fonts are loaded only by the certificate service, so they never reach a client bundle.
- **Coverage limit.** Scripts outside Noto Sans refuse the issue (REQ-622). Fallback fonts can extend coverage for simple scripts; RTL and complex scripts need shaping/BiDi support as well.
- **Additive elsewhere:** new tables, a run column, new routes, events and features.
- **Rollback:**
  - disable the routes and UI;
  - revert the condition to manual;
  - issued certificates stay as data.

## Phasing

1. **Phase 1 — Issue and view:**
   - data model and migration, `domain/certificates.ts`, PDF writer and layout;
   - issue command and API, PDF download;
   - media identifiers on record result;
   - Asset "Certificates" section;
   - features and default grants.
2. **Phase 2 — Reissue, void, reclassification:**
   - reissue with preview, void;
   - void on reclassification;
   - history events.
3. **Phase 3 — Job documents and closeout:**
   - "Documents" tab with counts, "Issue all missing";
   - `requiredDocumentsComplete` as a data condition, with the jobs spec amendment and test updates;
   - AC-601 … AC-605 end to end.

Each phase leaves the app working. Until Phase 3, closeout still uses the manual documents confirmation.

## Implementation Plan

**Phase 1:**
1. Entities `ItadCertificate` and `ItadCertificateEvent`, plus `ItadSanitizationRun.mediaIdentifiers`. Run `yarn db:generate`; the user reviews the SQL before migrating.
2. `domain/certificates.ts`: eligibility (including the job status table), required/missing, snapshot and `ReissuePreview` builders, preview hash, and character coverage. Unit tests cover every rejection detail, latest-PASS selection, FAIL/aborted exclusion, and the refusal when any issued certificate exists.
3. Add `pdf-lib` and `@pdf-lib/fontkit` (pinned) and the Noto Sans Regular/Bold fonts with `OFL.txt`. Then write `services/certificate-pdf.ts`, with unit tests:
   - the number is present;
   - `pdfjs-dist` text extraction is exact for `Müller & Söhne`, `Česká společnost`, `Ștefan Industries`, `Αθήνα Systems` and a Cyrillic name;
   - wrapping keeps every character;
   - page breaks work;
   - CJK refuses the issue.
4. `services/certificate-writer.ts` and `commands/certificates.ts` (issue) through `attachmentService.createScoped` with `persistLink`, which locks the job and re-checks the full eligibility. A unit or integration test changes the asset between check and commit and expects the rollback.
5. Routes: asset certificates list, issue, PDF download.
6. Record result accepts `mediaIdentifiers` (validator, command, dialog).
7. ACL: `itad.certificates.view` / `issue` / `manage`. Defaults: employee gets `view`; admin gets all via `itad.*`.
8. Asset detail "Certificates" section and issue dialog.
9. Integration tests:
   - TC-ITAD-501: issue for a sanitized asset; PDF downloads with the number and the run data; the snapshot matches.
   - TC-ITAD-502: not eligible (non-data-bearing, unknown, not sanitized, FAIL then no retry, cancelled job) → 409 with detail; a second issue for the same asset → 409.
   - TC-ITAD-503: FAIL → retry → PASS; the certificate's source is the PASS run (AC-602).
   - TC-ITAD-504: permissions. The sanitization features alone cannot issue (403); `view` alone can download but not issue.
   - TC-ITAD-505: snapshot immutability. After renaming the customer company and the job, the certificate and the PDF bytes are unchanged (REQ-616, REQ-619).

**Phase 2:**
1. Reissue (preview and command), void, events and history.
2. The classify hook: true → false voids the current certificate in the same transaction.
3. UI: reissue dialog with preview, void dialog, history in the section.
4. Integration tests:
   - TC-ITAD-506: reissue.
     - The preview writes nothing and has no number.
     - The old certificate becomes `superseded` and the new one gets a new number and the `supersedes` link.
     - The reason is required.
     - A stale `previewHash` (customer renamed after the preview) → 409 `certificate_preview_stale` (AC-604).
     - Reissue works on a completed job.
   - TC-ITAD-507: void with a reason; the asset is missing again; void without a reason → 400.
   - TC-ITAD-508: reclassify true → false voids the certificate with the system reason; the asset is no longer required (AC-605).
   - TC-ITAD-509: a cancelled job keeps its certificates unchanged (REQ-615).

**Phase 3:**
1. Job certificates list with counts, and bulk issue.
2. `requiredDocumentsComplete` as a data condition with `ConditionDeps.loadDocumentFacts`; update the jobs spec and the existing TC-ITAD tests that confirm documents manually.
3. "Documents" tab, status panel line, `complete` dialog.
4. Integration tests:
   - TC-ITAD-510: counts and "Issue all missing" with a mixed job (data-bearing, non-data-bearing, already issued).
   - TC-ITAD-511: `complete` is blocked with 9 of 10 certificates and passes with 10; a manual confirmation is rejected (AC-603).
   - TC-ITAD-512: UI. The Documents tab, issuing from the asset section, reissue preview, opening the PDF.
   - TC-ITAD-513: end to end AC-601.

Validation per phase:
- `yarn generate && yarn typecheck && yarn lint && yarn ds:check && yarn test`;
- the phase's TC-ITAD tests and the full TC-ITAD regression on the ephemeral environment.

## Changelog

- **2026-10-14:** first full draft, decisions Q1–Q11.
- **2026-10-14, review applied:**
  - eligibility requires no `issued` certificate on the asset at all (a later PASS run goes through reissue);
  - `persistLink` re-checks the full eligibility under the job lock;
  - `ReissuePreview` has no number, issue time or issuer, plus `previewHash` and 409 `certificate_preview_stale`;
  - the PDF never substitutes characters, wraps text and breaks pages; coverage was left open as Q12;
  - a job status table for issue, reissue and void;
  - an explicit supersede-then-insert order;
  - user traceability goes through the source run;
  - "destroyed" became "sanitized according to the recorded method".
- **2026-10-14, Q12 decided (b):**
  - an embedded Unicode font (Noto Sans, OFL) through `pdf-lib` and `@pdf-lib/fontkit`, which revises Q2;
  - REQ-622 (no substitution or loss);
  - a glyph-coverage check that refuses instead of altering text;
  - multi-script extraction tests with `pdfjs-dist`.
- **2026-10-14, final review:**
  - printable-character validation moved before number allocation;
  - the certificate year follows the job reference convention (UTC, `referenceYearOf`);
  - the fallback-font note now covers shaping and BiDi for RTL and complex scripts;
  - the sequence table already supports kinds;
  - status: Ready.

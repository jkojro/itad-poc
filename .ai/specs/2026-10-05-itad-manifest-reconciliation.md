# ITAD Manifest & Reconciliation

**Date**: 2026-10-05
**Status**: Implemented — all four phases verified (2026-10-09)

> Spec 2 of the app-owned `itad` module (after `2026-10-02-itad-jobs.md`). It adds entities to the same module and switches the `receivingComplete` condition from manual confirmation to data, as foreseen by the jobs spec ("Conditions"). The job lifecycle, transition table and transition command contract are unchanged. Module structure rules: `src/modules/itad/AGENTS.md`.

## TLDR

An operator imports the customer's manifest (CSV or XLSX; upload → column mapping → preview with row validation → import) into an ITAD job. Each row becomes an `ItadManifestItem`, one expected device. The original file is kept through the installed `attachments` module. During `receiving` the operator scans or types serial numbers. Every scan is logged as an `ItadIntakeScan`. The first scan of a serial creates an `ItadAsset`; a repeated scan creates no asset and stays a pending `DUPLICATE` scan until the operator resolves it. Reconciliation is **derived, never stored**, by comparing manifest items and assets on one shared normalized serial: `MATCHED`, `MISSING`, `UNEXPECTED`, plus pending `DUPLICATE` scans. `expectedAssetCount` and `receivedAssetCount` are derived counts, shown next to the unchanged manual `expectedAssetEstimate`. `receivingComplete` becomes a data condition (`source: 'data'`, `manualAllowed: false`). It is met when the job has a manifest and no pending duplicate. `MISSING` and `UNEXPECTED` are visible but do not block. The `start_processing` request itself is the operator's "receiving finished" signal.

## Problem Statement

Phase 2 of the jobs spec lets a supervisor confirm "receiving complete" by hand with a comment. Nothing records what was expected and what actually arrived, so missing or extra devices are invisible. A device scanned twice can be counted twice. Later stages (erasure, grading, certificates) need a per-device record. Customers send manifests mostly as Excel or CSV exports with their own column names.

## Goals

- REQ-101: import a manifest file (CSV, XLSX) into a job with column mapping, a preview and row-level validation; keep the original file, who imported it and when.
- REQ-102: a manifest serial is unique per job among active items. Duplicates inside a file, and invalid rows, are rejected before import. Rows whose serial is already in the job are skipped and reported.
- REQ-103: manifests can be extended by further imports, and single items can be removed. Changes made after receiving started are explicitly visible in the job history.
- REQ-104: receiving scan by serial (scanner or keyboard, Enter submits) creates an asset; a repeated serial creates no asset and records a `DUPLICATE` scan that must be resolved.
- REQ-105: derived reconciliation per item, asset and scan, plus derived `expectedAssetCount` and `receivedAssetCount`.
- REQ-106: `receivingComplete` is computed from data; manual confirmation of it is rejected.
- REQ-107: serial lookup: substring search within a job, exact or prefix search across jobs. Scoped by tenant and organization, and backed by indexes.
- REQ-108: wrong scans can be corrected (asset soft-delete with a reason) while receiving; asset details are editable.
- REQ-109: separate permissions for manifest view/manage and asset view/receive/manage.
- REQ-110: every source column of every manifest row is preserved on the item as parsed logical cell values (`sourceData`), and the original file is preserved byte for byte (attachment). Mapped fields drive the process, and unmapped fields stay available for audit, in-job lookup and customer queries.

## Non-goals

- Background or queued imports, and files over 5,000 data rows (Q11).
- Legacy `.xls`, ODS, and encodings other than UTF-8.
- Saved per-customer mapping templates.
- Assets without a readable serial; placeholder identifiers (Q7).
- Asset lifecycle beyond `received` (erasure, grading, disposition: later epics).
- Editing a manifest item in place. A correction is delete plus re-import.
- A `pg_trgm` extension or cross-job substring search (Q10).
- Registering a *different* physical device that carries an already-registered serial (see "Duplicate resolution"). The scan is kept as evidence and stays unresolved and blocking until a later exceptions mechanism handles it.

## Proposed Solution

### Reuse and ownership (brief §7, §9)

| Need | Decision | Why |
|---|---|---|
| Upload, column mapping, preview, import | **App-owned** flow in `itad`, following the `sync_excel` UX (upload → mapping → preview → import) and its header-detection idea | `sync_excel` is CSV-only and hard-wired to `customers.person` (its adapter throws for other entity types). Making it generic means ejecting it. `data_sync` is a queued provider-sync hub, which is too heavy for a file attached to one job (Q2) |
| Original file + who/when | **Installed `attachments`** (`attachmentService.createScoped`, owner `entityId: 'itad:itad_manifest_import'`, `recordId: <import id>`; `persistLink` writes the import rows in the same transaction; downloads via `readScoped`) | Existing scoped storage, quota, MIME and executable checks |
| XLSX parsing | **New dependency `exceljs` 4.4.0 (MIT)**, server-side only (Q3) | No spreadsheet library is installed; SheetJS's npm build is outdated |
| CSV parsing | Small RFC 4180 parser in `services/manifest-file/csv.ts` (quotes, escaped quotes, CRLF, BOM, delimiter `,` `;` or tab) | Installed private parser files must not be imported; the format is small |
| Progress/queue | Not used; synchronous, capped at 5,000 rows and 10 MB (Q11) | — |
| Duplicate tracking | **`ItadIntakeScan`** log (Q4) | DUPLICATE is a real process fact that must persist until resolved |

Alternatives rejected: storing the upload before preview (as `sync_excel` does) leaves orphan files when the operator abandons the wizard. Here preview is stateless and the file is sent again on import, so only imported files are stored.

### Domain rules

**Serial normalization** (`domain/serial.ts`, `normalizeSerial`; the only implementation, used by import, scan, search and tests): trim, remove all whitespace (including internal and non-breaking), uppercase with `toLocaleUpperCase('en-US')`. Dashes and other characters stay. An empty result is invalid. The maximum length is 100 characters after normalization. Example: `abc 123`, `ABC123` and ` abc123 ` → `ABC123`.

**Reconciliation** (`domain/reconciliation.ts`). Everything below is derived at read time, never stored:

| Subject | State | Rule |
|---|---|---|
| active manifest item | `MATCHED` | an active asset in the same job has the same normalized serial |
| active manifest item | `MISSING` | no such asset |
| active asset | `MATCHED` | an active manifest item in the same job has the same normalized serial |
| active asset | `UNEXPECTED` | no such manifest item |
| intake scan with result `duplicate` | `DUPLICATE` (pending) | `resolvedAt` is null (including scans flagged as a different device) |

- Because a serial is required and unique per job (for both items and assets), every active item and asset is always classifiable as exactly one state. The brief's "everything classifiable" is therefore guaranteed by construction, not checked at runtime.
- `expectedAssetCount` = active manifest items. `receivedAssetCount` = active assets. `expectedAssetEstimate` stays a manual field on the job.
- Scan results stored on `ItadIntakeScan` (`matched` / `unexpected` / `duplicate`) record what the operator saw at scan time. Only the pending-duplicate rule reads them. A later manifest import can turn an `unexpected` asset into `MATCHED`.

**`receivingComplete`** (`source: 'data'`, `manualAllowed: false`). `resolvedAt` is the only thing that decides whether a duplicate is closed. A scan resolved as same device is closed even if it was flagged as a different device before; the flag stays as history.
- `unmet` with detail `manifestMissing` when the job has no active manifest item;
- `unmet` with detail `differentDeviceUnresolved` when any scan has `result = duplicate AND flaggedDifferentDeviceAt IS NOT NULL AND resolvedAt IS NULL`. These close only through the later exceptions mechanism, or by a "same device" correction;
- `unmet` with detail `duplicatesPending` when any scan has `result = duplicate AND flaggedDifferentDeviceAt IS NULL AND resolvedAt IS NULL`;
- `met` otherwise.

`MISSING` and `UNEXPECTED` never block. The transition panel shows the counts so the operator decides with full information. A blind intake without a manifest is not possible in this epic. The jobs spec's Q-001 resolution foresaw exactly this switch.

**Where changes are allowed** (Q6, Q8, Q13). "Statuses" means the job's status; `on_hold` counts as its `statusBeforeHold`.

| Operation | Allowed when job is | Otherwise |
|---|---|---|
| manifest preview/import | `draft`, `scheduled`, `in_transit`, `receiving` (also `on_hold` from these) | 409 `manifest_locked` |
| manifest item delete | same as import; a `reason` (3–1000 characters) is required when the effective status is `receiving` | 409 `manifest_locked`; 400 `reason_required` |
| scan | `receiving` only (not `on_hold`) | 409 `receiving_not_active` |
| asset edit (tag, manufacturer, model, `dataBearing`) | `receiving` | 409 `assets_locked` |
| asset delete (reason required) | `receiving` | 409 `assets_locked` |
| duplicate resolution | `receiving` | 409 `receiving_not_active` |
| reads | any status, including terminal | — |

Job deletion stays draft-only (jobs spec). A deleted draft's manifest rows remain in the database, linked to the soft-deleted job, and are never returned.

**Manifest changes in history** (Q6 addition). Every import and every manifest item deletion stores `jobStatusAtChange`. The job's History panel shows these entries interleaved with status transitions. Entries made while the effective status was `receiving` carry a distinct "During receiving" badge, and their delete reason is shown.

**The original manifest is the durable source of every field the customer supplied**, including fields the ITAD process does not use. The original file is kept unchanged in `attachments` for the life of the job, and the import records its full column list (`source_columns`) and the mapping. Every column not mapped to a process field is recorded explicitly as unused, e.g. `Customer Cost Center`, `Department`, `Purchase Date` → unused.

**Two representations of the source, on purpose:**
- **attachment**: the byte-for-byte original customer file, for audit and reproduction of the whole document;
- **`sourceData`**: parsed logical cell values of one row, for row-level access without re-parsing, search over unmapped columns, and quick answers to customer queries.

"Equals the source row" (tests) means equality with the parsed logical values, not with raw bytes.

**Source data is preserved in full.** Every column of every imported row is kept on the manifest item as `sourceData`, an ordered list of `{ column, value }` pairs, whether or not the column is mapped. Mapped columns (`serial`, `customerAssetTag`, `manufacturer`, `model`) feed the ITAD process. Unmapped columns (e.g. cost centre, location, assigned user, purchase date, customer notes) stay available for audit, lookup and answering customer queries.
- **Column names:** the header text, trimmed. An empty header becomes `Column {letter}` (A, B, …, AA). A repeated header becomes `Name (2)`, `Name (3)`. The import stores the ordered `sourceColumns`, so every item of one import has the same column order.
- **Values:** stored as strings exactly as the file presents them, after the same XLSX cell conversion as mapped fields (rich text → text, formula → cached result, date → ISO). Empty cells are kept as `""`, so the full row shape is reproducible.
- **Limits:**
  - at most 100 columns per file, else file error `too_many_columns`;
  - a cell over 4,000 characters is row error `field_too_long`.
- **Owning import:** `sourceData` represents the row from the import that created the manifest item. A later import row with the same serial is skipped (`serial_exists_in_job`) and does **not** update the item's `sourceData` or mapped fields; the newer values exist only in that later original file. To correct an item's data, delete the item and import again.
- **Immutability:** source data never changes after import. Mapped fields are copies taken at import time; when an asset is matched, it shows its manifest item's source data through the link, without copying it. Soft-deleted items keep their source data.
- **Lookup:** the job-scoped item search also matches source data values (case-insensitive substring over the row's values within one job). Cross-job lookup stays serial-only.

### Import flow

1. **Upload and preview** — `POST /api/itad/jobs/{id}/manifest/preview` (multipart: `file`, optional `sheet`, optional `mapping`):
   - parses the file and detects the header row (the first non-empty row);
   - suggests a mapping from header aliases (`domain/manifest-mapping.ts`: e.g. serial ← `serial`, `serial number`, `serial no`, `sn`, `s/n`, `numer seryjny`; tag ← `asset tag`, `tag`, `customer tag`, `nr inwentarzowy`; manufacturer ← `manufacturer`, `make`, `vendor`, `brand`, `producent`; model ← `model`, `device model`, `model name`, `model number`, `nazwa modelu`);
   - validates all rows against the current manifest;
   - returns headers, the sheet list (XLSX), the suggested or applied mapping, the first 20 mapped rows with their per-row state, the counts (`valid`, `invalid`, `skippedExisting`, `blankIgnored`), up to 100 row errors (`row`, `code`), warnings, and the file's `sha256`.
   - It stores nothing.
2. **Mapping** — the UI lets the operator assign columns to `serial` (required), `customerAssetTag`, `manufacturer` and `model`, then re-runs the preview with that mapping.
3. **Import** — `POST /api/itad/jobs/{id}/manifest/imports` (multipart: `file`, `mapping`, optional `sheet`, `expectedSha256`, `acceptWarnings?`) re-parses and re-validates on the server. The import is **all-or-nothing on validity**: errors block, and any invalid row returns 400 `manifest_rows_invalid` with the row errors. Warnings block only until accepted. Rows whose serial already exists in the job are skipped and counted. In one transaction it stores the attachment, the `ItadManifestImport` row and one `ItadManifestItem` per new row.

Row validation codes:
- `serial_missing`;
- `serial_too_long`;
- `serial_duplicate_in_file` (every row of a duplicated serial is marked);
- `field_too_long` (tag, manufacturer and model are limited to 200 characters).

Skip code: `serial_exists_in_job`. Fully blank rows are ignored.

Warnings (non-blocking, but must be accepted). The preview lists them, and the import request must carry `acceptWarnings: true` when the file has any; otherwise it returns 400 `warnings_not_accepted`. In the UI that is an "I have reviewed the warnings" checkbox that enables Import:
- `numeric_serial_cell`: the XLSX serial cell is a number, so leading zeros may already be lost in the source;
- `formula_cell`: the cached result was used.

Other file-level rules:
- XLSX: first sheet by default; cell text from rich text and formula results. Dates are converted to ISO strings (a date in the serial column is reported as `serial_invalid_cell`).
- CSV: UTF-8 (BOM stripped). The delimiter is detected from the header row.
- File errors return 400: `file_unreadable`, `file_type_unsupported` (anything except `.csv` and `.xlsx`, with a content sniff), `file_empty`, `no_header_row`, `too_many_rows` (> 5,000 data rows), `file_too_large` (> 10 MB, checked against the attachments limit as well).
- The same file content **and sheet** already imported into the job returns 409 `manifest_already_imported`. The import identity is job + `sha256` + sheet name (`null` for CSV), so other sheets of one workbook can be imported separately. This makes double-submit idempotent. This is an MVP safeguard; a deliberate "import again" is a follow-up.
- An import that adds 0 items (everything skipped) succeeds and is recorded, so the history shows the attempt.

### Receiving scan

`POST /api/itad/jobs/{id}/scans` `{ serial }`. Inside one transaction that holds a row lock on the job (`SELECT … FOR UPDATE`, see Concurrency), the serial is normalized and:

| Situation | Effect | Response `result` |
|---|---|---|
| no active asset with this serial, an active manifest item has it | create asset (copies tag, manufacturer and model from the item) + scan `matched` | `MATCHED` + asset + item |
| no active asset, no manifest item | create asset (details empty) + scan `unexpected` | `UNEXPECTED` + asset |
| an active asset already has this serial | **no asset created**; scan `duplicate` (pending) linked to the existing asset | `DUPLICATE` + existing asset + scan id |

The response is 201 for every case, because a scan record is always created. An invalid serial returns 400 `serial_missing` or `serial_too_long`, and no scan record is created.

### Duplicate resolution

Two operator actions on a pending `duplicate` scan:

- **Resolve as same device**: `POST /api/itad/jobs/{id}/scans/{scanId}/resolve` `{ note? }`. The same device was scanned again. Sets `resolution = same_device`, `resolvedAt` and `resolvedBy`, and the duplicate stops blocking. Resolving is final.
- **Flag as different device**: `POST /api/itad/jobs/{id}/scans/{scanId}/flag-different-device` `{ note }`. Another physical device carries the same serial.
  - The note is required (3–1000 characters) and must say where the device is.
  - Sets `flaggedDifferentDeviceAt`, `flaggedDifferentDeviceBy` and `flaggedDifferentDeviceNote`.
  - The scan **stays unresolved and blocking** (`resolvedAt` null), and no asset is created. The intake scan keeps the fact that the device physically arrived, so it does not disappear from the business record.
  - The job cannot leave `receiving` through `start_processing` until a later exceptions mechanism registers the second device and closes the scan. Hold and cancel stay available.
  - A flagged scan can still be resolved as same device if the flag was a mistake. That correction is recorded with its own note. The flag fields stay set as history, and the scan is closed because `resolvedAt` is set.

Rules:
- Only a pending `duplicate` scan accepts these actions; anything else returns 409 `scan_not_resolvable`.
- If the referenced asset was deleted in the meantime, the scan still needs one of these actions. The UI shows "asset removed".

### Wrong-scan correction

`DELETE /api/itad/jobs/{id}/assets/{assetId}` `{ reason }` soft-deletes the asset and records `deletedBy`, `deleteReason` and `deletedAt`. The asset's scans stay in the log. Scanning the serial again later creates a new asset. Reconciliation recomputes automatically.

## Architecture and Data Flow

```
Manifest tab (CrudForm-less wizard: upload → mapping → preview → import)
   └─ POST manifest/preview ─▶ services/manifest-file/read-manifest-file.ts (csv.ts | xlsx.ts)
                               ▶ domain/manifest-mapping.ts (detect, map, validate rows) + domain/serial.ts
   └─ POST manifest/imports ─▶ command itad.manifest.import
                               ▶ attachmentService.createScoped({ persistLink: tx ⇒ lock job, insert import + items })
Receiving tab (scan input)
   └─ POST scans ─▶ command itad.assets.scan ─▶ lock job ─▶ asset? + intake scan
Reconciliation / lists ─▶ services/reconciliation-reader.ts (scoped SQL: counts + EXISTS-derived state)
Transition (existing) ─▶ services/job-condition-evaluator.ts builds ConditionDeps
                         { isCustomerValid, loadReceivingFacts } ─▶ domain/job-conditions.ts
```

- `services/job-condition-evaluator.ts` (named in the brief) replaces the inline `deps` built today in the transition command and the transitions GET route. It exports `buildConditionDeps({ em, queryEngine, scope })`. `ConditionJob` gains `id`, and `ConditionDeps` gains `loadReceivingFacts(jobId) → { activeManifestItems, pendingDuplicates }`. The domain stays pure.
- **Concurrency:** these commands take `SELECT … FOR UPDATE` on the job row inside their transaction before checking status or serial uniqueness:
  - manifest import, item delete, scan, asset delete, duplicate resolve;
  - the **transition command**: its condition evaluation moves inside the transaction after the lock. Today it evaluates before the transaction.

  This serializes scans with `start_processing`, so a duplicate can't slip in after `receivingComplete` was evaluated. It also serializes two scans of the same serial; the partial unique index is the backstop and maps to 409 `serial_conflict` if it ever fires. These operations do **not** bump `ItadJob.updatedAt`, so the job's edit form and transition dialog don't conflict on every scan. Asset edits use optimistic locking on the asset's own `updatedAt`.
- No cross-module ORM relations: the attachment is referenced by `attachmentId` (uuid), and users by id, resolved through `module-integrations/users.ts`.
- Commands are not undoable (`isUndoable: false`), consistent with the jobs spec. Corrections are explicit (delete with reason, resolve).

## Users, Permissions, and Scope

| Feature | Grants | Depends on | Default roles |
|---|---|---|---|
| `itad.jobs.view` (existing) | job summary counters: `expectedAssetCount`, `receivedAssetCount`, and the reconciliation counts (matched, missing, unexpected, pending duplicates) | — | unchanged |
| `itad.manifest.view` | manifest tab, item details including `sourceData`, imports, original file download | `itad.jobs.view` | admin (`itad.*`), employee |
| `itad.manifest.manage` | preview, import, delete item | `itad.manifest.view` | admin, employee |
| `itad.assets.view` | receiving tab, assets, scans, cross-job serial lookup | `itad.jobs.view` | admin, employee |
| `itad.assets.receive` | scan, edit asset details, resolve duplicates | `itad.assets.view` | admin, employee |
| `itad.assets.manage` | delete (void) assets | `itad.assets.view` | admin only |

Access rule by data kind:
- **Counters** are part of the job summary and need only `itad.jobs.view`. This covers the jobs list columns, the `/reconciliation` route and the status panel line, and exposes no per-device data.
- **Manifest details** (items, `sourceData`, imports, files) need `itad.manifest.view`.
- **Device details** (assets, scans) need `itad.assets.view`.
- **Source data on the Receiving side** needs both `itad.assets.view` and `itad.manifest.view`. Asset and scan responses never embed `sourceData`; they carry `manifestItemId`. The Receiving UI shows the "Source data" section only to users with `itad.manifest.view` and loads it from the manifest items route, which enforces that feature.

Feature-based checks only. Existing tenants receive the new defaults via `yarn mercato auth sync-role-acls` (rollout step). All queries filter the trusted `tenant_id` + `organization_id`, and ids from another organization return 404.

## Data Models

All tables carry `tenant_id` and `organization_id` (uuid, not null). Every unique and partial index starts with them.

### `ItadManifestImport` — `itad_manifest_imports`, entity id `itad:itad_manifest_import` (append-only)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `job_id` | uuid FK → `itad_jobs` (same module) | |
| `attachment_id` | uuid | installed `attachments` row, owner `itad:itad_manifest_import` / this id |
| `file_name`, `mime_type` | text | |
| `file_size` | integer | |
| `file_sha256` | text | unique with the sheet: (`tenant_id`, `organization_id`, `job_id`, `file_sha256`, `coalesce(sheet_name, '')`), an expression index |
| `format` | text | `csv` \| `xlsx` |
| `sheet_name` | text null | XLSX only; part of the import identity; `null` for CSV |
| `source_columns` | jsonb | ordered list of all source column names (after empty/duplicate-header naming) |
| `mapping` | jsonb | `{ fields: { serial, customerAssetTag?, manufacturer?, model? } → source column name, unused: [source column names not mapped] }` |
| `warnings` | jsonb | accepted warnings `{ code, row?, column? }` (capped at 500) |
| `accepted_warnings_by_user_id` | uuid null | set when warnings were accepted |
| `total_rows`, `imported_count`, `skipped_count`, `blank_count` | integer | |
| `skipped_rows` | jsonb | up to 500 `{ row, serial }` entries |
| `job_status_at_change` | text | effective status at import |
| `imported_by_user_id` | uuid | |
| `created_at` | timestamptz | |

Index: (`tenant_id`, `organization_id`, `job_id`, `created_at`).

### `ItadManifestItem` — `itad_manifest_items`, entity id `itad:itad_manifest_item`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `job_id` | uuid FK → `itad_jobs` | |
| `import_id` | uuid FK → `itad_manifest_imports` | |
| `source_row` | integer | 1-based row in the source sheet |
| `serial` | text | as in the file (trimmed) |
| `serial_normalized` | text | `normalizeSerial(serial)` |
| `customer_asset_tag`, `manufacturer`, `model` | text null | copies of the mapped columns |
| `source_data` | jsonb | all columns of the source row, `[{ column, value }]` in `source_columns` order; immutable |
| `created_at`, `updated_at` | timestamptz | |
| `deleted_at` | timestamptz null | |
| `deleted_by_user_id` | uuid null | |
| `delete_reason` | text null | |
| `delete_job_status` | text null | effective status at delete (history badge) |

Indexes:
- partial unique (`tenant_id`, `organization_id`, `job_id`, `serial_normalized`) `WHERE deleted_at IS NULL`;
- (`tenant_id`, `organization_id`, `job_id`, `deleted_at`).

### `ItadAsset` — `itad_assets`, entity id `itad:itad_asset`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `job_id` | uuid FK → `itad_jobs` | |
| `serial` | text | as scanned (trimmed) |
| `serial_normalized` | text | |
| `customer_asset_tag`, `manufacturer`, `model` | text null | copied from the matched item at scan; editable |
| `data_bearing` | boolean null | `null` = not yet determined (Q9) |
| `status` | text | `received` (only value in this epic; later epics extend it) |
| `received_at` | timestamptz | |
| `received_by_user_id` | uuid | |
| `created_at`, `updated_at` | timestamptz | `updated_at` is the optimistic-lock version |
| `deleted_at` | timestamptz null | |
| `deleted_by_user_id` | uuid null | |
| `delete_reason` | text null | |

Indexes:
- partial unique (`tenant_id`, `organization_id`, `job_id`, `serial_normalized`) `WHERE deleted_at IS NULL`;
- (`tenant_id`, `organization_id`, `serial_normalized` `text_pattern_ops`) `WHERE deleted_at IS NULL`, for cross-job exact and prefix lookup (declared via `@Index({ expression })` as in the jobs spec).

Job-scoped substring search (`ILIKE '%…%'` on `serial_normalized`, `customer_asset_tag`) runs within one job's rows, which are bounded at a few thousand, after the scope index.

Later epics attach media devices, erasure runs, grading and certificates to `ItadAsset` through same-module relations.

### `ItadIntakeScan` — `itad_intake_scans`, entity id `itad:itad_intake_scan`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `job_id` | uuid FK → `itad_jobs` | |
| `asset_id` | uuid FK → `itad_assets` | created asset, or the existing asset for `duplicate` |
| `manifest_item_id` | uuid null FK | matched item at scan time |
| `raw_serial` | text | |
| `serial_normalized` | text | |
| `result` | text | `matched` \| `unexpected` \| `duplicate` |
| `scanned_by_user_id` | uuid | |
| `scanned_at` | timestamptz | |
| `resolution` | text null | `same_device` (the only resolving outcome in this epic; the exceptions epic adds its own) |
| `resolution_note` | text null | |
| `resolved_by_user_id` | uuid null | |
| `resolved_at` | timestamptz null | |
| `flagged_different_device_at` | timestamptz null | |
| `flagged_different_device_by_user_id` | uuid null | |
| `flagged_different_device_note` | text null | |

Indexes:
- (`tenant_id`, `organization_id`, `job_id`, `scanned_at`);
- partial (`tenant_id`, `organization_id`, `job_id`) `WHERE result = 'duplicate' AND resolved_at IS NULL`, for the condition check.

Immutable except the different-device flag and the one-time resolution.

Migrations: one per phase, generated with `yarn db:generate`, reviewed and approved before `yarn db:migrate`.

## API, Command, and Error Contracts

All routes are custom routes with per-method `metadata` (`requireAuth`, `requireFeatures`) and `openApi`. They are nested under a job the caller can read (`loadReadableJob`; another organization's job → 404). These are job sub-resources with derived state and non-CRUD writes (import, scan, resolve), which is why `makeCrudRoute` is not used.

| Method / command | Path | Feature | Input | Success | Errors |
|---|---|---|---|---|---|
| `POST` | `/api/itad/jobs/{id}/manifest/preview` | `itad.manifest.manage` | multipart `file`, `sheet?`, `mapping?` (JSON) | 200 preview (see Import flow) | 400 file errors; 409 `manifest_locked` |
| `POST` `itad.manifest.import` | `/api/itad/jobs/{id}/manifest/imports` | `itad.manifest.manage` | multipart `file`, `mapping`, `sheet?`, `expectedSha256`, `acceptWarnings?` | 201 `{ importId, importedCount, skippedCount, skippedRows }` | 400 file errors / `mapping_invalid` / `manifest_rows_invalid` (+ `rowErrors`) / `file_changed` (sha mismatch) / `warnings_not_accepted`; 409 `manifest_locked` / `manifest_already_imported`; 413 attachment limits |
| `GET` | `/api/itad/jobs/{id}/manifest/imports` | `itad.manifest.view` | — | `{ items: [{ id, fileName, format, importedCount, skippedCount, importedBy: { id, name }, createdAt, jobStatusAtChange }] }` | 404 |
| `GET` | `/api/itad/jobs/{id}/manifest/imports/{importId}/file` | `itad.manifest.view` | — | original file stream (download) | 404 |
| `GET` | `/api/itad/jobs/{id}/manifest/items` | `itad.manifest.view` | `page`, `pageSize` (≤ 100), `search`, `reconciliation` (`matched`\|`missing`), `id?` (single item, used by the Receiving source data section) | `{ items: [{ id, serial, customerAssetTag, manufacturer, model, reconciliation, assetId, importId, sourceRow, sourceData }], total }`; `search` also matches source data values | 404 |
| `DELETE` `itad.manifest.delete_item` | `/api/itad/jobs/{id}/manifest/items/{itemId}` | `itad.manifest.manage` | `{ reason? }` | 200 | 400 `reason_required`; 409 `manifest_locked`; 404 |
| `POST` `itad.assets.scan` | `/api/itad/jobs/{id}/scans` | `itad.assets.receive` | `{ serial }` | 201 `{ result, scan, asset, manifestItem? }` | 400 `serial_missing`/`serial_too_long`; 409 `receiving_not_active` / `serial_conflict` |
| `GET` | `/api/itad/jobs/{id}/scans` | `itad.assets.view` | `page`, `pageSize`, `result?`, `pending?` | `{ items, total }` with actor names | 404 |
| `POST` `itad.assets.resolve_duplicate` | `/api/itad/jobs/{id}/scans/{scanId}/resolve` | `itad.assets.receive` | `{ note? }` | 200 | 409 `scan_not_resolvable` / `receiving_not_active` |
| `POST` `itad.assets.flag_different_device` | `/api/itad/jobs/{id}/scans/{scanId}/flag-different-device` | `itad.assets.receive` | `{ note }` | 200 | 400 `note_required`; 409 `scan_not_resolvable` / `receiving_not_active` |
| `GET` | `/api/itad/jobs/{id}/assets` | `itad.assets.view` | `page`, `pageSize`, `search`, `reconciliation` (`matched`\|`unexpected`) | `{ items: [{ id, serial, …, dataBearing, status, reconciliation, manifestItemId, receivedAt, receivedBy, updatedAt }], total }` (never `sourceData`) | 404 |
| `PUT` `itad.assets.update` | `/api/itad/jobs/{id}/assets/{assetId}` | `itad.assets.receive` | `customerAssetTag?`, `manufacturer?`, `model?`, `dataBearing?` (nullable); lock header | 200 `{ updatedAt }` | 400 `field_not_writable` (serial, status); 409 version / `assets_locked` |
| `DELETE` `itad.assets.delete` | `/api/itad/jobs/{id}/assets/{assetId}` | `itad.assets.manage` | `{ reason }`; lock header | 200 | 400 `reason_required`; 409 version / `assets_locked` |
| `GET` | `/api/itad/jobs/{id}/reconciliation` | `itad.jobs.view` (counts only, as on the jobs list) | — | `{ expectedAssetCount, receivedAssetCount, matched, missing, unexpected, pendingDuplicates, hasManifest }` | 404 |
| `GET` | `/api/itad/assets` | `itad.assets.view` | `serial` (≥ 3 chars, exact or prefix on normalized), `page`, `pageSize` | `{ items: [{ id, serial, jobId, jobReference, customerName, status, receivedAt }], total }` | 400 `serial_too_short` |

Changes to existing contracts, all additive:
- `GET /api/itad/jobs` items gain `expectedAssetCount` and `receivedAssetCount` (one grouped query per page).
- `GET /api/itad/jobs/{id}/transitions` condition detail can now carry `manifestMissing` / `duplicatesPending` / `differentDeviceUnresolved`.
- `POST …/transitions` with a `receivingComplete` confirmation now returns the existing 400 `confirmation_not_allowed`. This is a behavior change for clients that confirmed manually; see Risks.
- The history route response is unchanged. The History panel also reads `manifest/imports` and a new `GET /api/itad/jobs/{id}/manifest/changes` (imports + item deletions with `jobStatusAtChange`, actor, reason) and merges them by time.

Error format is the existing `itadJobError(status, code, message, fieldErrors?, extra?)` with translated messages.

## Events

| Event | Payload (all with `jobId`, `tenantId`, `organizationId`) | Emitted |
|---|---|---|
| `itad.manifest.imported` | `importId`, `importedCount`, `skippedCount`, `actorUserId` | after commit, persistent |
| `itad.manifest.item_deleted` | `itemId`, `serialNormalized`, `reason`, `actorUserId` | after commit, persistent |
| `itad.asset.received` | `assetId`, `scanId`, `result`, `actorUserId` | after commit |
| `itad.asset.updated` / `itad.asset.deleted` | `assetId`, `actorUserId`, (`reason`) | after commit |
| `itad.intake_scan.duplicate_detected` | `scanId`, `assetId`, `actorUserId` | after commit |
| `itad.intake_scan.resolved` | `scanId`, `resolution`, `actorUserId` | after commit |
| `itad.intake_scan.flagged_different_device` | `scanId`, `assetId`, `actorUserId` | after commit, persistent (input for the exceptions epic) |

There are no consumers in this epic. Ids serve as idempotency keys.

## UI and Interaction Contracts

Job detail (`/backend/itad/jobs/[id]`) gains two tabs next to the existing details/status/history. Each tab is visible only with its view feature.

**Manifest tab**
- Counters: expected, matched, missing.
- An "Import manifest" button opens a dialog wizard with three steps:
  1. file picker (`.csv`, `.xlsx`; drag-and-drop);
  2. mapping (`Select` per target field, prefilled from suggestions; sheet select for XLSX);
  3. preview `DataTable` (first 20 rows with a per-row state badge), count summary and row-error list.
- "Import" is disabled while any row is invalid; the reason is shown. Warnings are listed separately, and Import is enabled only after the "I have reviewed the warnings" checkbox is ticked.
- The mapping step lists the columns that will stay unused, so the operator sees them recorded as such. Buttons are disabled while a request is in flight.
- Items `DataTable` with search (serial, mapped fields and source data values) and a reconciliation filter. Row actions: "Source data" (dialog listing every source column and value in file order, with the import file name and source row) and "Remove" (dialog; the reason field becomes mandatory during receiving).
- The asset details dialog in the Receiving tab shows the matched manifest item's source data read-only, **only** when the user also has `itad.manifest.view` (loaded from the manifest items route by `manifestItemId`).
- An imports list with a download link per file.
- The whole tab is read-only when the manifest is locked, with an explanatory note.

**Receiving tab** (all write controls are hidden unless `status = receiving`; otherwise a note explains why)
- Scan input: autofocused, `Enter` submits, the field clears and keeps focus after every response so a hardware scanner (keyboard wedge) works continuously. Requests are serialized client-side so a fast scanner can't reorder responses.
- Last-result banner with an `aria-live="polite"` region and a `StatusBadge`:
  - MATCHED: success + manufacturer/model;
  - UNEXPECTED: warning;
  - DUPLICATE: error + link to resolve;
  - plus a short list of the last 10 scans.
- Counters: expected, received, matched, missing, unexpected, pending duplicates.
- Assets `DataTable` with job-scoped substring search and a reconciliation filter. Row actions: "Edit details" (dialog with `CrudForm`, optimistic lock, conflict UI) and "Remove scan" (`itad.assets.manage`, reason required).
- "Pending duplicates" list with two actions: "Same device" (resolves) and "Different device" (note required; the row stays in the list with a "Waiting for exception handling" badge and keeps blocking).

**Status panel:** the `receivingComplete` row now shows the data state with its detail (no manual confirm checkbox), plus a summary line, e.g. "9 matched · 1 missing · 1 unexpected".

**History panel:** manifest imports and deletions are interleaved with transitions. Entries made during receiving get a "During receiving" badge and show the reason.

**Jobs list:** two optional columns, "Expected (manifest)" and "Received".

**Serial lookup page** `/backend/itad/assets` (menu "ITAD → Assets", `itad.assets.view`): a search field (≥ 3 characters, exact/prefix) and a results `DataTable` linking to the job's Receiving tab.

All strings are i18n keys in the 5 locales. Every surface covers loading, empty, error and conflict states, works with keyboard only, renders in light and dark mode, and works at 390 px width (tables scroll horizontally). Status colors come from `StatusBadge` variants, never hard-coded.

## Security and Privacy

- Tenant and organization isolation as described under Permissions. Source data, original files and reasons are returned only with `itad.manifest.view`.
- **Source data may contain personal data.** Customer manifests often include unmapped columns such as the assigned employee's name or e-mail, or a location. They are stored as received and never copied into events, logs, or the global search index; events carry ids and counts only.
- **Q14 (decided: a):** `source_data` is stored unencrypted for the MVP. It is protected by access control and by limiting where it can flow:
  - readable only with `itad.manifest.view`, always scoped by tenant + organization + job;
  - never in events, command audit snapshots or log payloads (the import and delete commands record ids and counts only), and never in the global search index;
  - searchable only inside one job;
  - an asset shows it through its link to the manifest item, never as a copy;
  - retention and erasure when the process closes is a separate, later requirement.
- Original files are stored in the attachments private partition. They are downloadable only through the itad route, which checks `itad.manifest.view` and job scope.

## Edge Cases & Failure Scenarios

| Case | Behavior |
|---|---|
| CSV in Windows-1250 / other encoding | Garbled text is visible in the preview; documented limitation: "save as UTF-8" hint in the wizard |
| XLSX serial stored as number (e.g. `00123` → `123`) | Imported as shown by Excel's value; warning `numeric_serial_cell` in preview |
| Unmapped, empty-header or repeated-header columns | Kept in `sourceData` as `Column {letter}` / `Name (2)`; visible in the source data dialog and searchable |
| More than 100 columns / cell over 4,000 characters | 400 `too_many_columns` / row error `field_too_long` |
| Header row not first / merged cells | First non-empty row is the header; operator maps columns manually; unmappable → `no_header_row` |
| File changed between preview and import | `expectedSha256` mismatch → 400 `file_changed`; wizard returns to preview |
| Double-click Import / retry | Second request → 409 `manifest_already_imported` (same sha + sheet); UI shows success of the first |
| Workbook with sheets `Laptops` and `Monitors` | Each sheet imports separately; the same sheet twice → 409 |
| Attachment storage fails | Whole import rolls back (attachment service transaction + cleanup); 500 with retry message; no items created |
| Scan while job moved to `processing` concurrently | Row lock serializes; the scan sees `processing` → 409 `receiving_not_active` |
| Two operators scan same serial at once | Row lock serializes; second becomes `DUPLICATE` |
| Duplicate flagged as a different device | Stays pending and blocks `start_processing` (`differentDeviceUnresolved`); job can be held or cancelled; closed later by the exceptions mechanism |
| File with warnings imported without acceptance | 400 `warnings_not_accepted`; nothing stored |
| Asset with pending duplicate is deleted | Duplicate stays pending; resolve dialog shows "asset removed" |
| Manifest item deleted after its asset was scanned | Asset becomes `UNEXPECTED`; deletion visible in history with "During receiving" |
| Job put `on_hold` from `receiving` | Scans blocked; manifest import still allowed; condition evaluated on resume → `start_processing` |
| Zip bomb / huge XLSX | Rejected by 10 MB file cap before parsing; row cap checked while iterating; parse timeout surfaces `file_unreadable` |
| Empty manifest import (all rows skipped) | Recorded with 0 imported; does not satisfy `manifestMissing` unless items already exist |

## Risks & Impact Review

- **Behavior change for `receivingComplete`:**
  - Problem: existing jobs in `receiving` (dev and test data) can no longer be confirmed manually. They need a manifest import (and no pending duplicates) to move on.
  - Mitigation: none in code; this is the decision recorded in the jobs spec's Q-001.
  - Test impact: the jobs-spec integration tests that confirm `receivingComplete` manually (TEST-006/TEST-007 helpers `advanceToReceiving`, `CONFIRM`) are updated in Phase 4 to import a manifest and scan.
- **Blocking different-device duplicates:** until the exceptions epic ships, a job with such a scan cannot reach `processing`. This is accepted by the user (2026-10-05), because a device must not disappear from the business record. The workaround is hold or cancel.
- **New dependency `exceljs`:** about 20 MB installed, server-only, with its own transitive dependencies (`jszip`, etc.). It is loaded with a dynamic `import()` inside the XLSX reader, so it never enters a client bundle or another route's startup.
- **Transition command change** (evaluation moves inside the locked transaction): covered by the existing TEST-006 to TEST-010 plus the new concurrency test.
- **Row lock contention:** scans are short transactions on one job row, and receiving is done by a few operators per job, so contention is acceptable.
- **Rollback:** each phase's migration only adds tables and indexes; rollback is the reverse migration. Phase 4 can be reverted by restoring `manualCondition('receivingComplete')` without data loss.

## Integration Coverage

Tests in `src/modules/itad/__integration__/` (TC-ITAD-1xx) and unit tests in `src/modules/itad/**/__tests__/`. All tests create their own fixtures (company, job, files generated in the test).

| Test ID | Level | Scenario | Assertions | REQ |
|---|---|---|---|---|
| TEST-101 | unit | `normalizeSerial` table (spaces, NBSP, case, tabs, empty, 101 characters) | outputs/invalid | 102, 104, 107 |
| TEST-102 | unit | CSV parser (quotes, `;`, tab, CRLF, BOM, blank lines) and XLSX reader (rich text, formula, number, date cell) | rows, warnings | 101 |
| TEST-103 | unit | mapping detection + row validation (missing, too long, duplicate in file, existing in job); source column naming (empty, repeated headers) and full-row capture | codes, counts, `sourceData` equals the parsed logical values | 101, 102 |
| TEST-104 | unit | reconciliation + `receivingComplete` (no manifest, pending duplicate, flagged and unresolved, flagged then resolved, missing/unexpected only) | states, detail keys | 105, 106 |
| TEST-105 | API | preview → import CSV of 10 rows with 3 unmapped columns; download original; search by an unmapped value | counts, items, `mapping.unused` lists the 3 columns, no `source_data` in emitted event payloads, every item's `sourceData` equals its source row incl. unmapped and empty cells, attachment bytes equal upload, importer + time, search hit | 101 |
| TEST-106 | API | XLSX import with a non-standard header + explicit mapping; second sheet of the same workbook; first sheet again | items; 201; 409 `manifest_already_imported` | 101 |
| TEST-107 | API | invalid row and in-file duplicate; file with warnings without/with `acceptWarnings`; second import with overlap where an existing serial has a different unmapped value; same file again | 400 `manifest_rows_invalid`; 400 `warnings_not_accepted` then 201; skipped count, existing item's `sourceData` unchanged; 409 `manifest_already_imported` | 102, 103, 110 |
| TEST-108 | API | import or delete in `processing`; delete in `receiving` without/with reason | 409 `manifest_locked`; 400 `reason_required`; history entry with "during receiving" status | 103 |
| TEST-109 | API | scans: matched, unexpected, duplicate; scan outside `receiving` | results; asset count unchanged on duplicate; 409 | 104 |
| TEST-110 | API | resolve as same device (and twice → 409); flag as different device (missing note → 400; stays pending and `differentDeviceUnresolved`; later resolved as same device → condition no longer blocked by it, flag fields kept); asset edit with stale version; asset delete with/without `itad.assets.manage` | 200/400/409/403 | 104, 108, 109 |
| TEST-111 | API | 20 parallel scans of 10 serials (2 each) | exactly 10 assets, 10 duplicates, no 5xx | 104 |
| TEST-112 | API (**E2E acceptance**) | 10 manifest items `ABC001…ABC010`; scan `ABC001…ABC009` + `XYZ999` | 9 matched, `ABC010` missing, `XYZ999` unexpected, `receivingComplete` met, `start_processing` succeeds with no confirmation | 105, 106 |
| TEST-113 | API | duplicate pending → `start_processing`; duplicate flagged as different device → `start_processing`; manual confirmation of `receivingComplete` | 400 `condition_unmet` (`duplicatesPending`); 400 `condition_unmet` (`differentDeviceUnresolved`); 400 `confirmation_not_allowed` | 106 |
| TEST-114 | security | org-B user on org-A job's manifest/assets/scans/lookup; users missing each feature; user with `itad.assets.view` but not `itad.manifest.view` | 404 (no leakage, lookup returns none); 403 per feature; asset responses contain no `sourceData`, manifest items route → 403, counters still visible with `itad.jobs.view` | 107, 109, 110 |
| TEST-115 | API | serial lookup: exact, prefix, < 3 characters; job-scoped substring | matches; 400 | 107 |
| TEST-116 | UI | import wizard (mapping, preview, invalid blocked), scan input loop with keyboard (Enter, focus kept, live region), resolve dialog, history badge; light/dark, 390 px | observable states | 101, 103, 104 |

## Implementation Phases

Each phase ends with `yarn generate && yarn typecheck && yarn lint && yarn ds:check && yarn test && yarn build` and its integration tests in the ephemeral environment (dev server stopped). Migrations are reviewed and approved before applying.

### Phase 1 — Manifest import (CSV)

- **Depends on:** jobs spec Phases 1–3.
- **Scope:** `ItadManifestImport`, `ItadManifestItem`, `domain/serial.ts`, `domain/manifest-mapping.ts`, CSV reader, full source-row preservation (`sourceData`, source data dialog), preview/import/list/download routes, `itad.manifest.*` ACL and defaults, Manifest tab (wizard, items table, imports list), `expectedAssetCount` on job detail and list.
- **Exit:** TEST-101, 102 (CSV part), 103, 105, 107; TEST-114 (manifest part); UI smoke of the wizard.

### Phase 2 — XLSX and manifest corrections

- **Depends on:** Phase 1.
- **Required:** XLSX is part of Epic 2's business outcome, not an optional extension. The epic is done only when all four phases are verified.
- **Scope:**
  - `exceljs` dependency (approved in Q3) and XLSX reader with sheet selection and warnings;
  - manifest item delete (reason during receiving);
  - `manifest/changes` route;
  - History panel merge with the "During receiving" badge;
  - manifest lock rules per status.
- **Exit:** TEST-102 (XLSX), 106, 108; TEST-116 (wizard + history parts).

### Phase 3 — Receiving scans

- **Depends on:** Phase 1. Phase 2 may be built before or after Phase 3, but both are required.
- **Scope:**
  - `ItadAsset`, `ItadIntakeScan`;
  - scan command with the job row lock;
  - duplicate resolution, asset edit/delete;
  - assets/scans routes with job-scoped search;
  - `itad.assets.*` ACL;
  - Receiving tab (scan loop, counters, assets table, pending duplicates);
  - `receivedAssetCount`.
- `receivingComplete` is still manual in this phase, and the app keeps working.
- **Exit:** TEST-109, 110, 111; TEST-114 (assets part); TEST-116 (receiving part).

### Phase 4 — Reconciliation and `receivingComplete` from data

- **Depends on:** Phase 3.
- **Scope:**
  - `domain/reconciliation.ts`, `services/reconciliation-reader.ts`, reconciliation route, reconciliation filters and counters in both tabs;
  - `services/job-condition-evaluator.ts`;
  - `receivingComplete` switched to data;
  - transition evaluation moved inside the locked transaction;
  - status panel summary;
  - cross-job lookup index, `/api/itad/assets` and the `/backend/itad/assets` page;
  - update the jobs-spec tests that confirmed `receivingComplete` manually;
  - amend the jobs spec's Conditions section and changelog.
- **Exit:** TEST-104, 112 (acceptance), 113, 115; full TC-ITAD regression green.

## Implementation Plan

### Phase 1
1. Verify installed contracts and record the outcome in the spec:
   - `attachmentService.createScoped` + `persistLink` transaction semantics and partition choice (private default);
   - `readScoped` authorization for an app route;
   - upload size limit;
   - how a custom route reads a multipart body.
2. `domain/serial.ts` + `domain/manifest-mapping.ts` with unit tests (TEST-101, TEST-103).
3. `services/manifest-file/csv.ts` + `read-manifest-file.ts` (type sniffing, limits) with TEST-102 (CSV).
4. Entities and migration for imports and items; `yarn db:generate` → user review → apply.
5. ACL features + setup defaults; `yarn generate`; sync role ACLs in dev.
6. `itad.manifest.import` command (lock job, re-validate, attachment + rows in one transaction, event) and the preview/import/list/download/items routes with `openApi`; TEST-105, TEST-107.
7. Manifest tab UI (wizard, items table, imports list, counters) + i18n; `expectedAssetCount` in list/detail; UI smoke; TEST-114 (manifest).

### Phase 2
1. Add `exceljs` (exact version, lockfile) and `xlsx.ts` with a dynamic import; TEST-102 (XLSX), TEST-106.
2. Item delete command + route; lock rules; `manifest/changes`; TEST-108.
3. History panel merge and badge; wizard sheet selector; UI checks.

### Phase 3
1. Entities and migration for assets and scans → review → apply.
2. `itad.assets.*` ACL + defaults.
3. Scan command (lock, normalize, three outcomes, events); scans route; TEST-109, TEST-111.
4. Resolve-as-same-device, flag-different-device, asset update (optimistic lock), asset delete commands + routes; TEST-110.
5. Receiving tab (scan loop, live region, counters, tables, dialogs) + i18n; TEST-114 (assets), TEST-116 (receiving).

### Phase 4
1. `domain/reconciliation.ts` + condition change in `domain/job-conditions.ts` (`ConditionJob.id`, `loadReceivingFacts`); TEST-104.
2. `services/job-condition-evaluator.ts`; transition command and transitions GET use it; evaluation moved inside the locked transaction; adjust the existing tests; TEST-113.
3. `services/reconciliation-reader.ts`, reconciliation route, filters and counters in both tabs, status panel summary.
4. Lookup index migration → review → apply; `/api/itad/assets`; lookup page + menu; TEST-115.
5. TEST-112 acceptance; full regression; amend the jobs spec.

## Requirement Traceability

| REQ | Phases | Tests |
|---|---|---|
| 101 | 1, 2 | 102, 103, 105, 106, 116 |
| 102 | 1 | 101, 103, 107 |
| 103 | 1, 2 | 107, 108, 116 |
| 104 | 3 | 101, 109, 110, 111, 116 |
| 105 | 3, 4 | 104, 112 |
| 106 | 4 | 104, 112, 113 |
| 107 | 3, 4 | 101, 114, 115 |
| 108 | 3 | 110 |
| 109 | 1, 3 | 110, 114 |
| 110 | 1 | 103, 105, 107, 114 |

## Self-review (staff-engineer checklist)

| Item | Verdict |
|---|---|
| Architectural diff | Pass: CRUD boilerplate is not re-documented; the spec covers import, scan, lock and condition semantics |
| Scope cohesion | Pass with note: manifest import is deployable alone (Phases 1–2), but the user chose one spec with four phases (Q1) |
| Canonical mechanisms | Pass: `attachments`, commands, `DataTable`/`CrudForm`/`StatusBadge`, event bus; custom routes justified (non-CRUD writes, derived state) |
| Contracts | Pass: only additive response fields; one behavior change (`receivingComplete` manual confirmation rejected) recorded under Risks |
| Reversibility | Pass: soft-deletes with reasons, final duplicate resolution by design, additive migrations |
| Boundaries | Pass: attachment and user by id; no cross-module ORM relations |
| Sensitive data | Pass: source data stays behind `itad.manifest.view`, scoped, excluded from events, audit snapshots and the global index (Q14 a); finer permission in follow-ups |
| Failure scenarios | Pass: see Edge Cases |
| Testability | Pass: every step maps to a test |

## Decisions (former Open Questions, answered 2026-10-05)

| ID | Decision |
|---|---|
| Q1 | One spec, four phases |
| Q2 | App-owned import in `itad`, following the `sync_excel` UX (upload → mapping → preview → import); original file in `attachments` |
| Q3 | XLSX now, via `exceljs` |
| Q4 | `ItadIntakeScan` log; DUPLICATE is a persisted, resolvable fact |
| Q5 | Duplicate serial in a manifest = validation error before import |
| Q6 | Imports append; existing serials are skipped and reported; items can be removed. Changes after receiving started are explicitly visible in history |
| Q7 | Serial required |
| Q8 | Asset soft-delete during `receiving`, with a reason, `itad.assets.manage` |
| Q9 | `status = received`; `dataBearing` nullable = not yet determined |
| Q10 | Trim + remove whitespace + uppercase; substring search within a job, exact/prefix across jobs |
| Q11 | Synchronous, up to 5,000 rows |
| Q12 | `itad.manifest.view/manage`, `itad.assets.view/receive/manage` |
| Q13 | Scanning only in `receiving` |
| Q14 | (a) `source_data` unencrypted, protected by `itad.manifest.view`, scope and flow limits (see Security) |
| — | All source columns are preserved: mapped fields drive the process; unmapped fields remain as source metadata for audit, lookup and customer queries. The original manifest file is the durable source of every customer-supplied field, and the mapping records unused columns |

Design choices confirmed by the user (2026-10-05):
- import is all-or-nothing: errors block, while warnings are shown and must be accepted before import;
- duplicates: "same device" resolves; "different device" keeps the intake scan as evidence and stays unresolved and blocking until the exceptions mechanism;
- scans and manifest changes do not bump the job's `updatedAt`;
- import, scan and transition are serialized by a job row lock, and conditions are evaluated inside the transition transaction;
- 10 MB cap, UTF-8 CSV, SHA-256 with 409 for an identical file.

## Follow-ups (backlog, not in this epic)

- `itad.manifest.source_data.view`: a finer permission for users who should see the manifest without customer source data (possible personal data).
- A deliberate "import the same file again" action (overriding the SHA-256 409).
- An exceptions mechanism that registers a second physical device with an already-registered serial and closes flagged scans.
- Retention and erasure of manifest source data and original files when the process closes.

## Implementation Status

| Phase | Status | Evidence |
|---|---|---|
| 1 — Manifest import (CSV) | verified (2026-10-05) | see Phase 1 progress |
| 2 — XLSX and manifest corrections | verified (2026-10-08) | see Phase 2 progress |
| 3 — Receiving scans | verified (2026-10-09) | see Phase 3 progress |
| 4 — Reconciliation and `receivingComplete` | verified (2026-10-09) | see Phase 4 progress |

### Phase 1 progress

- **Step 1 — installed contracts verified (2026-10-05):**
  - `attachmentService.createScoped` stores the bytes first, then opens `em.transactional`, inserts the attachment row and runs `persistLink(tx, attachmentId)`. A throw from `persistLink` removes the bytes, and a `CrudHttpError` passes through unchanged.
  - Partition: `privateAttachments` (private enforced).
  - `readScoped` checks tenant/organization and the owner record.
  - Platform upload limit: 25 MB (`OM_ATTACHMENT_MAX_UPLOAD_MB`), stricter manifest cap 10 MB.
  - Multipart via `readUploadForm`.
  - Pattern mirrored from the installed `documents` module: file bytes travel in the command context, never in the durable (audited) command input.
- **Step 2 — domain:** `domain/serial.ts`, `domain/manifest-mapping.ts`, `domain/manifest-rules.ts`; unit tests TEST-101, TEST-103 (+ manifest rules).
- **Step 3 — CSV reader:** `services/manifest-file/{csv,read-manifest-file}.ts`; TEST-102 (CSV part).
- **Step 4 — migration** `Migration20261005172220_itad` (tables `itad_manifest_imports`, `itad_manifest_items`; `down()` hand-completed to drop both tables). Reviewed and applied to dev (user approval 2026-10-05).
- **Steps 5–7 — server and UI:**
  - ACL `itad.manifest.view|manage`;
  - command `itad.manifest.import`;
  - routes `manifest/preview`, `manifest/imports` (GET/POST), `manifest/imports/{id}/file`, `manifest/items`;
  - port `module-integrations/attachments.ts`;
  - `expectedAssetCount` on the jobs list/detail;
  - job detail tabs (Overview / Manifest, `?tab=manifest`) with the import wizard, items table, source data dialog and imported files list;
  - 81 i18n keys × 5 locales.
- **Integration tests:**
  - TC-ITAD-101 (TEST-105), TC-ITAD-102 (TEST-107, CSV part), TC-ITAD-103 (TEST-114, manifest part), TC-ITAD-104 (TEST-116, wizard part).
  - Full TC-ITAD suite: 20/20 passed in three runs on fresh ephemeral builds.
- **Found during testing:**
  - The routes returned `manifestError(...)` without `await` inside `try`, so a coded 400 escaped as an empty 500. Fixed with `return await`; TC-ITAD-102 (unsupported file → 400) is the regression oracle.
  - The wizard dialog was too narrow for the preview table; it now uses the `xl` dialog size.
  - Found in user testing: mapping one column to two fields produced an empty preview, because the server rejected the mapping and the wizard did not show why. The wizard now validates the mapping (serial required, one column per field), disables the preview with a message, and shows a server `mappingError`. TC-ITAD-104 covers it. Header aliases for the model field were extended (`device model`, `model name`, `model number`, `nazwa modelu`).
- **Gates:**
  - `yarn generate`, `yarn typecheck`, `yarn lint` (0 errors), `yarn ds:check` (283 files) and `yarn test` (166 passed) all pass.
  - The build passed in the ephemeral environment.
- **UI checked:** Polish, light at 1280 px and dark at 390 px (Manifest tab, wizard mapping and preview, source data dialog).
- **Dev rollout:** role ACLs synced (`yarn mercato auth sync-role-acls`).
- **Deviations:**
  - `no_header_row` dropped: the header is always the first non-blank row, and a file without data rows reports `file_empty`.
  - The import id is generated in code, since the attachment needs it as `recordId` before the row exists.
  - Warnings come only from XLSX cells, so the `warnings_not_accepted` test moves to Phase 2 (TEST-107 XLSX part).
  - The "no `source_data` in event payloads" assertion of TEST-105 is ensured structurally (payload type holds ids and counts only) rather than observed at runtime.

### Phase 2 progress

- **Step 1 — XLSX:**
  - `exceljs` 4.4.0 added with an exact version (Q3).
  - `services/manifest-file/xlsx.ts` is loaded with a dynamic `import()`. Rich text, formula results (`formula_cell`), numbers (`numeric_serial_cell`), dates (ISO), booleans, hyperlinks and error codes become logical text values.
  - The reader picks the first sheet or a requested one; an unknown sheet returns 400 `sheet_not_found`. Physical reads are capped at 6,000 rows and 200 columns before the domain limits apply.
  - `.xlsx` must be a zip package, otherwise `file_type_unsupported`.
  - Unit tests TEST-102 (XLSX part).
- **Step 2 — corrections:**
  - Command `itad.manifest.delete_item` runs under the job row lock and soft-deletes the item, recording who removed it, the reason and the effective job status. A reason is required while receiving (`domain/manifest-rules.ts` `resolveItemDeleteReason`, unit-tested).
  - Event `itad.manifest.item_deleted`.
  - `DELETE manifest/items/{itemId}` and `GET manifest/changes` (imports and removals, newest first, with `duringReceiving`).
  - No migration: the delete columns came with Phase 1.
- **Step 3 — UI:**
  - Wizard: accepts XLSX; a sheet selector appears when the workbook has more than one sheet, and changing the sheet re-previews with that sheet's suggested mapping.
  - Manifest table: "Remove" row action with a reason dialog (required during receiving, Cmd/Ctrl+Enter submits).
  - Job history interleaves manifest imports and removals (only with `itad.manifest.view`) and shows a "During receiving" badge; it reloads after manifest changes.
  - 22 i18n keys added or updated in 5 locales.
- **Integration tests:**
  - TC-ITAD-105 (TEST-106 and TEST-107, XLSX part: warnings without and with `acceptWarnings`, sheets, 409 for the same sheet again, `sheet_not_found`);
  - TC-ITAD-106 (TEST-108: reason rules, `/changes` flags, processing lock);
  - TC-ITAD-107 (TEST-116, wizard sheet selection plus removal and history badge).
  - Full TC-ITAD suite: 23/23 in two runs on a fresh ephemeral build.
- **Gates:** `yarn generate`, `yarn typecheck`, `yarn lint` (0 errors), `yarn ds:check` (286 files) and `yarn test` (172 passed) all pass. The build passed in the ephemeral environment.
- **UI checked:** Polish, history at 1280 px light, remove dialog at 390 px dark.
- **Found in user testing (2026-10-09):**
  - No XLSX from the user's test pack imported (`file_unreadable`). The files bind the SpreadsheetML namespace to a prefix (`<x:workbook>`, as written by .NET Open XML SDK based exporters). This is valid OOXML that Excel reads, but `exceljs` finds no sheets in it.
  - The reader now rewrites prefixed parts to the default namespace before loading (`normalizeSpreadsheetMlPrefixes`). It needs `jszip`, added as a direct dependency at the already-installed transitive version 3.10.2 (user approval 2026-10-09).
  - The tests had missed this because their workbooks were written by `exceljs` itself. A regression unit test builds a prefixed workbook; it fails without the fix and passes with it. TC-ITAD-105 also imports a prefixed workbook end to end.
  - Removing a manifest item during receiving logged a hydration error: the history wrapped the "During receiving" badge (a `div`) in a `p`. The wrapper is now a `div`, and TC-ITAD-107 fails on HTML nesting or hydration errors in the browser console.

### Phase 3 progress

- **Step 1 — data:** migration `Migration20261009075007_itad` (tables `itad_assets`, `itad_intake_scans`; partial unique index on active serials per job; pending-duplicates partial index; `down()` hand-completed). Reviewed and applied to dev (user approval 2026-10-09). The cross-job lookup index stays in Phase 4, as planned.
- **Step 2 — ACL:** `itad.assets.view|receive|manage`; employee gets view and receive, admin gets everything via `itad.*`.
- **Step 3 — scan:**
  - `domain/receiving-rules.ts` (`isReceivingActive`, `decideScanResult`, `resolveNote`, `canResolveAsSameDevice`, `canFlagDifferentDevice`; unit-tested).
  - Command `itad.assets.scan` runs under the job row lock: matched or unexpected creates the asset (copying tag, manufacturer and model from the matched item); a repeat creates a pending `duplicate` scan; the unique index stays as a backstop (409 `serial_conflict`).
  - `commands/job-lock.ts` is the shared row lock, also used by the manifest commands.
- **Step 4 — corrections:**
  - Commands `itad.assets.resolve_duplicate`, `itad.assets.flag_different_device`, `itad.assets.update` (optimistic lock on the asset, system fields refused) and `itad.assets.delete` (reason required, `itad.assets.manage`).
  - Events `itad.asset.received|updated|deleted` and `itad.intake_scan.duplicate_detected|resolved|flagged_different_device`.
  - Routes `POST/GET scans`, `scans/{id}/resolve`, `scans/{id}/flag-different-device`, `GET assets` (with `manifestItemId`, never source data), `PUT/DELETE assets/{id}`, sharing `lib/command-route.ts` (mutation guard + command bus).
  - `receivedAssetCount` on the jobs list and detail.
- **Step 5 — UI:**
  - Receiving tab (`?tab=receiving`, needs `itad.assets.view`):
    - counters (expected, received, duplicates to resolve);
    - Enter-driven scan field that keeps focus and sends scans one at a time, with an `aria-live` result and the last 10 scans;
    - duplicates list with "Same device" and "Different device" dialogs (the flagged state shows "Waiting for exception handling");
    - received-devices table with Edit details (embedded `CrudForm`), Remove scan and Source data (only with `itad.manifest.view`).
  - "Received" column on the jobs list. 73 i18n keys in 5 locales.
- **Integration tests:**
  - TC-ITAD-108 (TEST-109), TC-ITAD-109 (TEST-110), TC-ITAD-110 (TEST-111, 20 parallel scans), TC-ITAD-111 (TEST-114, assets part), TC-ITAD-112 (TEST-116, receiving part, including a console check for HTML nesting and hydration errors).
  - Full TC-ITAD suite: 28/28 in 6 of 7 full runs.
  - One run had a single TC-ITAD-015 failure (jobs-spec transition dialog). It could not be reproduced in 8 isolated repeats or 5 more full runs and is recorded as an observed flake.
- **Found during testing:**
  - The flag route required `note` in its own schema, so a missing note returned a generic 400 instead of the coded `note_required`. The command is now the only place that enforces it.
  - In the embedded `CrudForm` the extra Cancel action rendered twice. It was removed; the dialog closes with its X.
  - The data-bearing select with an empty value showed "—" instead of "Not determined". The value is now `unknown`.
  - The scan result banner first nested the badge in a `p`; corrected before testing.
- **Gates:** `yarn generate`, `yarn typecheck`, `yarn lint` (0 errors), `yarn ds:check` (300 files) and `yarn test` (177 passed) all pass. The build passed in the ephemeral environment.
- **UI checked:** Polish, Receiving tab at 1280 px light and 390 px dark.

### Phase 4 progress

- **Step 1 — domain:**
  - `domain/reconciliation.ts`: `classifyManifestItem`, `classifyAsset`, `receivingCompleteBlocker` (order: `manifestMissing` → `differentDeviceUnresolved` → `duplicatesPending`) and `summarizeReconciliation`.
  - `receivingComplete` in `domain/job-conditions.ts` is now `source: 'data', manualAllowed: false`; `ConditionJob.id` and `ConditionDeps.loadReceivingFacts` were added.
  - Unit tests TEST-104, plus the condition tests moved to `start_closeout`/`allAssetsProcessed` for the manual-confirmation rules.
- **Step 2 — transition command:**
  - `services/job-condition-evaluator.ts` (`buildConditionDeps`) is used by the transition command and the transitions read model.
  - The command now locks the job row and evaluates conditions inside the same transaction. Previously it evaluated before the transaction (`withAtomicFlush`).
  - Jobs-spec tests rewritten: TC-ITAD-009/011/106 reach `processing` via `__integration__/itad-flow-fixtures.ts` (real manifest + scan); TC-ITAD-010/015 exercise manual confirmations on `start_closeout`.
- **Step 3 — reconciliation read side:**
  - `services/reconciliation-reader.ts` (`loadReceivingFacts`, `loadReconciliationSummary`, `countActiveAssets`) and `GET …/reconciliation` (`itad.jobs.view`).
  - A `reconciliation` field and filter on manifest items (`matched|missing`) and assets (`matched|unexpected`).
  - Counters and filters in both tabs; the status panel shows the reconciliation line while (held in) receiving and names the blocking detail on the disabled action.
- **Step 4 — lookup:**
  - Migration `Migration20261009093339_itad` (index `itad_assets_serial_lookup_idx`, `text_pattern_ops`). Reviewed and applied to dev (user approval 2026-10-09).
  - `GET /api/itad/assets` (exact or prefix, at least 3 characters, exact matches first, readable organizations only).
  - Page `/backend/itad/assets` ("ITAD → ITAD Assets") linking to the job's Receiving tab.
- **Step 5 — acceptance:**
  - TC-ITAD-113 (TEST-112, the brief's E2E: 9 matched, ABC010 missing, XYZ999 unexpected, `start_processing` with no confirmation).
  - TC-ITAD-114 (TEST-113), TC-ITAD-115 (TEST-115 + lookup scope/features), TC-ITAD-116 (UI: status line, blocked reason, Manifest reconciliation badges, lookup page; console check).
  - Full TC-ITAD suite: 32/32 in three consecutive runs on a fresh ephemeral build.
- **Gates:** `yarn generate`, `yarn typecheck`, `yarn lint` (0 errors), `yarn ds:check` (309 files) and `yarn test` (185 passed) all pass. The build passed in the ephemeral environment.
- **UI checked:** Polish, status panel at 1280 px light, lookup page at 1280 px light and 390 px dark.
- **Fixes during verification:**
  - TC-ITAD-116 used an ambiguous `searchbox` locator; there are two on the page at desktop width (header and table), so it now uses the field's placeholder.
  - The page icon `scan-barcode` is not in the lucide registry and was replaced with `package-search`.

## Changelog

| Date | Change |
|---|---|
| 2026-10-05 | Skeleton with framework findings and open questions |
| 2026-10-05 | Open questions answered; full draft with four phases |
| 2026-10-05 | All source manifest columns preserved per item (`source_data`, `source_columns`), searchable within a job; Q14 opened on source-data protection |
| 2026-10-05 | User review: Q14 → a; original manifest is the durable source and the mapping records unused columns; warnings must be accepted; different-device duplicates stay unresolved and blocking (flag action + `differentDeviceUnresolved`); Phase 2 (XLSX) required for the epic; follow-ups listed. Approved for implementation |
| 2026-10-05 | Review fixes: `differentDeviceUnresolved`/`duplicatesPending` defined on `resolvedAt`; source data on Receiving requires `itad.manifest.view` too (asset responses never embed it); import identity = job + sha256 + sheet; `sourceData` belongs to the creating import (later rows with the same serial don't update it); attachment = byte-for-byte file vs `sourceData` = parsed logical values; counters need only `itad.jobs.view` |
| 2026-10-05 | Phase 1 implemented and verified (CSV manifest import, source data, Manifest tab, TC-ITAD-101…104) |
| 2026-10-08 | Phase 2 implemented and verified (XLSX import with sheets and warnings, manifest item removal, manifest changes in the job history, TC-ITAD-105…107) |
| 2026-10-09 | Phase 2 fix: XLSX files with prefixed SpreadsheetML namespace (`<x:…>`, .NET exporters) are normalized before `exceljs` loads them; `jszip` 3.10.2 declared as a direct dependency; regression tests added; history badge no longer nested in a `p` (hydration error) |
| 2026-10-09 | Phase 3 implemented and verified (assets, intake scans, duplicate resolution and different-device flag, asset edit/void, Receiving tab, TC-ITAD-108…112) |
| 2026-10-09 | Phase 4 implemented and verified (reconciliation, `receivingComplete` from data under the job lock, cross-job serial lookup, TC-ITAD-113…116); jobs spec amended. Epic 2 complete |

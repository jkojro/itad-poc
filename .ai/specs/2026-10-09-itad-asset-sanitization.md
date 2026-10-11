# ITAD Asset Processing & Sanitization

**Date**: 2026-10-09
**Status**: Ready for implementation (review fixes applied 2026-10-09)

> Spec 3 of the app-owned `itad` module (Epic 3), after `2026-10-02-itad-jobs.md` and `2026-10-05-itad-manifest-reconciliation.md`. It extends `ItadAsset`, the manifest import, the job and the condition registry. Module rules: `src/modules/itad/AGENTS.md`.

## TLDR

Every received asset gets a decided `dataBearing` (`true` / `false` / unknown):
- **Automatic at the scan.** The value comes from an explicit manifest value first, then from the job's default; otherwise it stays unknown. Receiving stays one-scan-per-device fast.
- **Bulk decision.** Operators classify the remaining unknown assets in bulk.
- **Receiving gate.** Receiving cannot be completed while any active asset is still unknown.

`dataBearing = true` moves the asset's `status` automatically to `sanitization_required` and emits `itad.asset.sanitization_required` (first time only). `dataBearing = false` keeps the asset on the normal path (`received`).

During `processing` a technician runs sanitization:
- **Start:** opens a **Sanitization Run** (method, tool, tool version, operator, start); the asset moves to `sanitization_in_progress`.
- **PASS:** closes the run with its verification data; the asset becomes `sanitized`.
- **FAIL:** closes the run; the history records `sanitization_failed`, and the asset moves to `review_required`. A manager can approve a retry, which creates a new run and keeps the history. Epic 4 adds the exception model.
- **Abort:** a run started by mistake is aborted with a reason.

Every run stays in the history. Bulk start and bulk result handle a rack of devices wiped together. Sanitization has its own permissions, separate from receiving. `start_closeout` is blocked while any data-bearing asset is not `sanitized`.

## Problem Statement

Epic 2 records which devices arrived, but nothing guarantees that a device carrying data is wiped:
- `dataBearing` is optional, manual and has no consequence.
- A data-bearing device can leave the process without a recorded sanitization.
- There is no evidence of who wiped what, how, and with which result.

## Goals

- REQ-301: `dataBearing` is tri-state. At the scan it is set from the manifest item's explicit value, else the job's default, else it stays unknown. No guessing from manufacturer or model.
- REQ-302: the manifest import can map an optional `dataBearing` column.
- REQ-303: a job has a default `dataBearing`, used for assets scanned after it is set.
- REQ-304: operators list unknown assets and classify many at once (`true` / `false`).
- REQ-305: receiving cannot complete while any active asset has an unknown `dataBearing`.
- REQ-306: `dataBearing = true` moves the asset to `sanitization_required` without a user action and emits `itad.asset.sanitization_required` the first time; `false` keeps it out of sanitization.
- REQ-307: the state machine is `sanitization_required → sanitization_in_progress → sanitized` (PASS) and `sanitization_in_progress → sanitization_failed → review_required` (FAIL); no other order is accepted.
- REQ-308: every attempt is a Sanitization Run recording method, tool, tool version, operator, start, end, result and verification (method, notes, optional evidence files). Runs are never deleted or replaced. An open run may be completed exactly once, with PASS, FAIL or ABORTED; after that it is immutable (only evidence links can be added).
- REQ-309: a manager can send an asset in review back to `sanitization_required` (retry) with a reason.
- REQ-310: classification is freely correctable during receiving. Afterwards a change needs `itad.sanitization.manage` and a reason, is recorded, and is refused while a run is in progress; in `closeout_review` only `true → false` is allowed.
- REQ-311: sanitization permissions are separate from receiving permissions: view, execute (technician) and manage (manager).
- REQ-312: `start_closeout` is refused while a data-bearing asset is not `sanitized`.
- REQ-313: technicians can start and finish runs for many assets at once.

## Non-goals

- Exceptions as records, the manager's exception decisions and the escalation model (Epic 4). Epic 3 ends a FAIL in `review_required`, with a minimal retry.
- Reactions to `itad.asset.sanitization_required` (work queues, notifications, tool integrations such as Blancco) — the event is the extension point (brief §9).
- A cross-job technician queue page (Q15: job tab only).
- A customer-level default sanitization policy (Q11). The job default is set per job.
- Inferring `dataBearing` from manufacturer or model.
- Grading, disposition and certificates (later epics); `allAssetsProcessed` stays a manual confirmation for those parts.
- New tenant roles (`technician`, `manager`) — features are assigned per tenant (Q13).

## Proposed Solution

### Reuse and ownership (brief: "check existing mechanisms first")

| Need | Decision | Why |
|---|---|---|
| Sanitization lifecycle of an asset | **itad-owned state machine** on `ItadAsset.status` (Q2): pure `domain/sanitization-state-machine.ts` + commands + append-only `ItadAssetStatusTransition` | Same pattern as the job lifecycle. State, run and history commit in one transaction under the job/asset lock. The installed `workflows` module (not enabled) targets configurable long-running processes; one instance per asset would duplicate the asset's state outside its transaction. |
| Reactions to "sanitization required" | Domain event `itad.asset.sanitization_required` | `workflows` event triggers or `notifications` can subscribe later without touching `itad` |
| Job default | Field `ItadJob.defaultDataBearing` | `business_rules` (not enabled) is a general rule engine; too heavy for one tri-state default |
| Methods and verification methods | Fixed enums (Q6, Q7) | NIST SP 800-88 levels are a standard, closed list. Tools are free text with suggestions from previous runs. |
| Evidence files | Installed `attachments` via the existing `module-integrations/attachments.ts` port, linked through `ItadSanitizationEvidence` | Already used for manifest files; one bulk report can be linked to many runs |
| Bulk classification and bulk runs | `DataTable` row selection + bulk actions; one command per bulk request | Established UI primitive; all-or-nothing commands |

### Domain rules

**`dataBearing` resolution at the scan** (`domain/data-bearing.ts`, pure):

| Priority | Source | `data_bearing_source` |
|---|---|---|
| 1 | the matched manifest item's explicit value (`true` / `false`) | `manifest` |
| 2 | the job's `defaultDataBearing` (`true` / `false`) | `job_default` |
| 3 | none | `null` (unknown) |

UNEXPECTED assets (no manifest item) use priority 2. Later decisions record `manual` (asset edit) or `bulk`, with the deciding user and time.

**Snapshot rule:** the resolved value is copied onto the asset at the scan, and from then on `dataBearing` belongs to the asset. A later change to the manifest item (re-import, correction) or to the job default never changes an already received asset. Correcting an asset always goes through asset classification ("Classification changes"). Example: manifest `ABC123 → false`, scan → asset `false`; the manifest is later corrected to `true` → the asset stays `false` until someone classifies it.

**Manifest `dataBearing` values** (Q10). They are matched case-insensitively and trimmed:
- `true`: `true`, `yes`, `y`, `1`, `tak`, `t`;
- `false`: `false`, `no`, `n`, `0`, `nie`;
- an empty cell means no value;
- anything else raises the row warning `data_bearing_unrecognized` (the value is ignored), which must be accepted like other warnings (Epic 2 rule).

Header aliases for the mapping: `data bearing`, `databearing`, `contains data`, `has storage`, `zawiera dane`, `nośnik danych`. A plain `storage` header is deliberately not an alias: in manifests it usually holds a capacity ("256 GB"), which would turn every row into a warning.

**Asset status** (Q2: extends `status`). Stored values:

| Status | Meaning |
|---|---|
| `received` | received; not in sanitization (`dataBearing` false or unknown) |
| `sanitization_required` | data-bearing, waiting for a run |
| `sanitization_in_progress` | a run is open |
| `sanitized` | the last run passed |
| `review_required` | the last run failed; waiting for a decision (Epic 4) or a retry |

`sanitization_failed` is a **transition state** (Q3): a FAIL writes two history rows in one transaction (`sanitization_in_progress → sanitization_failed`, `sanitization_failed → review_required`), and the asset rests in `review_required`.

The domain types keep the two sets apart, so that `sanitization_failed` can never be stored or filtered on as an asset status:
- `ITAD_ASSET_STATUSES` (persisted on `itad_assets.status`, validated by the entity, API filters and UI badges): `received`, `sanitization_required`, `sanitization_in_progress`, `sanitized`, `review_required`;
- `ITAD_ASSET_HISTORY_STATUSES` = `ITAD_ASSET_STATUSES` + `sanitization_failed` (allowed only in `itad_asset_status_transitions.from_status` / `to_status`).

**Transitions** (`domain/sanitization-state-machine.ts`; anything else returns 409 `asset_transition_not_allowed`):

| Action | From | To | Who | Job must be |
|---|---|---|---|---|
| classify `true` | `received` | `sanitization_required` | system (scan) / receiving / manager (Q12) | see "Classification changes" (not in `closeout_review`) |
| classify `true` | `sanitization_required`, `sanitized`, `review_required` | unchanged (no-op, no history row) | — | — |
| classify `false` | `received` (unknown or already `false`) | `received` | receiving / manager (Q12) | see below |
| classify `false` | `sanitization_required`, `sanitized`, `review_required` | `received` | receiving / manager (Q12) | see below |
| classify (any) | `sanitization_in_progress` | — refused (409 `sanitization_in_progress`) | — | — |
| `start_run` | `sanitization_required` | `sanitization_in_progress` | `itad.sanitization.execute` | `processing` (Q5) |
| `record_pass` | `sanitization_in_progress` | `sanitized` | execute | `processing` |
| `record_fail` | `sanitization_in_progress` | `sanitization_failed` → `review_required` | execute | `processing` |
| `abort_run` (reason) | `sanitization_in_progress` | `sanitization_required` | execute | `processing` |
| `approve_retry` (reason) | `review_required` | `sanitization_required` | `itad.sanitization.manage` | `processing` |

Rules:
- Runs only happen while the job is `processing` (Q5). A held job keeps its open runs until it resumes.
- **Job cancelled:** the `cancel` transition command closes every open run of the job in the same transaction. Each run gets `result = ABORTED`, `abort_reason = 'job_cancelled'` (a code, localized in the UI as "Job cancelled"), `finished_at = now()` and `finished_by_user_id` = the cancelling user. Each asset gets an `abort_run` history row and returns to `sanitization_required`. `result IS NULL` therefore always means "a run is in progress on a live job".
- At most one open run per asset (partial unique index).
- An asset removed (voided) in receiving cannot have runs.

**Classification changes** (Q12):

| Job status | Who | Reason | Allowed when |
|---|---|---|---|
| `receiving` | `itad.assets.receive` (single edit or bulk) | no | always (runs cannot exist yet) |
| `processing` | `itad.sanitization.manage` | required (3–1000 characters) | not while the asset is `sanitization_in_progress` |
| `closeout_review` | `itad.sanitization.manage` | required (3–1000 characters) | only `true → false`; `→ true` is refused (409 `sanitization_not_possible`) |
| other / terminal | — | — | refused (409 `assets_locked`) |

In `closeout_review`, classifying an asset as data-bearing would create `sanitization_required`, which closeout blocks. Runs are possible only in `processing`, and the job lifecycle has no way back from `closeout_review` to `processing`, so the job would be stuck for good. Until such a lifecycle action exists (out of scope; a candidate for Epic 4), `→ true` is refused there. The manager can still correct `true → false` with a reason.

Every change of the `dataBearing` value writes an `ItadAssetStatusTransition` row with the reason, even when the status does not move (e.g. `received` → `received` for unknown → `false`). That gives an audit of all classification decisions. Classifying to the value the asset already has is a no-op: no row, no event.

**`itad.asset.sanitization_required`** fires the first time an asset enters `sanitization_required` (`sanitization_required_at` is null before). It does not fire again on retry or re-classification. Payload: ids, `dataBearingSource`, no source data.

**Receiving gate** (REQ-305): `receivingComplete` gains a blocker. Order: `manifestMissing` → `differentDeviceUnresolved` → `duplicatesPending` → **`dataBearingUndecided`** (any active asset with `data_bearing` null).

**Closeout gate** (Q14):
- `allAssetsProcessed` stays `source: 'manual'`, but its evaluation first checks the data.
- While any active asset has `data_bearing = true` and `status <> 'sanitized'`, the condition is `unmet` with detail `sanitizationPending`. A manual confirmation then returns `condition_unmet`, not `confirmation_not_required`; the decision function gains this rule.
- Otherwise it is `confirmation_required`, as today.

### Run data (Q6, Q7)

**At start:**
- `method` (required; NIST SP 800-88: `clear`, `purge`, `destroy`);
- `methodDetail` (optional free text, e.g. "3-pass overwrite", "crypto erase");
- `tool` (required, ≤ 200);
- `toolVersion` (required, ≤ 100).

The UI suggests tools and versions from the organization's previous runs.

**At result:**
- `result` (`PASS` / `FAIL`);
- `verificationMethod` (required: `full_verification`, `sample_verification`, `visual_inspection`, `none`);
- `verificationNotes` (required for FAIL, optional for PASS, ≤ 2000).

**Evidence files:** optional. Each file is uploaded once through `attachments` and linked to one or more runs through `ItadSanitizationEvidence`, so a single bulk report serves a whole batch.
- **Owner is the job** (`itad:itad_job`, record = job id; private partition, 10 MB cap), not a run. The installed port takes exactly one owner (`createScoped({ entityId, recordId })`) and checks it on read (`readScoped({ expectedOwner })`). A run owner would tie a shared file to whichever run came first. The job owns all its runs, so it is the natural shared owner. Run-level access goes through the link table.
- The download route checks that the attachment is linked to a run of that job and reads it with `expectedOwner` = the job. Evidence can be added to a finished run (append-only) while the job is not terminal.

**Abort:** `reason` (required).

## Architecture and Data Flow

```
Receiving scan (Epic 2 command, extended)
   └─ resolve dataBearing (manifest item → job default → unknown)
       └─ true ⇒ status sanitization_required, sanitization_required_at, event after commit
Receiving tab: asset edit / bulk "Mark as data-bearing / not data-bearing"
   └─ command itad.assets.classify (lock job; rules per job status; history row)
Sanitization tab (job)
   ├─ start / PASS / FAIL / abort / retry (single + bulk)
   │    └─ commands itad.sanitization.* (lock job, lock assets; state machine; runs; history; events after commit)
   └─ run history + evidence (attachments port)
Transition start_closeout ─▶ allAssetsProcessed: loadProcessingFacts (pending sanitization count)
Transition start_processing ─▶ receivingComplete: + undecided dataBearing count
```

- New pure files:
  - `domain/data-bearing.ts` (resolution, value parsing);
  - `domain/sanitization-state-machine.ts` (transition table, `canReclassify`, `canStartRun`, …).
- New services:
  - `services/sanitization-reader.ts` (counts for conditions and the tab);
  - the reconciliation reader extended with the undecided count.
- Commands:
  - `commands/sanitization.ts`: `itad.sanitization.start`, `.record_result`, `.abort`, `.approve_retry`, `.bulk_start`, `.bulk_record_result`, `.attach_evidence`;
  - `commands/assets.ts`: new `itad.assets.classify` (single + bulk; the asset edit's `dataBearing` goes through it).
- Every write takes the job row lock (`commands/job-lock.ts`) and, for bulk, locks the selected assets in id order.
- Asset writes bump `asset.updatedAt`, so the asset edit dialog's optimistic lock sees sanitization changes. They never bump the job's `updatedAt`.

## Users, Permissions, and Scope

| Feature | Grants | Depends on | Default roles |
|---|---|---|---|
| `itad.sanitization.view` | Sanitization tab, runs, evidence download, status history | `itad.assets.view` | admin (`itad.*`), employee |
| `itad.sanitization.execute` | start, PASS/FAIL, abort, bulk start/result, attach evidence | `itad.sanitization.view` | admin |
| `itad.sanitization.manage` | approve retry, re-classify after receiving | `itad.sanitization.view` | admin |
| `itad.assets.receive` (existing) | classify during receiving (single + bulk) | — | unchanged |

- A receiving-only user cannot start or finish runs (403).
- Counters on the job (pending sanitization) stay under `itad.jobs.view`, like Epic 2's counters.
- Existing tenants get the new defaults via `yarn mercato auth sync-role-acls`.

## Data Models

All tables carry `tenant_id` and `organization_id`; every index starts with them. One migration per phase, reviewed before applying.

### `ItadAsset` (existing, `itad_assets`) — new and changed columns

| Column | Type | Notes |
|---|---|---|
| `status` | text | now `received` \| `sanitization_required` \| `sanitization_in_progress` \| `sanitized` \| `review_required` |
| `data_bearing_source` | text null | `manifest` \| `job_default` \| `manual` \| `bulk` |
| `data_bearing_decided_by_user_id` | uuid null | null when set by the system at the scan |
| `data_bearing_decided_at` | timestamptz null | |
| `sanitization_required_at` | timestamptz null | first entry; guards the one-time event |

Index: (`tenant_id`, `organization_id`, `job_id`, `status`) where `deleted_at is null`.

Backfill rules:
- **Scope:** only active assets with `data_bearing = true` and `status = 'received'` whose job can still enter sanitization (job status `receiving`, `processing`, `on_hold` or `closeout_review`). These move to `status = 'sanitization_required'` and get `sanitization_required_at = now()`, with no event.
- **Terminal jobs** (`completed`, `cancelled`) are never reopened or changed retroactively. Their assets keep `received`.
- **Existing values:** assets with a non-null `data_bearing` get `data_bearing_source = 'manual'` in every job.
- The migration SQL implements the scope as a join to `itad_jobs.status`; the dev data is checked before applying.

### `ItadManifestItem` (existing) — `data_bearing` boolean null (mapped column, Q10)

### `ItadJob` (existing) — `default_data_bearing` boolean null

Editable in `draft`, `scheduled`, `in_transit` and `receiving` (job editability matrix); clearable to unknown.

### `ItadSanitizationRun` — `itad_sanitization_runs` (new)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `job_id` | uuid FK → `itad_jobs` | |
| `asset_id` | uuid FK → `itad_assets` | |
| `method` | text | `clear` \| `purge` \| `destroy` |
| `method_detail` | text null | |
| `tool` | text | |
| `tool_version` | text | |
| `operator_user_id` | uuid | who started it |
| `started_at` | timestamptz | |
| `finished_at` | timestamptz null | |
| `finished_by_user_id` | uuid null | |
| `result` | text null | `PASS` \| `FAIL` \| `ABORTED`; null while open |
| `verification_method` | text null | |
| `verification_notes` | text null | |
| `abort_reason` | text null | |
| `bulk_batch_id` | uuid null | runs started by one bulk request share it |
| `created_at`, `updated_at` | timestamptz | |

Indexes:
- partial unique (`tenant_id`, `organization_id`, `asset_id`) `WHERE result IS NULL`, i.e. one open run per asset;
- (`tenant_id`, `organization_id`, `job_id`, `started_at`);
- (`tenant_id`, `organization_id`, `tool`) for suggestions.

Runs are never deleted or replaced. A run is inserted at start (`result` null). It may then be completed exactly once, which sets `result` (PASS / FAIL / ABORTED), `finished_at`, `finished_by_user_id` and the verification or abort fields. The command checks `result IS NULL` under the lock (409 `run_closed` otherwise). A completed run is immutable; evidence is linked through `ItadSanitizationEvidence` and never by updating the run.

### `ItadSanitizationEvidence` — `itad_sanitization_evidence` (new, append-only)

`id`, `job_id` FK, `run_id` FK, `attachment_id` (uuid of the installed `attachments` row, owned by the job), `file_name`, `added_by_user_id`, `created_at`. Unique (`run_id`, `attachment_id`).

### `ItadAssetStatusTransition` — `itad_asset_status_transitions` (new, append-only)

`id`, `job_id`, `asset_id`, `action` (`classify`, `start_run`, `record_pass`, `record_fail`, `abort_run`, `approve_retry`), `from_status`, `to_status` (both from `ITAD_ASSET_HISTORY_STATUSES`; `null` `from_status` for the scan), `data_bearing_from`, `data_bearing_to`, `run_id` null, `reason` null, `actor_user_id` (null for the scan), `created_at`.

Index: (`tenant_id`, `organization_id`, `asset_id`, `created_at`).

## API, Command, and Error Contracts

All routes are custom routes with `metadata` and `openApi`, nested under a readable job (404 for other organizations). Commands use `lib/command-route.ts`. Asset-changing requests send the asset's expected `updatedAt` (lock header) for single actions; bulk requests are all-or-nothing and return the ids that block them.

| Method / command | Path | Feature | Input | Errors |
|---|---|---|---|---|
| `POST` `itad.assets.classify` | `/api/itad/jobs/{id}/assets/classify` | receive (receiving) / manage (later) | `{ assetIds (1–500), dataBearing: true\|false, reason? }` | 400 `reason_required`; 409 `assets_locked` / `sanitization_in_progress` (+ `assetIds`) / `asset_transition_not_allowed` |
| `PUT` (existing) | `/api/itad/jobs/{id}/assets/{assetId}` | receive | `dataBearing` now routed through classify rules | as above |
| `GET` | `/api/itad/jobs/{id}/assets` (existing) | assets.view | new filters `dataBearing=unknown\|true\|false`, `status=…`; items gain `status`, `dataBearingSource` | — |
| `GET` | `/api/itad/jobs/{id}/sanitization` | sanitization.view | `page`, `pageSize`, `status`, `search` → data-bearing assets with the latest run summary | 404 |
| `GET` | `/api/itad/jobs/{id}/assets/{assetId}/sanitization` | sanitization.view | → runs (with evidence) + status history | 404 |
| `POST` `itad.sanitization.start` | `…/assets/{assetId}/sanitization/runs` | execute | `method`, `methodDetail?`, `tool`, `toolVersion`; lock header | 400 validation; 409 `processing_required` / `asset_transition_not_allowed` / version |
| `POST` `itad.sanitization.record_result` | `…/sanitization/runs/{runId}/result` | execute | `result`, `verificationMethod`, `verificationNotes?` | 400 `verification_notes_required` (FAIL); 409 `run_closed` / `processing_required` |
| `POST` `itad.sanitization.abort` | `…/sanitization/runs/{runId}/abort` | execute | `reason` | 400 `reason_required`; 409 `run_closed` |
| `POST` `itad.sanitization.approve_retry` | `…/assets/{assetId}/sanitization/retry` | manage | `reason`; lock header | 400; 409 `asset_transition_not_allowed` |
| `POST` `itad.sanitization.bulk_start` | `/api/itad/jobs/{id}/sanitization/bulk-start` | execute | `assetIds (1–200)`, run fields | 409 with `blockingAssetIds` when any asset is not `sanitization_required` |
| `POST` `itad.sanitization.bulk_record_result` | `/api/itad/jobs/{id}/sanitization/bulk-result` | execute | `assetIds (1–200)`, result fields | 409 with `blockingAssetIds` when any asset has no open run |
| `POST` `itad.sanitization.attach_evidence` | `/api/itad/jobs/{id}/sanitization/evidence` | execute | multipart `file`, `runIds[]` (1–200) | 400 file errors; 409 `job_terminal` |
| `GET` | `…/sanitization/evidence/{attachmentId}/file` | sanitization.view | download | 404 |
| `GET` | `/api/itad/sanitization/tools` | sanitization.view | `search` → distinct tools + versions used in the organization | — |

Changes to existing contracts, all additive:
- `receivingComplete` detail `dataBearingUndecided`;
- `allAssetsProcessed` detail `sanitizationPending`, which rejects a confirmation with `condition_unmet`;
- `GET /api/itad/jobs` items gain `sanitizationPendingCount`;
- the reconciliation summary gains `dataBearingUndecided`;
- manifest preview/import accept the target field `dataBearing`;
- the job CRUD accepts `defaultDataBearing`.

## Events

| Event | Payload (all with `jobId`, `tenantId`, `organizationId`) | Emitted |
|---|---|---|
| `itad.asset.sanitization_required` | `assetId`, `dataBearingSource` | first entry only; persistent |
| `itad.asset.data_bearing_changed` | `assetId`, `from`, `to`, `source`, `actorUserId`, `reason` | after commit |
| `itad.sanitization.run_started` | `runId`, `assetId`, `method`, `actorUserId`, `bulkBatchId` | after commit |
| `itad.sanitization.run_passed` / `run_failed` / `run_aborted` | `runId`, `assetId`, `actorUserId` | after commit; `run_failed` persistent (Epic 4 input) |
| `itad.asset.sanitization_retry_approved` | `assetId`, `actorUserId`, `reason` | after commit |

## UI and Interaction Contracts

**Job form:** new field "Default: carries data" (`Not set` / `Yes` / `No`), editable until processing, with the hint "Applied to devices scanned after this is set".

**Manifest wizard:** a new mapping target "Carries data". The preview shows the parsed value and `data_bearing_unrecognized` warnings.

**Receiving tab:**
- the "Carries data" column shows the source as a muted hint (manifest / job default / manual / bulk);
- a filter "Carries data: Not determined / Yes / No";
- row selection with bulk actions "Mark as carrying data" and "Mark as not carrying data" (confirmation dialog with the count);
- a counter "Not determined", and the status panel blocker text `dataBearingUndecided`.

**Sanitization tab** (new, `?tab=sanitization`, `itad.sanitization.view`, job tab only per Q15):
- counters: required, in progress, sanitized, review required;
- a status filter and search over data-bearing assets;
- columns: serial, model, status badge, last run (method / tool / result / when / operator), runs count;
- row actions:
  - Start run (dialog with method, detail, tool and version with suggestions);
  - Record result (PASS/FAIL, verification method, notes, optional evidence upload);
  - Abort (reason);
  - Approve retry (manager, reason);
  - History (dialog: runs with all fields and evidence links, status transitions with actors and reasons);
- bulk actions on selected rows: "Start run" and "Record result" (same dialogs; all-or-nothing, blocking serials listed on error), plus "Attach evidence" for selected rows' latest runs;
- a note when the job is not in `processing`: "Sanitization runs are possible while the job is in processing".

**Status panel:** `start_closeout` disabled with the detail "Devices are waiting for sanitization" while any are pending.

All strings use i18n in 5 locales. Every surface covers loading, empty, error and conflict states, keyboard use, dark mode and 390 px. Status colors come from `StatusBadge` variants only: required = info, in progress = info, sanitized = success, review = warning.

## Security and Privacy

- Feature-based checks only. Sanitization actions are never possible with receiving features alone.
- Runs, history and evidence files are scoped by tenant, organization and job. Evidence is downloadable only through the itad route, which needs `itad.sanitization.view`.
- Free-text notes and reasons carry the hint "Avoid personal data". Events carry ids, enums and reasons only.
- Runs and transitions are append-only; no API edits or deletes them.

## Edge Cases & Failure Scenarios

| Case | Behavior |
|---|---|
| Job default set after some assets were scanned | Applies to later scans only; existing unknown assets show in the "Not determined" filter for a bulk decision |
| Manifest says `false`, job default `true` | Manifest wins (priority 1); the source shows "manifest" |
| UNEXPECTED asset | Job default or unknown |
| Bulk classify includes an asset with an open run (processing) | 409 `sanitization_in_progress` with its id; nothing changes |
| Asset re-scanned after void | New asset; `dataBearing` resolved again from the sources |
| Run open when the job is put on hold | Run stays open; result/abort are refused until the job resumes (`processing_required`) |
| Run open when the job is cancelled | `cancel` closes it in the same transaction: `ABORTED`, reason `job_cancelled`; the asset returns to `sanitization_required` (history row); `run_aborted` event after commit |
| Manifest item corrected after the device was scanned | The asset keeps its value (snapshot rule); the operator re-classifies it if needed |
| Job already completed/cancelled before the migration with data-bearing assets | Not backfilled; assets keep `received`, the job stays as it was |
| Two technicians start the same asset | Job/asset lock serializes; the second gets 409 `asset_transition_not_allowed` (unique open-run index as backstop) |
| FAIL then retry then PASS | Two runs (FAIL, PASS) + 5 transitions; status `sanitized` |
| Re-classify `sanitized` → `false` (manager, reason) | Status `received`; runs stay; history row with reason |
| Manager classifies an asset `→ true` in `closeout_review` | 409 `sanitization_not_possible`; nothing changes (runs need `processing`, and there is no way back) |
| Evidence upload fails | Nothing linked; the run result is unaffected |
| Large bulk (200 assets) | One transaction; assets locked in id order; all-or-nothing |

## Risks & Impact Review

- **Receiving gate change:** jobs in `receiving` with unknown assets can no longer reach `processing` until classified. Bulk classify makes it one action. Dev and test data are affected. The backfill sets nothing to unknown, because existing unknowns stay unknown.
- **`allAssetsProcessed` semantics:** it is no longer purely manual. The jobs spec is amended, and existing tests that confirm it with data-bearing assets need sanitized assets first.
- **Lock contention in bulk:** one job lock plus up to 200 asset locks per request; acceptable for warehouse batch sizes. The cap bounds the transaction.
- **Cancel command change:** `cancel` in `commands/transitions.ts` gains a side effect (closing open runs). It runs inside the existing locked transaction, and the job transition contract is unchanged.
- **Rollback:** migrations only add columns, tables and an index, plus the backfill (reversible: `sanitization_required` back to `received`). The condition changes revert by restoring the previous `evaluate`.

## Integration Coverage

| Test ID | Level | Scenario | REQ |
|---|---|---|---|
| TEST-301 | unit | `dataBearing` resolution precedence; manifest value parsing (all accepted forms, empty, unrecognized) | 301, 302 |
| TEST-302 | unit | sanitization state machine: every allowed and refused (status, action) pair, incl. `received → received` for classify `false` and no-op re-classification; classification rules per job status; `sanitization_failed` rejected as a persisted status | 306, 307, 310 |
| TEST-303 | unit | `receivingComplete` with undecided assets; `allAssetsProcessed` with pending sanitization (unmet, confirmation refused) | 305, 312 |
| TEST-304 | API | import with a `dataBearing` column (yes/no/tak/blank/garbage → warning); job default; scans: manifest value wins, default for unexpected, unknown without either; `status` and `source` per asset; one `sanitization_required` event per asset | 301–303, 306 |
| TEST-305 | API | bulk classify unknown → true/false in receiving; `start_processing` blocked by `dataBearingUndecided` until done; re-classify in processing without manage → 403, with manage without reason → 400, with reason → 200 + history; refused during an open run; in `closeout_review` `true → false` accepted, `→ true` → 409 `sanitization_not_possible` | 304, 305, 310 |
| TEST-306 | API | single run PASS (all fields, sanitized); FAIL (notes required; review_required; two history rows); retry by manager; run 2 PASS; history shows both runs; abort returns to required; cancelling a job with an open run closes it as `ABORTED` / `job_cancelled`; a manifest correction after the scan leaves the asset unchanged | 301, 307–309 |
| TEST-307 | API | runs refused in receiving and on hold; receiving-only user → 403 on start/result; view-only user reads runs but cannot act; other organization → 404 | 311 |
| TEST-308 | API | bulk start 20 assets (one blocking → 409, nothing started); bulk PASS; bulk evidence linked to 20 runs, downloadable once each | 313, 308 |
| TEST-309 | API | `start_closeout` refused (`sanitizationPending`) until all data-bearing assets are sanitized; then manual confirmation accepted | 312 |
| TEST-310 | API (**E2E**) | laptop job, default `true`; manifest with one `false`; scan all + one unexpected; bulk-classify nothing left; processing; run FAIL → retry → PASS for one, bulk PASS for the rest; closeout passes | all |
| TEST-311 | UI | job default field; Receiving: unknown filter + bulk classify; Sanitization tab: start (tool suggestion), FAIL with notes, retry, PASS, history dialog, bulk start/result; keyboard; light/dark, 390 px; console check | 304, 307, 313 |

## Implementation Status

| Phase | Status | Evidence |
|---|---|---|
| 1 — Classification and receiving gate | done (2026-10-09) | Migration `Migration20261009153019_itad` reviewed and applied to dev. `yarn generate`, typecheck, lint (0 errors), ds:check (313 files), unit tests 220/220 (TEST-301, TEST-302 classification part, TEST-303 receiving part), build in the ephemeral environment. Integration: TC-ITAD-201 (TEST-304), TC-ITAD-202 (TEST-305 receiving part), TC-ITAD-203 (TEST-311 receiving part); TC-ITAD-001/012/109/113/114 and the flow fixture adjusted to the new field and gate. Full TC-ITAD regression 35/35. |
| 2 — Runs | not started | |
| 3 — Bulk and closeout gate | not started | |

Phase 1 notes:
- `itad_asset_status_transitions` ships in Phase 1 (scan decisions with `actor_user_id = null`, classifications with the user).
- The asset edit keeps "Not determined" only while the value is undetermined; a decided value cannot be unset (400 `data_bearing_cannot_be_unset`).
- Classification source: the asset edit records `manual`, the classify endpoint (bulk action) records `bulk`.
- Outside receiving the classify endpoint returns 409 `assets_locked` until Phase 2 adds the manager rules.

## Implementation Phases

Each phase ends with `yarn generate && yarn typecheck && yarn lint && yarn ds:check && yarn test && yarn build`, its integration tests and the full TC-ITAD regression in the ephemeral environment (dev server stopped). Migrations are reviewed and approved before applying.

### Phase 1 — Data-bearing classification and receiving gate

- **Scope:**
  - `domain/data-bearing.ts` and asset status values;
  - migration: asset columns, manifest item `data_bearing`, job `default_data_bearing`, backfill, status index, and `itad_asset_status_transitions` (moved here from Phase 2 so receiving classifications are recorded; Phase 2 adds `run_id`);
  - manifest mapping target and parsing;
  - job default field, editability matrix and form;
  - scan resolution, status `sanitization_required`, event;
  - `itad.assets.classify` (single + bulk, receiving rules) and the Receiving tab filter and bulk actions;
  - `receivingComplete` blocker `dataBearingUndecided`.
- **Exit:** TEST-301, 303 (receiving part), 304, 305 (receiving part); TEST-311 (Receiving part).

### Phase 2 — Sanitization runs, PASS/FAIL, retry

- **Depends on:** Phase 1.
- **Scope:**
  - `domain/sanitization-state-machine.ts`;
  - migration: runs, evidence, `run_id` on status transitions;
  - ACL `itad.sanitization.*` and defaults;
  - commands start / record_result / abort / approve_retry / attach_evidence;
  - re-classification after receiving (manage + reason);
  - read routes, tool suggestions, evidence download;
  - Sanitization tab (single actions, history dialog, evidence);
  - job `cancel` closes open runs;
  - events.
- **Exit:** TEST-302, 305 (processing part), 306, 307; TEST-311 (single actions).

### Phase 3 — Bulk sanitization and closeout gate

- **Depends on:** Phase 2.
- **Scope:**
  - bulk start / bulk result / bulk evidence (commands, routes, tab bulk actions);
  - `allAssetsProcessed` blocker `sanitizationPending` and the decision rule change;
  - `sanitizationPendingCount` on the jobs list;
  - jobs spec amendment;
  - existing tests adjusted (closeout with data-bearing assets).
- **Exit:** TEST-303 (closeout part), 308, 309, 310 (E2E), 311 (bulk); full TC-ITAD regression green.

## Implementation Plan

### Phase 1
1. `domain/data-bearing.ts` (resolution, parsing, aliases) + unit tests (TEST-301).
2. Entities and migration (asset columns, manifest item column, job column, backfill, index) → review → apply.
3. Manifest mapping target `dataBearing` (domain mapping, preview/import, wizard field) + TEST-304 (import part).
4. Job `defaultDataBearing`: validators, editability matrix, CRUD, form field.
5. Scan command: resolution + status + event; asset list fields and filters; TEST-304 (scan part).
6. `itad.assets.classify` command and route; the asset edit routed through it; Receiving tab filter, column hint, bulk actions; TEST-305 (receiving part).
7. `receivingComplete` blocker + reconciliation summary field + unit tests; TEST-303 (receiving part); fix the Epic 2 tests that reach processing (flow fixtures classify assets).

### Phase 2
1. `domain/sanitization-state-machine.ts` + TEST-302.
2. Entities and migration (runs, evidence, transitions) → review → apply.
3. ACL + defaults; `yarn mercato auth sync-role-acls` in dev.
4. Commands start / record_result / abort / approve_retry + routes; TEST-306, TEST-307.
5. Re-classification after receiving (manage + reason; `closeout_review` only `true → false`) + TEST-305 (processing and closeout part).
6. Extend the job `cancel` transition (`commands/transitions.ts`) to abort open sanitization runs in the same transaction (`ABORTED` / `job_cancelled`, asset history rows, `run_aborted` events after commit) + TEST-306 (cancel part).
7. Evidence upload/link/download through the attachments port.
8. Sanitization tab (list, single actions, history dialog, evidence, tool suggestions) + i18n; TEST-311 (single).

### Phase 3
1. Bulk start / bulk result / bulk evidence commands + routes; TEST-308.
2. `allAssetsProcessed` blocker + decision rule (`condition_unmet` for an unmet manual condition) + unit tests; TEST-309; adjust TC-ITAD-009/010/015 (closeout).
3. Jobs list `sanitizationPendingCount`; status panel detail.
4. Tab bulk actions + i18n; TEST-311 (bulk); TEST-310 E2E; full regression; amend the jobs spec.

## Requirement Traceability

| REQ | Phases | Tests |
|---|---|---|
| 301 | 1 | 301, 304 |
| 302 | 1 | 301, 304 |
| 303 | 1 | 304 |
| 304 | 1 | 305, 311 |
| 305 | 1 | 303, 305 |
| 306 | 1, 2 | 302, 304 |
| 307 | 2 | 302, 306 |
| 308 | 2, 3 | 306, 308 |
| 309 | 2 | 306 |
| 310 | 1, 2 | 302, 305 |
| 311 | 2 | 307 |
| 312 | 3 | 303, 309 |
| 313 | 3 | 308, 311 |

## Decisions (answered 2026-10-09)

| ID | Decision |
|---|---|
| Q1 | One spec, phases (classification → runs → bulk + closeout gate) |
| Q2 | **(b)** extend `ItadAsset.status` with the sanitization states |
| Q3 | FAIL is the run result; `sanitization_failed` is recorded as a transition state and the asset rests in `review_required` |
| Q4 | Minimal manager action "Approve retry" (`review_required → sanitization_required`, reason) |
| Q5 | **(b)** runs only while the job is `processing` |
| Q6 | Method: NIST SP 800-88 enum + free-text detail; tool and version free text with suggestions |
| Q7 | Verification method enum + notes + optional evidence files via `attachments` |
| Q8 | "Abort run" with reason; the run stays as `ABORTED`, the asset returns to `sanitization_required` |
| Q9 | Bulk start and bulk result (one run per asset) |
| Q10 | Manifest values parsed leniently; unrecognized value = accepted-warning, treated as no value |
| Q11 | Job field `defaultDataBearing` for later scans; customer policy deferred |
| Q12 | Free correction during receiving; in `processing` `itad.sanitization.manage` + reason + history (both directions); in `closeout_review` only `true → false` (`→ true` = 409 `sanitization_not_possible`); refused during an open run |
| Q13 | `itad.sanitization.view/execute/manage`; admin all, employee view; no new roles |
| Q14 | `allAssetsProcessed` stays manual, plus the data blocker `sanitizationPending` |
| Q15 | **(b)** job tab only (no cross-job queue page) |

## Changelog

| Date | Change |
|---|---|
| 2026-10-09 | Skeleton with framework findings and open questions |
| 2026-10-09 | Questions answered; full draft with three phases |
| 2026-10-09 | Review fixes: classify `false` on `received → received` (and no-op/refused rows); job cancel closes open runs as `ABORTED`/`job_cancelled`; backfill limited to non-terminal jobs; snapshot rule for `dataBearing`; persisted vs history-only statuses split; evidence owned by the job (single-owner `attachments` port) |
| 2026-10-09 | Review fixes 2: `closeout_review` allows only `true → false` (no dead end without runs); explicit plan step for the cancel change; runs "never deleted or replaced, completed exactly once" |

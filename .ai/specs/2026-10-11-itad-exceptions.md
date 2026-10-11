# ITAD Exceptions, Permissions & Auditability

**Date**: 2026-10-11
**Status**: Ready for implementation (approved 2026-10-11)

> Spec 4 of the app-owned `itad` module (Epic 4), after `2026-10-02-itad-jobs.md`, `2026-10-05-itad-manifest-reconciliation.md` and `2026-10-09-itad-asset-sanitization.md`. Source: "Epic 4 – Exceptions, Permissions & Auditability — development requirements" (E4-001 … E4-072, AC-401 … AC-408). Module rules: `src/modules/itad/AGENTS.md`.

## TLDR

**Exception records.** Four operational problems the module already detects become durable **Exception** records: status OPEN / RESOLVED, optional assignee, and an append-only history. Each one is created by the system from a domain fact, in the transaction that records that fact:

| Type | Created when | Resolved by |
|---|---|---|
| `MISSING_FROM_DELIVERY` | `start_processing`, per active manifest item still missing | manager: `not_shipped` / `lost_in_transit` / `manifest_error` + reason |
| `UNEXPECTED_ASSET` | `start_processing`, per active asset still unexpected | manager: `accepted_into_job` + reason |
| `DUPLICATE_SERIAL` | a duplicate scan | existing "same device" action, or a new manager action "second device set aside" (closes a confirmed "different device" duplicate) |
| `SANITIZATION_FAILED` | a FAIL result (single or bulk) | existing manager retry, or re-classification as not data-bearing |

**Common rules:**
- Job cancellation resolves every OPEN exception with `job_cancelled`.
- `noBlockingExceptions` becomes a data condition: any OPEN exception blocks `complete`, and no manual confirmation exists any more.
- New features `itad.exceptions.view` and `itad.exceptions.manage`; underlying actions keep their own features.
- Each job gets an **Exceptions** tab.
- A new **Asset detail** page shows the device, its exceptions and a business **timeline**. The timeline is assembled at read time from records the module already keeps, plus the new exception history; it never shows raw audit-log rows.

## Problem Statement

Epics 2 and 3 detect operational problems, but each lives in its own flow:
- missing and unexpected devices are derived counters;
- duplicates are intake-scan flags;
- a failed wipe is an asset status.

None of them is a record that can be owned, assigned and resolved with an outcome. Two further gaps:
- Closeout still relies on a manual "no blocking exceptions" checkbox.
- A confirmed "different device" duplicate has no way out; it blocks receiving by design, waiting for this epic.

There is also no readable business history of a device: the technical audit log answers who called which command, not what happened to the device.

## Goals

| REQ | Requirement | Source |
|---|---|---|
| REQ-401 | Durable Exception records; resolved ones stay in history and are never deleted | E4-001 |
| REQ-402 | Exceptions are created only by the system from domain facts; no "create exception" action | E4-003 |
| REQ-403 | Status OPEN / RESOLVED; assignment is separate (`assignedTo`), recorded in history, and never resolves | E4-004, E4-022 |
| REQ-404 | MISSING_FROM_DELIVERY and UNEXPECTED_ASSET materialize once, when the job enters processing | E4-010, E4-011 |
| REQ-405 | DUPLICATE_SERIAL is created at the duplicate scan; SANITIZATION_FAILED for every FAIL run | E4-012, E4-013 |
| REQ-406 | One exception per source occurrence, also on retries and redelivery | E4-014, E4-072 |
| REQ-407 | Resolution always records outcome, resolver and time. Where a domain action solves the problem, that action resolves the exception | E4-020, E4-021 |
| REQ-408 | A confirmed different-device duplicate can be closed with outcome `second_device_set_aside` | E4-021 (Q3) |
| REQ-409 | All four types block while OPEN; `noBlockingExceptions` is data-driven and cannot be confirmed by hand | E4-030, E4-031 |
| REQ-410 | `itad.exceptions.view` / `.manage`; receiving or sanitization features alone never resolve except through their own domain action (Q7) | E4-040 … E4-042 |
| REQ-411 | Exception history: creation, assignment, resolution, actors, times | E4-052 |
| REQ-412 | Asset detail with related exceptions and a chronological business timeline | E4-053, E4-062, E4-063 |
| REQ-413 | Job Exceptions tab with status / type / assignee filters, OPEN first | E4-060, E4-061 |
| REQ-414 | Existing unresolved cases of non-terminal jobs become exceptions at release | Q10 |

## Non-goals

- Arbitrary or user-defined exception types; SLA, due dates, escalation; notifications; external ticketing.
- A cross-job exception queue (E4 non-goal); exceptions are listed per job, and the jobs list only gets a counter.
- Returning an unexpected device to the customer (Q5): that needs an asset "returned" state that excludes it from processing and closeout. It is deferred to the disposition work.
- Registering a second physical device with an identical serial (Q3): a deliberate mechanism later, never a serial suffix.
- Bulk exception actions; bulk sanitization retry (Epic 3 decision).
- Certificates, grading, disposition (later epics).

## Fit-Gap (verified 2026-10-11, Open Mercato 0.8.0 + `itad` after Epic 3)

| Need | Already available | Gap / decision |
|---|---|---|
| Technical audit | `audit_logs:action_log`: every `itad` command writes `buildLog`; page `/backend/audit-logs` | Stays technical; the timeline never reads it (E4-050) |
| Domain events | `itad.*` events (some persistent), emitted after commit | Integration points only. Exceptions are written in the domain transactions, so they do not depend on event delivery (E4-072) |
| Receiving | `itad_assets` (received at/by, void fields), `itad_intake_scans` (every scan; duplicate resolution or flag with actor, time, note); reconciliation derived at read time | Missing and unexpected become persistent occurrences at `start_processing`. There is no transition from `processing` back to `receiving`, so this happens once per job |
| Asset history | `itad_asset_status_transitions` (scan decisions, classifications with reason, run actions, retry) | none |
| Sanitization | runs (+ evidence), FAIL → `review_required`, `approve_retry` | FAIL opens an exception; retry, re-classification and cancel resolve it |
| Conditions | registry with data conditions evaluated under the job lock; `noBlockingExceptions` is `manual` and used by `complete` | becomes `data`, `manualAllowed: false` |
| Permissions | feature ACL; admin `itad.*`, employee selected features | add `itad.exceptions.view` / `.manage` |
| Assignee lookup | `module-integrations/users.ts` (`auth:user` through the query engine). The installed "assignable staff" endpoint needs the disabled `staff` module | itad lookup of the organization's users |
| Asset detail | none: table rows, the sanitization history dialog, the serial lookup page | new page |

## Proposed Solution

### Exception record

`ItadException` is one record per **source occurrence**, identified by `source_key`:

| Type | `source_key` | Links |
|---|---|---|
| MISSING_FROM_DELIVERY | `missing:{manifestItemId}` | manifest item (no asset, E4-062) |
| UNEXPECTED_ASSET | `unexpected:{assetId}` | asset |
| DUPLICATE_SERIAL | `duplicate:{intakeScanId}` | intake scan + its asset |
| SANITIZATION_FAILED | `sanitization_failed:{runId}` | run + asset |

**Idempotency (E4-014, E4-072).** A unique index on (tenant, organization, `source_key`) covers all statuses. An occurrence can never produce a second exception, even when a command or event is replayed. A genuinely new occurrence has a new source id and so a new key:
- a second FAIL run;
- a new duplicate scan;
- a device re-scanned after being voided gets a new asset.

The writer inserts with "skip if the key exists". Because `start_processing` happens once per job, missing and unexpected are evaluated once.

**Stored fields.** The record stores `serial` as a display snapshot (from the item or the asset) so the list needs no joins. Everything else about the source is read from the source record (E4-071: run data is never copied).

### Lifecycle and resolution

```
            created (system, in the fact's transaction)
                 │
               OPEN ── assign / reassign / unassign (manage; history row; stays OPEN)
                 │
   resolve with outcome + reason (who, when) ──▶ RESOLVED (final; never reopened)
```

| Type | Allowed outcomes | Resolved by | Feature(s) | Reason |
|---|---|---|---|---|
| MISSING_FROM_DELIVERY | `not_shipped`, `lost_in_transit`, `manifest_error` | "Resolve" on the exception | `itad.exceptions.manage` | required |
| UNEXPECTED_ASSET | `accepted_into_job` | "Resolve" on the exception | `itad.exceptions.manage` | required |
| DUPLICATE_SERIAL | `same_device` | the existing duplicate action "Same device" (also after a mistaken different-device flag) | `itad.assets.receive` (Q7) | optional (the scan note) |
| DUPLICATE_SERIAL | `second_device_set_aside` | new duplicate action "Second device set aside", only for a scan flagged as a different device; closes the scan with resolution `different_device_set_aside` | `itad.exceptions.manage` | required |
| SANITIZATION_FAILED | `retry_approved` | the existing manager retry (`approve_retry`) | `itad.sanitization.manage` **and** `itad.exceptions.manage` (Q6) | required (the retry reason) |
| SANITIZATION_FAILED | `not_data_bearing` | re-classification of the `review_required` asset as not data-bearing | `itad.sanitization.manage` (classification rule) | required (the classification reason) |
| any | `job_cancelled` | the job `cancel` transition | `itad.jobs.transition` | the cancel reason |

**General rules:**
- "Resolve" on a DUPLICATE_SERIAL or SANITIZATION_FAILED exception returns 409 `resolve_through_domain_action`. The UI offers the domain action instead (E4-021).
- MISSING and UNEXPECTED resolutions never change manifest or asset data.
- **Resolution timing (Q2).** DUPLICATE_SERIAL exceptions are resolved in receiving: the Epic 2 rule stays, so a pending or flagged duplicate still blocks `start_processing`. The exception gives the problem a durable record and also blocks closeout.
- **Multiple open exceptions on one asset.** If a SANITIZATION_FAILED and other exceptions are open on the same asset, only the FAIL one is resolved by retry or re-classification; the others keep their own resolution.

### Creation points (same transaction as the fact)

| Command / transition | Exception work |
|---|---|
| `itad.assets.scan` (result `duplicate`) | open DUPLICATE_SERIAL |
| `itad.assets.resolve_duplicate` | resolve the scan's DUPLICATE_SERIAL as `same_device` |
| new `itad.assets.set_aside_duplicate` | close the flagged scan and resolve as `second_device_set_aside` |
| `itad.jobs.transition` `start_processing` | open MISSING for every active item without an active asset, and UNEXPECTED for every active asset without an active item (the reconciliation reader, under the job lock) |
| `itad.sanitization.record_result` / `bulk_record_result` FAIL | open SANITIZATION_FAILED per run |
| `itad.sanitization.approve_retry` | resolve the asset's open SANITIZATION_FAILED as `retry_approved` |
| `itad.assets.classify` → `false` of a `review_required` asset | resolve as `not_data_bearing` |
| `itad.jobs.transition` `cancel` | resolve all OPEN as `job_cancelled` |

**Write path.** All writes go through `services/exception-writer.ts`, a plain module that receives the caller's transaction (module AGENTS.md "Transactions"). Events are emitted by the commands after commit.

### Closeout gate

- `noBlockingExceptions` becomes `source: 'data', manualAllowed: false`. While any OPEN exception exists for the job it is `unmet`, with detail `openExceptions`; otherwise it is `met`. A manual confirmation returns `confirmation_not_allowed`.
- It stays on the `complete` transition (`closeout_review → completed`), where the job spec placed it. `start_closeout` keeps `allAssetsProcessed` only, so managers can work through exceptions in closeout review.
- `complete` then needs only the manual `requiredDocumentsComplete` confirmation (Epic 5 territory).

### Business timeline (E4-050 … E4-054)

A read-time assembler (`services/asset-timeline.ts`) merges authoritative sources into entries `{ at, kind, actor | system, details }`, sorted by time with a stable tie-break:

| Source | Entries |
|---|---|
| `itad_assets` | received (+ MATCHED / UNEXPECTED from the first scan); voided (reason) |
| `itad_intake_scans` of the asset | scanned again (duplicate); resolved as same device; flagged as different device; second device set aside |
| `itad_asset_status_transitions` | data-bearing decided / changed (source, reason); sanitization started / passed / failed / aborted (method, tool from the run); retry approved |
| `itad_exception_events` of the asset's exceptions | exception opened (system), assigned / reassigned / unassigned, resolved (outcome, reason) |
| `itad_job_status_transitions` of the job | **reconciled** milestone = `start_processing`; job completed / cancelled |

Opening any page never writes timeline data (E4-054). The only new history is `itad_exception_events`.

**Visibility:** entries are filtered by the viewer's features. Sanitization entries need `itad.sanitization.view`, exception entries need `itad.exceptions.view`; the rest needs `itad.assets.view`.

## Data Models

All tables carry `tenant_id` and `organization_id`; every index starts with them. One migration per phase that changes schema; migrations are reviewed before applying.

### `ItadException` — `itad_exceptions` (new)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `job_id` | uuid FK → `itad_jobs` | |
| `type` | text | `missing_from_delivery` \| `unexpected_asset` \| `duplicate_serial` \| `sanitization_failed` |
| `status` | text | `open` \| `resolved` |
| `source_key` | text | occurrence identity, see above |
| `asset_id` | uuid null FK → `itad_assets` | |
| `manifest_item_id` | uuid null FK → `itad_manifest_items` | |
| `intake_scan_id` | uuid null FK → `itad_intake_scans` | |
| `sanitization_run_id` | uuid null FK → `itad_sanitization_runs` | |
| `serial` | text | display snapshot |
| `assigned_to_user_id` | uuid null | |
| `resolution_outcome` | text null | per-type enum above |
| `resolution_reason` | text null | |
| `resolved_by_user_id` | uuid null | always a user (the actor of the resolving action) |
| `resolved_at` | timestamptz null | |
| `created_at`, `updated_at` | timestamptz | `updated_at` = optimistic-lock version for assign / resolve |

Indexes:
- unique (`tenant_id`, `organization_id`, `source_key`);
- (`tenant_id`, `organization_id`, `job_id`, `status`, `type`);
- (`tenant_id`, `organization_id`, `asset_id`) where `asset_id is not null`.

Rows are never deleted.

### `ItadExceptionEvent` — `itad_exception_events` (new, append-only)

`id`, `job_id`, `exception_id` FK, `kind` (`created`, `assigned`, `unassigned`, `resolved`), `assigned_to_user_id` null, `previous_assigned_to_user_id` null, `outcome` null, `reason` null, `actor_user_id` (null = system), `created_at`.

Index: (`tenant_id`, `organization_id`, `exception_id`, `created_at`).

### Changes to existing tables

- `itad_intake_scans.resolution` gains the value `different_device_set_aside` (text column; vocabulary in `domain/job-types.ts`).

### Backfill (Q10, migration of Phase 1; non-terminal jobs only)

| Situation | Exception created |
|---|---|
| duplicate scans with `resolved_at is null` (pending or flagged) | OPEN DUPLICATE_SERIAL |
| the latest run of an asset in `review_required` with `result = 'FAIL'` | OPEN SANITIZATION_FAILED |
| jobs in `processing`, `closeout_review`, or `on_hold` with `status_before_hold` in those: active items without an active asset | OPEN MISSING |
| the same jobs: active assets without an active item | OPEN UNEXPECTED |

- Every backfilled exception gets a `created` event with actor `null`.
- The unique `source_key` makes the migration safe to re-run.
- Terminal jobs (`completed`, `cancelled`) are not touched.

## API, Command, and Error Contracts

All routes are custom routes with `metadata` and `openApi`, scoped to a readable job (404 for other organizations). Commands go through `lib/command-route.ts`.

| Method / command | Path | Feature | Input / output | Errors |
|---|---|---|---|---|
| `GET` | `/api/itad/jobs/{id}/exceptions` | exceptions.view | filters `status`, `type`, `assignedTo` (`me` \| `unassigned` \| user id), `assetId`, page; items with serial, links, context, assignee name, resolution, resolver; `counts` by type for OPEN | 400, 404 |
| `GET` | `/api/itad/jobs/{id}/exceptions/{exceptionId}` | exceptions.view | the exception + its events (actors' names) | 404 |
| `POST` `itad.exceptions.assign` | `…/exceptions/{exceptionId}/assign` | exceptions.manage | `{ assignedToUserId: uuid \| null }`; lock header | 400 `assignee_invalid` (not an active user of the organization); 409 `exception_resolved` / version |
| `POST` `itad.exceptions.resolve` | `…/exceptions/{exceptionId}/resolve` | exceptions.manage | `{ outcome, reason }` (MISSING, UNEXPECTED only); lock header | 400 `outcome_invalid` / `reason_required`; 409 `exception_resolved` / `resolve_through_domain_action` / version |
| `POST` `itad.assets.set_aside_duplicate` | `/api/itad/jobs/{id}/scans/{scanId}/set-aside` | exceptions.manage | `{ reason }`; only a scan flagged as a different device; job in receiving | 400 `reason_required`; 409 `receiving_not_active` / `scan_not_flagged` |
| `GET` | `/api/itad/exceptions/assignees` | exceptions.manage | `search` → active users of the selected organization (id, name/email), at most 20 | — |
| `GET` | `/api/itad/jobs/{id}/assets/{assetId}` | assets.view | asset detail: fields, status, data-bearing (source), reconciliation, open exception count | 404 |
| `GET` | `/api/itad/jobs/{id}/assets/{assetId}/timeline` | assets.view | entries filtered by the caller's features | 404 |

**Changes to existing contracts** (all additive unless marked):
- `noBlockingExceptions` becomes a data condition (detail `openExceptions`). ⚠️ A manual confirmation now returns `confirmation_not_allowed`.
- `POST …/sanitization/retry` now requires `itad.exceptions.manage` in addition to `itad.sanitization.manage` (⚠️ narrowing; Q6).
- `GET /api/itad/jobs` items gain `openExceptionCount`.
- `GET /api/itad/jobs/{id}/assets` items gain `openExceptionCount`.
- Duplicate scan responses and lists show the linked exception id.

## Events

| Event | Payload (+ `jobId`, `tenantId`, `organizationId`) | Emitted |
|---|---|---|
| `itad.exception.created` | `exceptionId`, `type`, `sourceKey`, `assetId` | after the creating command commits; persistent |
| `itad.exception.assigned` | `exceptionId`, `assignedToUserId` (null = unassigned), `actorUserId` | after commit |
| `itad.exception.resolved` | `exceptionId`, `type`, `outcome`, `actorUserId` | after commit; persistent |

Consumers use `exceptionId` as the idempotency key. Correctness never depends on these events (E4-072).

## Users, Permissions, and Scope

| Feature | Grants | Depends on | Default roles |
|---|---|---|---|
| `itad.exceptions.view` | Exceptions tab, exception detail and history; exception entries in the timeline | `itad.jobs.view` | admin (`itad.*`), employee |
| `itad.exceptions.manage` | assign / reassign / unassign; resolve MISSING and UNEXPECTED; set aside a second device; required together with `itad.sanitization.manage` for the retry | `itad.exceptions.view` | admin |

- The receiving role resolves a duplicate only through "Same device" (Q7).
- Sanitization `execute` never resolves anything; FAIL only opens.
- Assignees can be any active user of the job's organization (Q12): `assignedTo` means "responsible person", not a permission.
- Existing tenants get the defaults via `yarn mercato auth sync-role-acls`.

## UI and Interaction Contracts

**Exceptions tab** (`?tab=exceptions`, needs `itad.exceptions.view`):
- **Counters:** open exceptions by type.
- **Table:** `DataTable` with filters status (default **Open**), type, and assignee (Me / Unassigned / a user).
- **Columns:** type, status, serial (link to Asset detail; a MISSING row shows the manifest item and no link), context, assignee, created, resolution (outcome + reason), resolved by / at.
- **Row actions,** shown by type and permission:

  | Action | Shown when | Behavior |
  |---|---|---|
  | Assign / Reassign / Unassign | `itad.exceptions.manage` | dialog with an assignee search |
  | Resolve | MISSING, UNEXPECTED | dialog with outcome and reason |
  | Same device | duplicate, receiving, `itad.assets.receive` | calls the existing scan action |
  | Second device set aside | flagged duplicate, receiving, `itad.exceptions.manage` | reason dialog |
  | Approve retry | SANITIZATION_FAILED, processing, both manage features | the existing retry |
  | History | always | exception events |

**Status panel:** `complete` is disabled with the detail "Open exceptions: N".

**Asset detail page** `/backend/itad/jobs/{jobId}/assets/{assetId}` (needs `itad.assets.view`; Q11):
- header: serial, model, status badge, carries data (source), reconciliation;
- sections: Exceptions (needs `itad.exceptions.view`), Sanitization runs (needs `itad.sanitization.view`, reusing the run history view), Timeline (a vertical list: time, business event, actor or "System").
- It is linked from Receiving and Sanitization rows ("Details") and from the serial lookup page.

All strings use i18n in 5 locales (Polish wording "wyjątek", "zlecenie"). Status and type colors come from `StatusBadge` variants only. Every surface covers loading, empty, error and conflict states, keyboard use, dark mode, 390 px width, and the fixed width of the row-actions menu (short labels).

## Edge Cases & Failure Scenarios

| Case | Behavior |
|---|---|
| Unexpected device, manifest corrected during receiving (AC-402) | Not unexpected at `start_processing` → no exception |
| Device voided in receiving | Not an active asset → no UNEXPECTED; its pending duplicate scans keep their exceptions until resolved |
| Second FAIL after a retry | New run → new SANITIZATION_FAILED (new `source_key`) |
| Bulk FAIL of 20 runs | 20 exceptions in the same transaction |
| Retry by a user with `sanitization.manage` but not `exceptions.manage` | 403; nothing changes |
| Replayed command or event | Unique `source_key` → no second exception |
| Assignee leaves the organization | Exception keeps the id; the name shows "unknown user"; reassign is possible |
| Assign or resolve on a resolved exception | 409 `exception_resolved` |
| Two managers resolve at once | Optimistic lock on `updated_at` → 409 for the second |
| Job on hold | Exceptions can be assigned and MISSING / UNEXPECTED resolved; domain-action resolutions follow their own job-status rules |
| Job cancelled in receiving with pending duplicates | Exceptions resolved `job_cancelled`; scans stay as they are (terminal job) |

## Risks & Impact Review

- **Closeout behavior change:** `noBlockingExceptions` can no longer be confirmed by hand.
  - Jobs in `closeout_review` with backfilled OPEN exceptions cannot complete until they are resolved.
  - The tests that confirm it by hand need changes: TC-ITAD-009, 010 and 015, and the Epic 3 E2E TC-ITAD-210.
- **Retry permission narrowed:** users with `itad.sanitization.manage` but not `itad.exceptions.manage` lose the retry. Admin is unaffected (`itad.*`); employee never had it.
- **Backfill on dev data:** checked before applying, like Epic 3.
- **Transaction scope:** `start_processing` now inserts up to two rows (exception + event) per missing / unexpected device. The manifest limit (5000) bounds it.
- **Rollback:** new tables and columns only. Dropping them, and restoring the previous `noBlockingExceptions` evaluate, reverts the feature.

## Integration Coverage

| Test | Level | Scenario | AC / REQ |
|---|---|---|---|
| TEST-401 | unit | outcomes allowed per type; `resolve_through_domain_action`; source keys; materialization from reconciliation facts; `noBlockingExceptions` met / unmet, manual confirmation refused | REQ-404, 406, 407, 409 |
| TEST-402 | API | 10-item manifest, 9 received → `start_processing` creates exactly one MISSING; `complete` refused until it is resolved (`not_shipped` + reason) | AC-401, AC-406 |
| TEST-403 | API | unexpected scanned, then manifest corrected → no UNEXPECTED; another unexpected kept → exactly one OPEN UNEXPECTED, resolved `accepted_into_job` | AC-402, AC-403 |
| TEST-404 | API | duplicate scan → OPEN DUPLICATE_SERIAL; "same device" by the receiving role resolves it (history kept); flagged duplicate → "second device set aside" by a manager resolves it and unblocks receiving | AC-404, REQ-408 |
| TEST-405 | API | FAIL → SANITIZATION_FAILED; retry resolves it and the asset returns to required; second FAIL → new exception; bulk FAIL → one per run; re-classification false resolves `not_data_bearing`; cancel resolves `job_cancelled` | AC-405 |
| TEST-406 | API | permissions: view reads but gets 403 on assign / resolve; receiving-only and sanitization-execute-only users get 403 on exception actions; retry without `exceptions.manage` gets 403; other organization gets 404 | AC-407 |
| TEST-407 | API | assignment: assign, reassign, unassign recorded; an invalid assignee returns 400; a resolved exception returns 409; idempotency on replay | REQ-403, 406, 411 |
| TEST-408 | API | timeline of a device through receive → classify → FAIL → exception → retry → PASS; actors and system entries; no rows created by reading; feature filtering | AC-408 |
| TEST-409 | UI | Exceptions tab (filters, default Open, resolve dialog, assign dialog, history); status panel blocker; Asset detail timeline; keyboard, 390 px, console check | E4-060 … E4-063 |
| TEST-410 | API (**E2E demo**) | AC-401 … AC-405 in one job, up to completion with no manual `noBlockingExceptions` | AC-401 … AC-406 |

## Implementation Status

| Phase | Status | Evidence |
|---|---|---|
| 1 — Records, creation, domain-action resolution, closeout gate | done (2026-10-11) | Migration `Migration20261011084132_itad` (tables + backfill) reviewed and applied to dev: 13 exceptions backfilled (1 duplicate, 5 missing, 7 unexpected); role ACLs synced. `yarn generate`, typecheck, lint (0 errors), ds:check (343 files), unit tests 238/238 (TEST-401 + condition rules), build in the ephemeral environment. Integration: TC-ITAD-301 (TEST-402 API, AC-401–403, AC-406), TC-ITAD-302 (TEST-404 same-device, AC-404), TC-ITAD-303 (TEST-405, AC-405), TC-ITAD-304 (TEST-406 Phase 1 part, AC-407); TC-ITAD-009/010/210 adjusted. Full TC-ITAD regression 47/47 twice. |
| 2 — Manager resolution, assignment, set-aside, Exceptions tab | not started | |
| 3 — Asset detail and timeline | not started | |

Phase 1 notes:
- Exception ids come from the database default; every creation point flushes the source record first and emits events from the committed rows.
- `start_processing` materializes missing / unexpected in two set-based queries plus one key lookup (no per-row queries).
- TC-ITAD-210 (Epic 3 E2E) now stops at `complete` refused by its open UNEXPECTED exception; TEST-410 covers completion after resolution.
- The "linked exception id" on duplicate scan responses is not added: the Exceptions list already filters by asset and shows `intakeScanId`.

## Implementation Phases

Each phase ends with `yarn generate && yarn typecheck && yarn lint && yarn ds:check && yarn test && yarn build`, its integration tests, and the full TC-ITAD regression in the ephemeral environment (dev server stopped). Migrations are reviewed before applying.

### Phase 1 — Exception records, creation, domain-action resolution and closeout gate

- **Scope:**
  - `domain/exceptions.ts` (types, outcomes, source keys, rules);
  - entities and migration (exceptions, events, scan resolution value, backfill);
  - `services/exception-writer.ts`;
  - creation in scan / `start_processing` / FAIL;
  - resolution in same-device / retry (+ the new permission) / re-classification / cancel;
  - ACL features and defaults;
  - `noBlockingExceptions` from data;
  - read routes (list, detail);
  - `openExceptionCount` on the jobs and assets lists;
  - events;
  - adjust TC-ITAD-009 / 010 / 015 / 210.
- **Exit:** TEST-401, 402 (API), 404 (same-device part), 405, 406 (retry part).

### Phase 2 — Manager resolution, assignment, set-aside, Exceptions tab

- **Depends on:** Phase 1.
- **Scope:**
  - commands assign / resolve / set-aside and their routes;
  - assignee lookup;
  - the Exceptions tab (filters, dialogs, history);
  - the status panel blocker;
  - i18n.
- **Exit:** TEST-403, 404 (set-aside part), 406, 407, 409 (tab part).

### Phase 3 — Asset detail and business timeline

- **Depends on:** Phase 2.
- **Scope:**
  - `services/asset-timeline.ts`;
  - asset detail and timeline routes;
  - the Asset detail page and links from Receiving, Sanitization and lookup;
  - i18n;
  - the E2E demo test;
  - jobs spec amendment.
- **Exit:** TEST-408, 409 (detail part), 410; full regression green.

## Implementation Plan

### Phase 1
1. `domain/exceptions.ts` and the `different_device_set_aside` scan resolution, with unit tests (TEST-401, part).
2. Entities and migration with backfill → review → apply.
3. `services/exception-writer.ts` (open idempotently, resolve, resolve-all-for-job, materialize at `start_processing`).
4. Hook the creation points: scan duplicate, `start_processing`, FAIL (single and bulk).
5. Hook the resolution points:
   - same-device;
   - retry, which now also requires `itad.exceptions.manage` (route metadata and command);
   - re-classification false;
   - cancel.
6. ACL and defaults; `noBlockingExceptions` data condition plus unit tests.
7. Read routes for list and detail; `openExceptionCount` on the jobs and assets lists; events.
8. Integration tests TEST-402 (API), 404 (same-device), 405, 406 (retry); adjust TC-ITAD-009 / 010 / 015 / 210.

### Phase 2
1. Assign and resolve commands and routes, with the optimistic lock (TEST-407, TEST-403).
2. Set-aside command and route (TEST-404, set-aside part).
3. Assignee lookup route (`module-integrations/users.ts`).
4. Exceptions tab, dialogs and history; status panel detail; i18n (TEST-409, tab part).
5. TEST-406 (full).

### Phase 3
1. `services/asset-timeline.ts` with unit tests (ordering, feature filtering).
2. Asset detail and timeline routes (TEST-408).
3. Asset detail page and links; i18n (TEST-409, detail part).
4. TEST-410 E2E demo path; jobs spec amendment; full regression.

## Requirement Traceability

| REQ | Phases | Tests |
|---|---|---|
| 401, 402 | 1 | 401, 402, 405 |
| 403 | 1, 2 | 407 |
| 404 | 1 | 401, 402, 403 |
| 405 | 1 | 404, 405 |
| 406 | 1 | 401, 407 |
| 407 | 1, 2 | 401, 403, 404, 405 |
| 408 | 2 | 404 |
| 409 | 1 | 401, 402, 410 |
| 410 | 1, 2 | 406 |
| 411 | 1, 2 | 407, 408 |
| 412 | 3 | 408, 409 |
| 413 | 2 | 409 |
| 414 | 1 | migration review + 405 |

## Decisions (answered 2026-10-11)

| ID | Decision |
|---|---|
| Q1 | One spec for the epic, three phases (the timeline belongs to the same auditability goal) |
| Q2 | **(a)** Duplicates keep blocking `receivingComplete`; the exception adds a durable record and blocks closeout too |
| Q3 | **(a)** `second_device_set_aside` with a reason; no suffixed serials. Identical serials of two physical devices need a deliberate mechanism later |
| Q4 | **(a)** `not_shipped`, `lost_in_transit`, `manifest_error` (+ reason) |
| Q5 | **(b)** `accepted_into_job` only. A customer return needs an asset state that excludes the device from processing and closeout, so it is deferred |
| Q6 | **(a)** Retry requires `itad.sanitization.manage` and `itad.exceptions.manage` |
| Q7 | **(a)** "Same device" by the receiving role resolves the DUPLICATE_SERIAL exception |
| Q8 | **(a)** Re-classification as not data-bearing resolves the open SANITIZATION_FAILED as `not_data_bearing`, with the same reason, in the same transaction |
| Q9 | **(a)** `cancel` resolves OPEN exceptions as `job_cancelled` |
| Q10 | **(a)** Backfill for non-terminal jobs only |
| Q11 | **(a)** Dedicated Asset detail page |
| Q12 | **(a)** Any active user of the organization; smarter suggestions (e.g. people with sanitization features first) may come later, never as a domain rule |

## Changelog

| Date | Change |
|---|---|
| 2026-10-11 | Skeleton with Fit-Gap and open questions |
| 2026-10-11 | Questions answered; full draft with three phases |
| 2026-10-11 | Design decisions confirmed by the user (`noBlockingExceptions` on `complete`; Resolve only for MISSING/UNEXPECTED; set-aside action; retry needs both manage features; backfill in the Phase 1 migration) |

# ITAD Operations Dashboard & Asset Search

**Date**: 2026-10-15
**Status**: Implemented — all three phases verified (2026-10-15)

> Spec 7 of the app-owned `itad` module (**Epic 7**). It follows `2026-10-02-itad-jobs.md`, `2026-10-05-itad-manifest-reconciliation.md`, `2026-10-09-itad-asset-sanitization.md`, `2026-10-11-itad-exceptions.md`, `2026-10-12-itad-pickup-calendar.md` and `2026-10-14-itad-certificates.md`.
>
> Source: "Epic 7 — Operations Dashboard & Asset Search" domain brief (2026-10-15), requirements REQ-701 … REQ-719 and acceptance scenarios AC-701 … AC-706, plus the product direction and answers given the same day. Module rules: `src/modules/itad/AGENTS.md`.

## TLDR

**Business outcome:** operations can immediately see which active jobs need attention and why, understand what blocks a job, and find any asset by serial number or customer asset tag.

Two personas, two workflows, one epic:

1. **Operations Manager, triage.** "It is morning; which of my 15–30 active jobs need me today, and why?"
   - The **Operations Dashboard** (`/backend/itad`) is the landing page of ITAD.
   - Active jobs are grouped and sorted by need for action: **Needs attention** (red, then orange), **In progress**, **Upcoming**, **Drafts**.
   - Each row shows receiving progress, sanitization progress and a **Needs attention** column. Severity comes from the *kind* of problem, never from the bare existence of an exception.
   - **Counters state facts; attention states problems.** Missing and Unexpected stay true reconciliation numbers even after an exception about them is resolved. The job stops needing attention once the problem is resolved.
   - Closeout blockers count too: missing certificates make a job orange.
   - A click on a job opens its **Job Overview**: a summary panel on top of the job's Overview tab. A click on a problem opens the tab where it is solved.
2. **Operator or support, lookup.** "What is happening to laptop ABC123?"
   - **Global asset search** by serial number or customer asset tag, from any screen (the platform's header search) and on the "ITAD Assets" page.
   - The header search shows every match with serial, tag, model, customer and job, plus "Open asset". The "ITAD Assets" page shows the same plus the **live** current status. Wherever a status is shown, it is live.

**Principle (REQ-701, REQ-719):** the dashboard owns no state. Every number is computed at read time from job, manifest, assets, scans, exceptions and certificates. There are no stored counters and no "recalculate" step.

## Decisions (answers 2026-10-15)

| # | Question | Decision |
|---|---|---|
| Q1 | Where the dashboard lives | (a) A new page `/backend/itad`, the first ITAD menu entry and the module's landing page. "ITAD Jobs" stays the full register and archive (all statuses, editing). |
| Q2 | Which jobs are "active" | (a) Every non-terminal status: `draft`, `scheduled`, `in_transit`, `receiving`, `processing`, `closeout_review`, `on_hold`. They are shown in **groups**, so a scheduled job never competes visually with a job that has 17 failed devices. |
| Q3 | "Received" | (a) One meaning everywhere. **Received = expected devices received and matched to the manifest**, so Expected = Received + Missing. Unexpected is separate. The count of every physically received device is named **Total intake**, never "Received". |
| Q4 | Needs attention | (b) Severity comes from the **kind** of problem, not from open exceptions (missing and unexpected become exceptions themselves, so an "exceptions = red" rule would contradict "missing = orange"). See "Attention model". Open exceptions stay a visible number with a link. |
| Q5 | Job Overview | (a) A summary panel at the top of the existing job page "Overview" tab. There is no separate dashboard tab. |
| Q6 | Global asset search | (b) The "ITAD Assets" page gains tag search and full context, the dashboard gets a search box, and ITAD assets are registered in the platform's global search, so lookup works from every screen. |
| D7 | Missing during receiving | **Confirmed.** While the job is `receiving` (or on hold from it), Missing is **receiving progress**, not attention: halfway through scanning, 400 of 500 devices are "missing" by definition. From `processing` on, attention comes from **open** MISSING_FROM_DELIVERY exceptions (see D9). |
| D8 | Missing certificates | **Confirmed.** Missing certificates are attention only in `closeout_review` (or on hold from it), where they block `complete`. In `processing` a sanitized device without a certificate yet is normal work, and the number is shown without a colour. |
| D9 | Resolved missing / unexpected | **Decided (review 2026-10-15).** A missing device resolved as `not_shipped`, `lost_in_transit` or `manifest_error`, or an unexpected device `accepted_into_job` (Epic 4), stays in the Missing / Unexpected counter, because reconciliation is a physical fact. It no longer needs action, so attention after receiving comes from **open** exceptions of those types, not from the raw counters. |

## Problem Statement

- Each job already shows its numbers, but spread over the Manifest, Receiving, Sanitization, Exceptions and Documents tabs. A manager with 20 active jobs has to open each one to know which needs attention.
- The jobs list shows Expected, Received, sanitization pending and open exceptions. It has no failed sanitization, no missing/unexpected split and no closeout blockers. It cannot be sorted or filtered by need for action.
- Its "Received" counts unexpected devices too, so "Received" means something different there than in reconciliation.
- The asset lookup finds a device only by serial prefix, inside ITAD, without customer asset tag, model or job name. A customer calling about "FIN-004829" cannot be helped.

## Facts from the current code

- **Jobs list** (`GET /api/itad/jobs`) adds, per job of the page, with grouped queries:
  - `expectedAssetCount` (active manifest items);
  - `receivedAssetCount` (**all** active assets, `countActiveAssets`);
  - `sanitizationPendingCount`;
  - `openExceptionCount`.
- **Reconciliation** (`services/reconciliation-reader.ts`, `domain/reconciliation.ts`), for one job:
  - `matched` = active manifest items with an active asset;
  - missing and unexpected;
  - `pendingDuplicates`, `differentDeviceUnresolved` (unresolved duplicate scans), `dataBearingUndecided`.
- **Asset statuses** (`domain/job-types.ts`): `received`, `sanitization_required`, `sanitization_in_progress`, `sanitized`, `review_required` (after a FAIL until a retry or a decision), and later ones.
- **Certificates** (`services/certificate-reader.ts`): `loadCertificateRequirement` gives required, issued and missing for one job.
- **Panels with filters:** the Manifest tab filters items by reconciliation (`missing`); the Receiving tab filters assets by reconciliation (`unexpected`). Neither reads its filter from the URL yet.
- **Asset lookup** (`GET /api/itad/assets`, `itad.assets.view`, page "ITAD Assets"):
  - normalized serial, exact or prefix match, at least 3 characters;
  - across the caller's readable organizations;
  - returns serial, status, received at, job reference, job status and customer name;
  - no tag, no manufacturer/model, no job name.
- **Platform search** (installed `search` module):
  - a module declares `search.ts` exporting `searchConfig: SearchModuleConfig` (`@open-mercato/shared/modules/search`);
  - each `SearchEntityConfig` has `entityId`, `buildSource`, `formatResult`, `resolveUrl`, `resolveLinks`, `fieldPolicy` and `aclFeatures`;
  - records are indexed through the `search.index_record` event, and `search reindex` backfills;
  - results are filtered by tenant and organizations by the search service.
- **Scope:** every ITAD route resolves the tenant and readable organizations (`resolveItadRouteContext`). Out-of-scope rows are never returned.

## Domain vocabulary and counters (pure `domain/job-overview.ts`)

All counters cover **active** rows only (not soft-deleted) and are computed at read time.

| Counter | Definition | REQ |
|---|---|---|
| Expected | active manifest items of the job | REQ-703 |
| Received | active manifest items with a matched active asset | REQ-704 |
| Missing | active manifest items without a matched active asset = Expected − Received | REQ-705 |
| Unexpected | active assets without an active manifest item | REQ-706 |
| Total intake | all active assets = Received + Unexpected (named explicitly; never called "Received") | REQ-720 |
| Awaiting wipe | active data-bearing assets in `sanitization_required` or `sanitization_in_progress` | REQ-707 |
| Sanitized | active data-bearing assets in `sanitized` (devices, not PASS runs) | REQ-708 |
| Failed | active assets in `review_required` (a FAIL not yet resolved; a retry that passed leaves this state) | REQ-709 |
| Sanitization scope | Awaiting wipe + Sanitized + Failed (the denominator of "Sanitized 391 / 491") | — |
| Data-bearing unknown | active assets with `dataBearing` not decided | — |
| Unresolved duplicates | duplicate scans not resolved, including ones flagged as a different device | — |
| Open exceptions | exceptions of the job with status `open` (cross-cutting: overlaps the counters above) | REQ-710 |
| Open missing / unexpected exceptions | open exceptions of type `missing_from_delivery` / `unexpected_asset`; they drive attention after receiving (D9) | — |
| Certificates required / issued / missing | as in the certificates spec ("Required certificates") | — |

The tiles **must not be summed**: Open exceptions overlaps Missing, Unexpected, Failed and Unresolved duplicates.

### Attention model (Q4, D7, D8)

| Severity | Signal | Links to |
|---|---|---|
| **red**: action required | Failed > 0 | Sanitization tab, filter "Needs review" |
| **red** | Unresolved duplicates > 0 | Exceptions tab, type duplicate |
| **orange**: discrepancy, missing information or closeout work | `receiving`: Unexpected > 0 | Receiving tab, filter unexpected |
| **orange** | `processing`, `closeout_review`: open missing exceptions > 0 (D7, D9) | Exceptions tab, open, type missing |
| **orange** | `processing`, `closeout_review`: open unexpected exceptions > 0 (D9) | Exceptions tab, open, type unexpected |
| **orange** | Data-bearing unknown > 0 | Receiving tab, filter "data-bearing unknown" |
| **orange** | Certificates missing > 0, in `closeout_review` (D8) | Documents tab |
| progress, no colour | Awaiting wipe > 0; Missing while `receiving`; certificates missing while `processing`; Missing / Unexpected after their exceptions are resolved | the matching tab |
| none | none of the above | — |

- A job's **severity** is the highest of its signals (red > orange > none).
- **Open exceptions** never set a colour. They are always shown as a number linking to the Exceptions tab.
- A job **on hold** is evaluated against its pre-hold status and always carries a visible "On hold" badge.
- `draft`, `scheduled` and `in_transit` have no intake yet, so they carry no reconciliation signal.
- **Data-bearing unknown** stays orange in every status for now, because it blocks the end of receiving. Treating it as "work remaining" during receiving, like D7, was considered and left open; it does not affect Phase 1.

### Groups and order (Q2, REQ-721)

| Order | Group | Jobs |
|---|---|---|
| 1 | Needs attention, red | severity red, any non-terminal status |
| 2 | Needs attention, orange | severity orange |
| 3 | In progress | `in_transit`, `receiving`, `processing`, `closeout_review` without attention |
| 4 | Upcoming | `scheduled` without attention |
| 5 | Drafts | `draft` |

- On hold jobs go to the group of their pre-hold status.
- Within a group the order is scheduled pickup date ascending (the job running longest, or picked up soonest, first), then job reference.
- The order is a pure function (`domain/job-overview.ts`), unit-tested.

## Proposed Solution

### Read model, not a copy (REQ-701, REQ-718, REQ-719)

- `services/job-overview-reader.ts` computes the counters for a **set** of jobs:
  - one grouped query per source (manifest items, assets by status, scans, exceptions, certificates), keyed by `job_id`;
  - always filtered by tenant and organization, and by `deleted_at is null`.
- The same function serves one job (the Job Overview) and all active jobs (the dashboard), so both always agree.
- The reconciliation reader's `matched` definition is reused, not re-implemented.
- Nothing is stored. Any change (scan, run result, exception resolution, reclassification, asset removal or restoration, certificate issue) shows on the next read.

### Operations Dashboard (`/backend/itad`, Q1, Q2)

- **Data:** `GET /api/itad/operations` returns every active job in the caller's scope with counters, severity, signals and group. The filters run server-side on the computed values.
- **Bounded set:** active jobs only, at most 500. When there are more, the response says so and the page asks to narrow the filters. Expected active volume is tens.
- **Layout:**

```
Operations                                    [ Search assets: serial or tag ___ ]
Filters: Customer ▾  Status ▾  [ ] Open exceptions  [ ] Missing  [ ] Failed  [ ] Missing certificates

NEEDS ATTENTION (2)
  Job                          Status        Receiving      Sanitization   Needs attention                        Exceptions
  ACME Bank · ITAD-2026-00042  Processing    497 / 500 +2   391 / 491      ● 17 failed  ● 3 missing  ● 2 unexpected   11
  Laptop refresh Q3
  Contoso · ITAD-2026-00044    Closeout      145 / 145      145 / 145      ● 2 certificates missing                    0

IN PROGRESS (1)
  Nordea · ITAD-2026-00043     Receiving     180 / 220      —              40 not yet received                         0

UPCOMING (1)
  Beta · ITAD-2026-00050       Scheduled     pickup 16.10                                                               —

DRAFTS (1)
  Gamma · ITAD-2026-00051      Draft         —
```

- **Columns:**
  - customer, reference and name, linking to the job;
  - status badge, plus "On hold" when applicable;
  - scheduled pickup;
  - Receiving "Received / Expected", with "+N unexpected" when there are unexpected devices;
  - Sanitization "Sanitized / scope", with awaiting wipe in muted text;
  - Needs attention: severity-coloured `StatusBadge` chips, each a link (see "Attention model");
  - open exceptions, linking to the Exceptions tab.
- **Groups:** each group is a section with a count and a `DataTable` of the same columns. An empty group shows one muted line. Groups 1–2 share one "Needs attention" section, red rows first.

### Job Overview (Q5)

A summary panel at the top of the job page "Overview" tab, served by `GET /api/itad/jobs/{id}/overview`:

| Block | Numbers |
|---|---|
| Receiving | Expected, Received, Missing, Unexpected, Total intake |
| Sanitization | Awaiting wipe, Sanitized, Failed, Data-bearing unknown |
| Issues | Open exceptions, Unresolved duplicates |
| Closeout | Certificates required, issued, missing |

- Each number links to the tab and filter where it is resolved.
- The attention signals are repeated as chips at the top of the panel.
- To make the links land on the right list, the Manifest, Receiving and Sanitization panels read an initial filter from the URL, e.g. `?tab=manifest&reconciliation=missing`. This is a small additive change.

### Asset search (Q6)

**One search contract** (REQ-713 … REQ-717), extending `GET /api/itad/assets`:
- `q` matches the **normalized serial** or the **normalized customer asset tag** (trimmed, case-insensitive), exact or prefix, at least 3 characters.
- `serial` stays as an alias of `q`, for compatibility.
- Exact matches come first, then prefix matches, then the newest received.
- Each item adds `customerAssetTag`, `manufacturer`, `model`, `jobName` and `matchedOn` (`serial` / `customerAssetTag`). The existing fields stay.
- **Every** match in scope is returned, paginated; none is chosen arbitrarily (REQ-716).
- Status, customer and job are read live.

**"ITAD Assets" page:**
- one input "Serial number or customer asset tag";
- a result list with serial, tag, manufacturer/model, customer, job reference and name, a current status badge and "Open asset";
- an explicit empty state: **No asset found for "ABC123"** (brief §19); no result is not an error;
- the query lives in the URL (`?q=`), so the dashboard search box and the global search link here.

**Global search (header, any screen):**
- `src/modules/itad/search.ts` registers entity `itad:itad_asset`:
  - **strategy**: `tokens` only (Postgres; always available). The tokenized fields are serial, normalized serial, customer asset tag, manufacturer, model and job reference. **Status is never tokenized.**
  - **`formatResult`**: title = serial; subtitle = "tag · manufacturer model · customer · job reference"; icon `package`. It runs **at search time**, reading the job and the customer live, so names are never stale.
  - **`resolveUrl`**: the asset detail page.
  - **`resolveLinks`**: "Open asset", plus "All matches for this serial" pointing to `/backend/itad/assets?q=<serial>`.
  - **`fieldPolicy`**: everything searchable; no sensitive data.
  - **`aclFeatures`**: `['itad.assets.view']`.
- **Status is not in the index at all** (neither presenter nor fields). It changes often, and an indexed status would be stale data even when not displayed. The status is shown only where it is read live: the asset page and the ITAD Assets results.
- **Indexing** (verified in Phase 3, step 1: the token strategy and the search-time presenter read the `query_index` projection, `entity_indexes` + `search_tokens`):
  - ITAD subscribers on the asset events that change an asset — received, updated, deleted, data-bearing changed, sanitization required, run started / passed / failed / aborted, retry approved — call `services/asset-search-index.ts` after commit;
  - it emits `query_index.upsert_one` with a `searchTokenDoc` limited to the identifiers above, so the projection stays current and no status is tokenized; a removed asset emits `query_index.delete_one`;
  - no company-rename subscriber is needed, because the presenter reads the customer name at search time;
  - existing assets are backfilled with `yarn mercato itad search-reindex-assets --tenant <id> [--org <id>]`, which uses the same identifiers-only token document (a generic `query_index` reindex would tokenize the whole row, status included).
- **Scope:** the search service filters by tenant and the caller's organizations, and `aclFeatures` requires `itad.assets.view`. An asset outside the caller's scope is never found (REQ-717).

## Users, permissions and scope

| Surface | Feature | Notes |
|---|---|---|
| Operations Dashboard, `GET /api/itad/operations` | `itad.jobs.view` | Aggregated counts follow the jobs-list precedent (derived counters need only `itad.jobs.view`). Chips link to tabs that enforce their own features. |
| Job Overview, `GET /api/itad/jobs/{id}/overview` | `itad.jobs.view` | Same precedent. |
| ITAD Assets search, `GET /api/itad/assets` | `itad.assets.view` | Unchanged feature. |
| Global search results for `itad:itad_asset` | `itad.assets.view` via `aclFeatures` | Scope enforced by the search service. |

There are no new features and no new default grants. Employees already have `itad.jobs.view` and `itad.assets.view`.

## API contracts

Every route has `metadata` and `openApi`, is scoped to the tenant and readable organizations, and returns 404 for a job outside the caller's scope.

| Method & path | Purpose |
|---|---|
| `GET /api/itad/operations` | Active jobs with counters, severity, signals and group. Query: `customerId`, `status` (repeatable), `openExceptions`, `missing`, `failed`, `missingCertificates` (each `true` to require). Response: `{ items: OperationsJob[], truncated: boolean }`. |
| `GET /api/itad/jobs/{id}/overview` | `{ counters, severity, signals, group }` for one job. |
| `GET /api/itad/assets` (changed, additive) | `q` (serial or tag) with `serial` kept as an alias; items add `customerAssetTag`, `manufacturer`, `model`, `jobName`, `matchedOn`. |
| `GET /api/itad/jobs` (changed, additive) | Adds `matchedAssetCount` (Received) and `unexpectedAssetCount`. `receivedAssetCount` keeps its old meaning (Total intake) and is marked deprecated in `openApi`; the jobs list UI switches to the new fields (Q3). |

`OperationsJob` = `{ id, internalReference, name, status, statusBeforeHold, customer: { id, name }, scheduledPickupAt, counters, severity: 'red' | 'orange' | 'none', signals: [{ key, severity, count, href }], group }`.

`counters` = `{ expected, received, missing, unexpected, totalIntake, awaitingWipe, sanitized, failed, sanitizationScope, dataBearingUnknown, unresolvedDuplicates, openExceptions, certificatesRequired, certificatesIssued, certificatesMissing }`.

Errors: 400 for an invalid filter or a search shorter than 3 characters (the existing `serial_too_short` code is kept for compatibility); 404 outside scope. No search result is not an error: 200 with an empty list.

## UI and interaction contracts

- **Shell:** standard backend pages (`page.meta.ts`, `requireFeatures`), `DataTable`, `StatusBadge` with semantic variants (`error` for red, `warning` for orange; never hard-coded colours), `SectionHeader`, shared API helpers (`readApiResultOrThrow`). Closest reference pages: the ITAD Jobs list (`components/JobsTable.tsx`) and the job Exceptions tab (`components/JobExceptionsPanel.tsx`).
- **Navigation:** "Operations" becomes the first ITAD menu entry (`pageOrder` before "ITAD Jobs" and "ITAD Assets"). It is the landing page of the group.
- **States:**
  - loading: skeleton or spinner per section;
  - empty: "No active jobs" overall, and "Nothing here" per group;
  - error: an alert with retry;
  - truncated: "Showing the first 500 active jobs; narrow the filters".
- **Search box:** submitting navigates to `/backend/itad/assets?q=`.
- **Keyboard and a11y:**
  - chips are links with an accessible name ("17 failed sanitizations, open sanitization review");
  - group sections are landmarks with headings;
  - the severity colour is never the only cue: every chip shows its text.
- **Responsive and themes:** at narrow width the columns collapse to job, status and attention (DataTable column hiding). Light and dark via tokens only.
- **Strings:** all five locales.

## Requirements

REQ-701 … REQ-719 come from the brief; REQ-720 … REQ-722 are added by this spec.

| ID | Requirement |
|---|---|
| REQ-701 | The Operations Dashboard shows the current operational state of jobs from workflow source data. |
| REQ-702 | Each job shows at least Expected, Received, Missing, Unexpected, Awaiting wipe, Sanitized, Failed and Open exceptions. |
| REQ-703 | Expected is the number of active items of the job's manifest. |
| REQ-704 | Received is the number of expected devices received and matched to the manifest; unexpected assets do not increase it. |
| REQ-705 | Missing is the number of active manifest items without a matched active asset. |
| REQ-706 | Unexpected is the number of active assets without a matching active manifest item. |
| REQ-707 | Awaiting wipe covers data-bearing assets that require or are in sanitization. |
| REQ-708 | Sanitized counts active assets currently `sanitized`, not historical PASS runs. |
| REQ-709 | Failed shows devices that currently need review after a failed sanitization; a resolved FAIL is not counted. |
| REQ-710 | Open exceptions is the number of currently open exceptions of the job. |
| REQ-711 | The dashboard clearly marks jobs with missing or unexpected devices, failed sanitization, unresolved duplicates or missing certificates (attention model). |
| REQ-712 | Jobs can be filtered at least by customer, job status, and presence of open exceptions, missing assets and failed sanitization. |
| REQ-713 | Assets can be searched by serial number across the caller's scope. |
| REQ-714 | Assets can be searched by customer asset tag. |
| REQ-715 | A search result shows the asset with customer and job, and opens the asset detail. Wherever a status is shown (the ITAD Assets page, the asset detail), it is the live current status. |
| REQ-716 | Every matching asset is shown; none is chosen arbitrarily. |
| REQ-717 | Dashboard and search respect tenant and organization scope; out-of-scope records are not revealed. |
| REQ-718 | The dashboard shows the current state; resolved problems stop affecting the counters but stay in the domain history. |
| REQ-719 | Dashboard metrics are computed from source data instead of independently maintained counters. |
| REQ-720 | "Received" has one meaning in every screen (matched); all physically received devices are shown as "Total intake". |
| REQ-721 | Active jobs are grouped (Needs attention, In progress, Upcoming, Drafts) and sorted by need for action. |
| REQ-722 | Asset search is reachable from any screen through the platform's global search. |

## Acceptance criteria

The brief's AC-701 … AC-706 apply unchanged (quick overview, sanitization status after retry, exception resolved, find by serial, find by tag, duplicate identifiers). Added:

- **AC-707.** A job with 0 missing, 0 failed, 0 exceptions but 12 missing certificates in `closeout_review` is orange in Needs attention.
- **AC-708.** A job in `processing` with one **unresolved** missing exception is orange, not red, although it is also counted in Open exceptions.
- **AC-710.** After that missing exception is resolved as `lost_in_transit`, and an unexpected device is `accepted_into_job`, Missing and Unexpected keep their reconciliation counts, but the job no longer needs attention.
- **AC-709.** A job in `receiving` with 180 of 220 scanned shows "40 not yet received" without a colour and sits in In progress.

## Edge Cases & Failure Scenarios

- **Job with no manifest** (receiving started without one is not possible, but draft/scheduled have none). Expected 0; the receiving column shows "—".
- **Asset removed in receiving.** It disappears from every counter (active rows only); restoring it brings it back.
- **Reclassified to non-data-bearing.** It leaves Awaiting wipe, Sanitized and Failed (they count data-bearing assets only, Failed by status).
- **Same serial or tag in several jobs or customers.** Every match is listed with its customer and job (AC-706).
- **Serial in a job outside the caller's organizations.** Not found (REQ-717); the empty state says "No asset found".
- **More than 500 active jobs.** `truncated: true` and a message; filters narrow the set.
- **Search index behind** (worker delay, failed index event). The header search may briefly miss a new asset. The "ITAD Assets" page queries the database and always finds it; the header search's "All matches" link leads there.
- **Company renamed.** The global search subtitle is computed at search time, so it shows the new name immediately.

## Risks & Impact Review

- **Contract changes, all additive:**
  - two new endpoints;
  - new optional fields on `GET /api/itad/jobs` and `GET /api/itad/assets`;
  - `q` on the asset lookup;
  - a new `search.ts` (a new discovery file of this module, not a change to the convention).
- **Deprecated, not removed:** `receivedAssetCount` keeps its old meaning, so no client breaks (Q3 is met in the UI).
- **Query cost:** grouped queries over active jobs only (tens to hundreds). Indexes on `(tenant, org, job_id, status)` already exist on assets, exceptions and certificates. The 500 cap bounds the worst case.
- **Search dependency:** the global search entry relies on the installed `search` module and its worker. If indexing lags, the ITAD Assets page is the always-correct fallback.
- **Rollback:**
  - remove `search.ts` and the asset search subscribers; `query_index` purge for `itad:itad_asset` clears the projection;
  - hide the Operations page;
  - the jobs list can switch back to `receivedAssetCount`.

  No ITAD workflow state and no dashboard counters are written by this epic. The global search index is derived data and can be rebuilt (`search reindex`). No migration and no recalculation are needed.

## Phasing

1. **Phase 1 — Read model and Job Overview:** counters and attention model, overview endpoint, summary panel, URL filters on the job panels, jobs list "Received" alignment.
2. **Phase 2 — Operations Dashboard:** operations endpoint with filters, groups and order; the `/backend/itad` page; navigation.
3. **Phase 3 — Asset search:** `q` by serial or tag with full context, the ITAD Assets page, the dashboard search box, global search registration, indexing and backfill.

Each phase leaves the app working and is independently useful.

## Implementation Plan

**Phase 1:**
1. `domain/job-overview.ts`: the counter type, signals, severity (with D7, D8 and D9), groups and order. Unit tests cover AC-707 … AC-710, on hold evaluated as pre-hold, and the order of groups and ties.
2. `services/job-overview-reader.ts`: grouped queries for a set of job ids, reusing the reconciliation `matched` definition and `loadCertificateRequirement` semantics.
3. `GET /api/itad/jobs/{id}/overview` with `metadata` and `openApi`.
4. Summary panel on the job Overview tab, with links. The Manifest, Receiving and Sanitization panels read their initial filter from the URL.
5. `GET /api/itad/jobs` adds `matchedAssetCount` and `unexpectedAssetCount`. The jobs list shows Received (matched) and Unexpected, and marks `receivedAssetCount` deprecated in `openApi`.
6. Integration tests:
   - **TC-ITAD-601:** reconciliation counters on a job with 10 expected, 9 matched, 1 unexpected. Expected = Received + Missing; Total intake = 10 (AC-701, REQ-720).
   - **TC-ITAD-602:** sanitization counters. FAIL → Failed 1; retry PASS → Sanitized +1, Failed 0. Resolving a duplicate lowers Open exceptions; its history stays (AC-702, AC-703, REQ-718).
   - **TC-ITAD-609:** in `processing`, an open missing exception and an open unexpected exception make the overview orange. After resolving them (`lost_in_transit`, `accepted_into_job`), Missing and Unexpected keep their counts and the attention is gone (AC-708, AC-710, D9).

**Phase 2:**
1. `GET /api/itad/operations`: active jobs in scope, counters via the reader, filters, severity, groups, order, the 500 cap.
2. Page `/backend/itad` (`page.meta.ts`, first ITAD entry): grouped sections with `DataTable`, filters, chips with links, all states, five locales.
3. Integration tests:
   - **TC-ITAD-603:** groups and order with a red, an orange, an in-progress, a scheduled and a draft job. A job with only missing certificates in closeout is orange (AC-707); one unresolved missing exception in processing is orange, not red (AC-708); receiving 180/220 is In progress (AC-709).
   - **TC-ITAD-604:** filters (customer, status, open exceptions, missing, failed, missing certificates, combined) and scope (a job in another organization never appears).
   - **TC-ITAD-605 (UI):** the dashboard renders the groups, a chip opens the right tab with its filter, the search box leads to the asset page.

**Phase 3:**
1. Verify (bounded `om-framework-context`):
   - how the installed `search` module removes or hides a record;
   - the arguments of `search reindex` for one entity;
   - the `customers` company update event id.
2. `GET /api/itad/assets`: `q` over the normalized serial and tag, `serial` as an alias, the new context fields, every match, order.
3. "ITAD Assets" page: one input, context list, live status, "No asset found for …", `?q=` in the URL.
4. `search.ts` for `itad:itad_asset`, index events after asset create, edit and restore, removal handling, the company-rename subscriber, and backfill instructions.
5. Integration tests:
   - **TC-ITAD-606:** search by serial and by tag returns the asset with customer, job, model and live status (AC-704, AC-705). The same tag in two jobs returns both (AC-706). An unknown value returns an empty list with 200. An asset in another organization is not found (REQ-717).
   - **TC-ITAD-607:** global search finds a newly scanned asset by serial and tag, its link opens the asset detail, and a removed asset is no longer found (REQ-722).
   - **TC-ITAD-608 (UI):** header search → result → asset detail; the ITAD Assets page shows the empty state.

Validation per phase:
- `yarn generate && yarn typecheck && yarn lint && yarn ds:check && yarn test`;
- the phase's TC-ITAD tests and the full TC-ITAD regression on the ephemeral environment.

## Requirement traceability

| REQ | Phase | Test |
|---|---|---|
| REQ-701, REQ-719 | 1–2 | TC-ITAD-601, 602, 603 |
| REQ-702 … REQ-706, REQ-720 | 1 | TC-ITAD-601 |
| REQ-707 … REQ-710, REQ-718 | 1 | TC-ITAD-602, 609 |
| REQ-711, REQ-721 | 1–2 | TC-ITAD-603, 605, 609; domain unit tests |
| REQ-712 | 2 | TC-ITAD-604 |
| REQ-713 … REQ-716 | 3 | TC-ITAD-606, 608 |
| REQ-717 | 2–3 | TC-ITAD-604, 606 |
| REQ-722 | 3 | TC-ITAD-607, 608 |

## Changelog

- **2026-10-15:** skeleton with Q1–Q6.
- **2026-10-15:** answers applied:
  - Q1(a) landing page `/backend/itad`;
  - Q2(a) every non-terminal job, in groups;
  - Q3(a) one meaning of Received, plus Total intake;
  - Q4(b) severity from the kind of problem;
  - Q5(a) panel on the Overview tab;
  - Q6(b) global search.

  Added the attention model, groups and order (REQ-721), D7 and D8 (to confirm), AC-707 … AC-709, and the full design and plan.
- **2026-10-15, review applied; status Ready for implementation:**
  - D7 and D8 confirmed;
  - D9: after receiving, attention for missing and unexpected comes from open exceptions of those types, while the counters stay reconciliation facts (AC-708 reworded, AC-710 and TC-ITAD-609 added);
  - status removed from the search index entirely; REQ-715 says a status is shown only where it is live;
  - the rollback note distinguishes workflow data (never written) from the rebuildable search index;
  - data-bearing unknown stays orange; its receiving-stage treatment is left open (non-blocking).
- **2026-10-15, phase 1 implemented:**
  - the overview panel sits in the job form's `contentHeader` slot, between the page title and the form fields;
  - the Exceptions tab also reads `status` and `type` from the URL, so signal links can open it filtered;
  - `matchedAssetCount` uses a dedicated grouped query (`countMatchedManifestItems`) with the reconciliation matching rule;
  - the Receiving tab counter formerly labelled "Received" is now "Total intake"; the job summary shows Received (matched) and Unexpected.
- **2026-10-15, phase 2 implemented:**
  - `GET /api/itad/operations` also returns `customers` (every customer of the active jobs, before filters) to feed the customer filter;
  - each non-empty group renders as a `DataTable` whose title carries the group name and count; an empty group shows its heading and "Nothing here.";
  - the dashboard search box navigates to `/backend/itad/assets?q=`; the ITAD Assets page reads `q` in phase 3;
  - the "certificates missing" chip reads "Missing certificates: N".
- **2026-10-15, phase 3 implemented:**
  - step 1 verified the platform search: the token strategy and the presenter read the `query_index` projection, so assets are projected with `query_index.upsert_one` / `delete_one` from asset-event subscribers, with an identifiers-only `searchTokenDoc`; the presenter runs at search time, which makes a company-rename subscriber unnecessary; the global search uses the `tokens` strategy only;
  - backfill is an ITAD CLI command, `itad search-reindex-assets`, instead of the generic reindex (which would tokenize the status);
  - the asset lookup keeps its `serial_too_short` error code; `serial` stays an alias of `q`;
  - the ITAD Assets page puts its search in the table toolbar, so it keeps its own states: a hint below 3 characters and "No asset found for …".

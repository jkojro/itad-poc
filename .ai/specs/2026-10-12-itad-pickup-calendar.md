# ITAD Pickup in the Calendar

**Date**: 2026-10-12
**Status**: In progress — Phases 1–2 implemented and verified (2026-10-12)

> Spec 5 of the app-owned `itad` module (Epic 5), after `2026-10-02-itad-jobs.md` … `2026-10-11-itad-exceptions.md`. Source: user request "Włączyć moduł kalendarza i umieszczać w nim taska dotyczącego odbioru urządzeń z etapu joba." Module rules: `src/modules/itad/AGENTS.md`.

## TLDR

A scheduled ITAD job gets one **current pickup task** in the platform calendar (`/backend/calendar`).
- The task is a `customers` interaction of a new type `itad-pickup`.
- It sits on the job's customer company, at `scheduledPickupAt`, lasts 60 minutes, and its owner is the job's new **pickup coordinator**.

**The job is the source of truth.** After every job change `itad` compares the **actual** task with what the job requires and corrects it:
- a date, coordinator, name or customer-reference change updates the task;
- `dispatch` completes it;
- `unschedule`, `hold` and `cancel` cancel it;
- going back to `scheduled` creates a new task. Earlier tasks stay as history.

**Protection:**
- Editing, completing, cancelling or deleting any pickup task (current or historical), and using the `itad-pickup` type, is rejected by an `itad` **command interceptor** on the `customers.interactions.*` commands. This covers every route, page, AI tool and module. Only the ITAD sync, identified by its own trusted marker, may change a task, and nobody may delete one.
- Changes made around the API, such as a direct command, are reverted by the next sync.

**Failures and existing jobs:**
- A failed sync shows on the job page with a **Retry calendar sync** action.
- Existing scheduled and in-transit jobs get tasks through a one-off CLI command.

No module needs enabling. The calendar is part of the already-enabled `customers` module. Nothing installed is edited.

## Terms

- **Job**: the ITAD job (`ItadJob`, e.g. ITAD-2026-00010), owned by `itad`.
- **Pickup task**: a calendar entry for one pickup occurrence of a job. It is a `customers` interaction (`customers:customer_interaction`) of type `itad-pickup` on the job's customer company, owned by `customers`.
- **Pickup task link**: an `itad` row for **one** pickup task: which job it belongs to, which interaction it is, and what state `itad` gave it.
  - A job has zero or more links.
  - At most one link is **current**: the latest pickup occurrence of the job, whatever its state. Older links are history.
- **Pickup coordinator**: the organization user responsible for the pickup. Stored on the job; becomes the task's `ownerUserId`.

## Decisions (answers 2026-10-12)

| # | Question | Decision |
|---|---|---|
| Q1 | When does the task appear? | (a) on transition to `scheduled` |
| Q2 | Interaction type | (b) new `itad-pickup` value in the `activity-types` dictionary, with its own label, colour and icon |
| Q3 | Task owner | (c) new optional job field "pickup coordinator" |
| Q4 | Lifecycle sync | (a) full sync |
| Q5 | Edits made in the calendar | (c) one-way; edits are blocked. Originally an API interceptor; since TODO-501 an `itad` command interceptor on the `customers.interactions.*` commands |
| Q6 | Time format | (a) timed event at `scheduledPickupAt`, 60 minutes |
| Q7 | Existing jobs | (a) one-off backfill CLI |
| Q8 | Link back to the job | (a) job reference and URL in the task body, plus a "Pickup task" section on the job page |

**Review changes (2026-10-12):**
1. One link row per pickup task, not per job, so historical tasks stay protected.
2. The sync reads the actual interaction and compares it with the desired state, so changes made around the API are detected and corrected.
3. Commands run in a system command context, not as the user who clicked.
4. The task body no longer includes the expected device count; the body is part of the diff.
5. "Retry calendar sync" is added, replacing the promise of automatic retry.
6. No `itad` lock or transaction is held while a `customers` command runs.
7. The interceptor ships in the same phase as task creation.

**Second review (2026-10-12):**
- `is_current` means the latest occurrence, terminal included; `lost` is never current.
- Deleted jobs are loaded including soft-deleted rows.
- Terminal-status drift is reopened by `update`, with a fallback, and tested.

`dispatch` completing the task is confirmed by the jobs spec: `in_transit` means "equipment travelling to the ITAD facility", so the devices have already been picked up.

## Problem Statement

A job's pickup date lives only on the job. Dispatchers and drivers plan their week in the platform calendar, which already shows meetings, calls and CRM tasks. Pickups are missing from it, so they are planned in two places, and a moved or cancelled pickup is easy to miss.

## Feasibility (checked against installed `@open-mercato/core` 0.8.0)

- **Calendar page.** `customers/backend/calendar` needs feature `customers.interactions.view`, which the `employee` and `admin` roles have. It reads only `GET /api/customers/interactions`; no other module can add a data source. A pickup task therefore has to be an interaction.
- **Writes.** `itad` can write interactions through the public command bus: `customers.interactions.create` / `.update` / `.complete` / `.cancel`.
  - `create` accepts an optional `id`, plus `entityId` (company), `interactionType`, `title`, `body`, `scheduledAt`, `durationMinutes`, `ownerUserId` and `source`.
- **Permissions.** The command bus checks scope only (`ensureTenantScope` / `ensureOrganizationScope`), not features; features are checked on the HTTP routes. A system command context is a supported pattern: `auth: null`, `organizationScope: null`, `selectedOrganizationId`, `organizationIds`. The `warranty_claims` subscribers use it. With `auth: null` the interaction author is `null`, i.e. the system.
- **Interaction type.** A type is a value in the `customers` `activity-types` dictionary. The calendar takes the label, colour and icon from that dictionary.
  - The type-to-category map is hard-coded, so `itad-pickup` falls into "other".
  - The calendar tabs are All / Meetings / Events, and both `task` and "other" items show only under All, so this does not matter.
  - Dictionary entries are written with `customers.dictionaryEntries.create`.
- **Edit paths.** The calendar cannot drag an existing item; dragging creates a new event. An item can be changed in the event editor (`PUT`), cancelled (`PUT status=canceled`) or deleted (`DELETE`). The company activity timeline uses the same route.
  - The route is built with `makeCrudRoute`, which runs API interceptors (`ApiInterceptor.before` → `{ ok: false, statusCode, message }`).
  - The calendar shows a 409 as an optimistic-lock conflict bar, so a rejection must use **422**.
- **Calendar URL.** The calendar page reads no URL parameters, so a link can open the calendar but not a given day or item.

## Proposed Solution

**Ownership:**
- `itad` owns the rule: which job state needs which task state.
- `customers` owns the task records.
- Touchpoints:
  - the public command bus, for writing interactions and the dictionary entry;
  - a query-engine read of the interactions `itad` created, in `module-integrations/customers.ts`;
  - command interceptors on `customers.interactions.create` / `.update` / `.complete` / `.cancel` / `.delete` (TODO-501).
- No ORM relation and no edits to installed code.

**Sync** (`services/pickup-task-sync.ts`). It runs from a persistent post-commit subscriber on `itad.job.updated` (every job write and every transition emit it; the payload now also carries `actorUserId`) and `itad.job.deleted`, from the Retry action and from the CLI. It is a reconcile loop in short steps; no `itad` transaction is open while a `customers` command runs:

1. **Read.** Load the job and its current link in a short read. The job is loaded by id **including soft-deleted rows** (`deleted_at` is not filtered), so a deleted job yields desired `cancelled`. A job that does not exist at all is treated the same way when it has links.
2. **Read the actual task** if the current link has an interaction: date, owner, title, body, status, deleted. Uses the query engine.
3. **Decide.** The pure `domain/pickup-task.ts` compares `desiredPickupTask(job)` with the actual task and returns one step.
4. **Intent** (only for create). Write the new link in a short transaction with a pre-generated `interaction_id` and state `creating`. A partial unique index allows one current link per job, so a parallel sync loses here and stops.
5. **Command.** Run one `customers.interactions.*` command in the system context.
6. **Finalize.** In a short transaction, update the link state, `last_synced_at` and `last_error`. If the job's `updated_at` changed since step 1, run again, at most 3 rounds.

Duplicate and retried runs converge: create reuses the stored `interaction_id`, and a "row already exists" result counts as done. A failed sync never fails or rolls back the job action.

**Protection** (since TODO-501, 2026-10-14). The `itad` command interceptors (`src/modules/itad/commands/interceptors.ts`, ids `itad.pickup-task-guard.<command>`) run inside the command bus before the `customers` command. Whichever route, page, AI tool or module the call comes from, it passes through them.

The trusted marker (`lib/pickup-sync-scope.ts`) is one `AsyncLocalStorage` shared through `globalThis` (registry symbol `open-mercato.itad.pickup-sync-scope`). The app bundles API routes separately, so the module can load more than once per process; a module-local store left the sync and the guard on different stores and the guard rejected the sync's own create (`itad_pickup_type_reserved`, found 2026-10-26 in dev after scheduling a job).

| Command | User or any other caller | ITAD sync (trusted marker) |
|---|---|---|
| `create` with `interactionType: 'itad-pickup'` | blocked, `itad_pickup_type_reserved` | allowed |
| `update` / `complete` / `cancel` of a linked task (current or history) | blocked, `itad_pickup_task_locked` | allowed |
| `update` retyping another interaction to `itad-pickup` | blocked, `itad_pickup_type_reserved` | allowed (never used) |
| `delete` of a linked task | blocked, `itad_pickup_task_locked` | **blocked**: history stays |

- A linked task is checked before the reserved type. The calendar editor re-sends `interactionType: 'itad-pickup'` on every save, and the user must see the job message.
- **Trusted marker.** The command interceptor context carries no framework "trusted system" flag: `systemActor` is not passed to interceptors. Any in-process caller can build `auth: null`, so `auth === null` alone is not trusted. The sync runs its `customers` commands inside `runAsPickupSync(...)` (`lib/pickup-sync-scope.ts`, an `AsyncLocalStorage` scope, the same mechanism `@open-mercato/cache` uses for tenant context). The interceptor allows a change only when `isPickupSyncActive()`. Request input cannot set this marker.
- **Rejection.** `{ ok: false, status: 422, message, body: { error: <translated message>, code, reference? } }`. The CRUD factory and the hand-written `complete` / `cancel` routes map it to HTTP 422 with that body (`getCommandInterceptorHttpRejection`).

**Guarantee:**
- No caller except the ITAD sync can change or complete a pickup task, cancel it, or create an `itad-pickup` interaction through the command bus. This holds for every route and in-process caller.
- No caller at all can delete a linked pickup task.
- Only direct database writes bypass the guard; the next sync corrects them (REQ-507).

**Alternatives rejected:**
- A separate ITAD calendar page: duplicates the platform calendar.
- Ejecting the `customers` calendar to add a data source: loses upgrades.
- The `planner` module: it covers worktime and availability.
- A link column on `itad_jobs`: sync writes would change the job's `updated_at`, causing false 409s, and history would be lost.

## Architecture

```
job command (create / update / transition / delete)
  └─ commit ─▶ itad.job.* (post-commit)
                └─ subscribers/sync-pickup-task.ts ─┐
POST /api/itad/jobs/:id/pickup-task/sync (Retry) ───┼─▶ services/pickup-task-sync.ts
cli: itad sync-pickup-tasks ────────────────────────┘      ├─ domain/pickup-task.ts  (pure)
                                                           ├─ module-integrations/customers.ts
                                                           │    ├─ readPickupTask            (query engine)
                                                           │    ├─ create/update/complete/cancelPickupTask (command bus, system ctx)
                                                           │    └─ ensurePickupActivityType  (dictionary, idempotent)
                                                           └─ itad_job_pickup_tasks          (one row per task)

PUT/DELETE/POST /api/customers/interactions
  └─ commandBus → itad commands/interceptors.ts (customers.interactions.*) → link lookup → 422 itad_pickup_task_locked
```

**Desired state** (`desiredPickupTask(job)`):

| Job status | Desired |
|---|---|
| `scheduled` | `planned`: at `scheduledPickupAt`, 60 min, owner = coordinator, title and body from the job |
| `in_transit`, `receiving`, `processing`, `closeout_review`, `completed` | `completed` |
| `draft`, `on_hold`, `cancelled`, deleted | `cancelled` |

**Content:**
- title: "Odbiór urządzeń – ITAD-2026-00010 – <job name>";
- body: job reference, customer reference (if any), and the job URL `/backend/itad/jobs/<id>`;
- both written in one locale: `OM_ITAD_CALENDAR_LOCALE` when set to a supported locale, otherwise the app's default locale. There is no per-organization locale setting to read, and the sync runs in the events worker without a request.

The body holds only fields that can change while `scheduled` (name, customer reference), so the diff keeps it current. Nothing the manifest changes goes into the task.

**Step** (`planPickupTaskStep(desired, current)`, where `current` is the current link plus the actual interaction):

| Desired | Current | Step |
|---|---|---|
| `planned` | none, or the current link is terminal | **create**: new link (state `creating`, then `planned`); any previous link stays as history. Covers first schedule, `return_to_scheduled` and `resume`. |
| `planned` | `creating` (earlier create unconfirmed) | **create** with the stored `interaction_id` (idempotent) |
| `planned` | `planned`, actual task matches | nothing |
| `planned` | `planned`, actual date / owner / title / body / status differs | **update**. A cancelled or completed status is reopened through `update` with `status: planned` and `occurredAt: null`. Checked: `customers.interactions.update` sets `status` without a transition rule. If an update still fails on status, the fallback is: mark the link `lost`, then **create**. |
| `planned` | `planned`, actual task missing or deleted | mark the link `lost` (no longer current), then **create** |
| `completed` | `planned` | **complete** |
| `cancelled` | `planned` | **cancel** |
| `completed` / `cancelled` | `creating` | the task never appeared: mark the link `lost`; if it did appear: complete or cancel it |
| `completed` / `cancelled` | none / terminal | nothing; the sync never creates a terminal task |

The only exception to the last row: the backfill creates a completed task for jobs already `in_transit` (REQ-511).

**Command context:**
- `{ container, auth: null, organizationScope: null, selectedOrganizationId: job.organizationId, organizationIds: [job.organizationId] }`, plus `tenantId` and `organizationId` in the command input. This is the same pattern as the `warranty_claims` subscribers.
- The interaction author is the system.
- The user who caused the change is kept on the link as `caused_by_user_id`: the event's `actorUserId`, or the user who clicked Retry. It is never used for authorization.

## Data Model

New table **`itad_job_pickup_tasks`**, one row per pickup task ever created for a job:

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `tenant_id`, `organization_id` | uuid | scope |
| `job_id` | uuid | `itad_jobs` id (same module) |
| `interaction_id` | uuid | chosen by `itad` before create (`crypto.randomUUID()`); scalar id of a `customers` interaction, no FK; unique per (tenant, org) |
| `state` | text | `creating` / `planned` / `completed` / `cancelled` / `lost` |
| `is_current` | boolean | latest occurrence of the job; partial unique index (tenant, org, `job_id`) WHERE `is_current` |
| `scheduled_at` | timestamptz | the pickup time this task stands for |
| `caused_by_user_id` | uuid null | who triggered the last sync of this task (audit only) |
| `last_synced_at` | timestamptz null | |
| `last_error` | text null | error code of the last failed sync, cleared on success |
| `created_at`, `updated_at` | timestamptz | |

**Rules:**
- `is_current` marks the latest pickup occurrence of the job, not necessarily an active one. `creating`, `planned`, `completed` and `cancelled` links can be current.
- A terminal link stays current until a newer occurrence is created. The job page shows the last task's final state.
- `lost` links are never current.
- Creating a new occurrence clears `is_current` on the old link and inserts the new `creating` link in the same intent transaction.

**`itad_jobs`** gets one new column, `pickup_coordinator_user_id uuid null`: the scalar id of an `auth:user`, checked with `isOrganizationUser`.
- Editable and clearable in `draft` and `scheduled`, and in `on_hold` through the pre-hold status rule.
- Added to `domain/job-editability.ts`.

Migration: one migration with the table, its indexes and the column, and no backfill (the CLI does that). It is reviewed before `yarn db:migrate`.

## API Contracts

**Changed (additive):**
- `POST/PUT /api/itad/jobs` accept optional `pickupCoordinatorUserId` (uuid or null). A user outside the organization → 400 `itad.jobs.errors.pickup_coordinator_invalid` (same shape as `customer_invalid`); editability → 400 `itad.jobs.errors.field_locked`, the module's existing code.
- `GET /api/itad/jobs/:id` returns:
  - `pickupCoordinatorUserId`;
  - `pickupTask: { interactionId, state, scheduledAt, lastError, lastSyncedAt } | null`: the current link, or the last one if none is current;
  - `pickupTaskHistoryCount`.

**New:**
- `GET /api/itad/pickup-coordinators`: organization users for the coordinator picker. It reuses `listOrganizationUsers` and requires `itad.jobs.manage`.
- `GET /api/itad/pickup-tasks/lookup?interactionId=<uuid>`: the job behind a pickup task (`{ jobId, reference }`), 404 when the interaction is not a pickup task in the caller's scope. Requires `itad.jobs.view`.
- `POST /api/itad/jobs/:id/pickup-task/sync`: runs the sync for one job now and returns the resulting `pickupTask`. Requires `itad.jobs.manage`; has `metadata` and `openApi`. Idempotent.

**Pickup task guard** (`commands/interceptors.ts`, command interceptors on `customers.interactions.create|update|complete|cancel|delete`; replaces the API interceptor `api/interceptors.ts` since TODO-501):
- Linked task: 422 `{ error: "The date and details of this pickup can only be changed on ITAD job <ref>.", code: "itad_pickup_task_locked", reference }`. In Polish: "Datę i szczegóły tego odbioru można zmienić tylko w zleceniu ITAD <ref>."
- Reserved type: 422 `{ error: "This activity type is reserved for ITAD pickups.", code: "itad_pickup_type_reserved" }`.
- The link lookup is scoped to the caller's tenant and selected organization, so a job of another organization is never revealed.
- Everything else passes through unchanged.

**CLI:** `yarn mercato itad sync-pickup-tasks [--tenant <id>] [--org <id>] [--job <id>] [--dry-run]`.
- Ensures the dictionary entry.
- Runs the sync for every `scheduled` job, or the given job.
- Creates a completed task for `in_transit` jobs without a link.
- Prints counts per step. A second run reports no changes.

**Events:** none new. Failures are logged and stored in `last_error`.

## UI/UX

**Job form:** a "Pickup coordinator" select next to the pickup date, disabled when the status does not allow editing.

**Job page — "Pickup task" section** (in the status panel):
- state badge, date, coordinator, and an "Open calendar" link (`/backend/calendar`);
- with no task yet: "A pickup task is created when the job is scheduled";
- with `lastError`: the warning "Calendar sync failed" and a **Retry calendar sync** button for users with `itad.jobs.manage`. The button disables while running and shows success or error.
- The history count is shown when greater than 1 ("2 earlier pickup tasks").

**Calendar event editor — "Go to job" widget** (added 2026-10-12):
- The calendar's event peek popover has no extension point and its "Edit" button depends only on the user's features, so it stays.
- The event editor dialog is a `CrudForm` for `customers:customer_interaction`, which renders the injection spot `crud-form:customers.customer_interaction` (stacked widgets above the fields) also when embedded in the calendar.
- `itad` injects a widget there. For a pickup task (form value `id` linked in `itad_job_pickup_tasks`) it shows: "This pickup comes from ITAD job <ref>. Change the date and details on the job." and a **Go to job** button linking to `/backend/itad/jobs/<id>`. For any other interaction it renders nothing.
- The lookup is `GET /api/itad/pickup-tasks/lookup?interactionId=<uuid>` → `{ jobId, reference } | 404`, requiring `itad.jobs.view`. A user without it sees nothing.

**Calendar:**
- the calendar has no drag & drop of existing items (dragging on the grid only creates a new event), so a pickup is never moved by dragging;
- the task shows with the `itad-pickup` label, colour and icon;
- saving the editor on it shows the 422 message as a form error;
- the calendar's "Cancel event" action shows its generic failure message;
- the job URL is in the task body.

All strings go into `i18n/pl.json` and `i18n/en.json`. The Polish copy uses "odbiór", "zlecenie" and "koordynator odbioru".

## Requirements

| ID | Requirement |
|---|---|
| REQ-501 | `schedule` creates exactly one planned pickup task: type `itad-pickup`, on the job's customer company, at `scheduledPickupAt`, 60 min, owner = coordinator (or none), title and body as above. |
| REQ-502 | Changing `scheduledPickupAt`, the coordinator, the job name or the customer reference while `scheduled` updates the current task. |
| REQ-503 | `dispatch` completes the current task. |
| REQ-504 | `unschedule`, `hold` from `scheduled`, `cancel` and delete cancel a planned task. A completed task is never cancelled. |
| REQ-505 | `return_to_scheduled`, and `resume` into `scheduled`, create a new task with a new link. Earlier links and tasks keep their state and stay protected. |
| REQ-506 | Duplicate, parallel or retried syncs never create a second current task for a job. |
| REQ-507 | The sync compares the actual interaction with the desired state and corrects drift in date, owner, title, body or status, or recreates a deleted task. |
| REQ-508 | A failed sync never fails or rolls back the job action. `last_error` is shown on the job page, and Retry runs the sync again. |
| REQ-509 | Update, complete, cancel or delete of any linked interaction, current or historical, through any route or command call except the ITAD sync → 422 `itad_pickup_task_locked` with the job reference. Delete is refused for the sync too. Other interactions are unaffected. |
| REQ-510 | Creating or retyping any interaction to `itad-pickup` through the API → 422. |
| REQ-511 | The CLI backfills `scheduled` and `in_transit` jobs, is idempotent, and supports `--dry-run`. |
| REQ-512 | `customers` commands run in the system command context scoped to the job's organization. They work for any user allowed to run the job action, whatever their `customers` features. |
| REQ-513 | `pickupCoordinatorUserId` is validated as an organization user, follows editability, and shows on the form and the job page. |
| REQ-514 | The `itad-pickup` dictionary entry exists for new tenants (`seedDefaults`) and is ensured before the first task create. |
| REQ-515 | Every read and write is scoped to the job's tenant and organization. The interceptor never reveals jobs outside the caller's scope. |

## Edge Cases & Failure Scenarios

- **`customers` command fails** (company soft-deleted, validation): the link keeps its state, `last_error` holds the code, and the job page offers Retry.
- **Task changed outside the command bus** (a direct database write): the next sync of that job detects it and corrects it (REQ-507). Historical tasks are not re-checked. Command callers, including AI tools, are blocked by the guard.
- **Two syncs for one job at once:** only one can insert the current `creating` link (partial unique index). For updates both read the job freshly. The finalize step re-runs if the job changed meanwhile, so the last write reflects the latest job.
- **Crash between intent and command:** the `creating` link keeps its `interaction_id`, and the next sync creates the task with it.
- **Crash between command and finalize:** the next sync finds the interaction and finalizes.
- **Coordinator later removed from the organization:** the task keeps the old owner until the next change. Saving the job then requires a valid user or a cleared field.
- **Admin removes the `itad-pickup` dictionary entry:** existing tasks still render, as an unknown type label. The next create re-ensures the entry.
- **Job's company changes:** only possible in `draft`, where the desired state is never `planned`.
- **Job deleted:** delete is allowed only in `draft` (soft delete, jobs spec). A planned task can still exist there if the `unschedule` sync failed. The `itad.job.deleted` subscriber runs the normal sync; it loads the job including soft-deleted rows and cancels the planned task.

## Risks & Impact Review

- **No contract change in `customers`.** The command interceptors narrow what its commands accept, for linked interactions and the reserved type only. That is an extension of installed behaviour and is documented here.
- **`itad` changes are additive:** a new table and column, optional request and response fields, two new endpoints, a subscriber, an interceptor and a CLI.
- **Interceptor cost:** one indexed lookup by `interaction_id` per update, complete, cancel or delete of any interaction, plus a field check on create and update.
- **System context:** `customers` commands run with no user. This is limited to the job's own organization and to interactions `itad` owns through links. It never acts on input from outside `itad`.
- **Rollback:** disable the subscriber and the interceptor. Existing tasks stay as ordinary interactions and can be cancelled in bulk by type through the `customers` API, because the interceptor is off.

## Known Gaps (TODO)

### TODO-501 — the lock does not cover the separate complete / cancel routes

**Status:** **resolved 2026-10-14.** Severity was high and it blocked the Epic 5 release: the spec promised that the job is the only place to change a pickup, and a normal company-page action broke that. Found 2026-10-13. The text below describes the problem as found; the resolution follows it.

**Problem.** The protection is an **API interceptor** (`src/modules/itad/api/interceptors.ts`, id `itad.pickup-task-guard`, `targetRoute: 'customers/interactions'`). An API interceptor runs only inside a route built with `makeCrudRoute`: `applyInterceptorsBefore` in `@open-mercato/shared/src/lib/crud/factory.ts` reads the registry with `getApiInterceptorsForRoute(routePath, method)`, and `routeMatches` compares `targetRoute` with the path exactly. The `customers` module also has hand-written interaction routes that call the commands directly and never read the API interceptor registry:

| Route | Command | Feature | UI callers |
|---|---|---|---|
| `POST /api/customers/interactions/complete` (`customers/api/interactions/complete/route.ts`) | `customers.interactions.complete` | `customers.interactions.manage` | "Mark as done" on the company/person page: `components/detail/ActivityCard.tsx`, `components/detail/ActivitiesSection.tsx`, `components/detail/hooks/useInteractionMutations.ts`, `components/detail/hooks/useInteractions.ts` |
| `POST /api/customers/interactions/cancel` (`customers/api/interactions/cancel/route.ts`) | `customers.interactions.cancel` | `customers.interactions.manage` | `components/detail/hooks/useInteractions.ts` |

The pickup task sits on the job's customer company, so it is listed in that company's Activities. Any user with `customers.interactions.manage` can **mark a pickup task done or cancel it from the company page**, and the call succeeds. The calendar itself is not affected: it uses only the main route (`PUT` / `DELETE /api/customers/interactions`), where the interceptor works.

Out of scope: `/api/customers/interactions/[id]/visibility` changes only `email` interactions, so it cannot reach a pickup task.

**Effect today:**
- The task shows "done" or "canceled" in the calendar and in the company Activities, while the job is still `scheduled`.
- The link in `itad_job_pickup_tasks` still says `planned`, so the job page does not show the discrepancy.
- Drift correction (REQ-507) restores the task to `planned` only at the next sync of that job: a job change, "Retry calendar sync", or the CLI. Until then calendar and job disagree.
- The same applies to any other caller that runs these commands as a user (e.g. an AI tool).

**Resolution (2026-10-14), following the review:**
- **One protection layer.** The command interceptors in `commands/interceptors.ts` replace the API interceptor, which is removed. The reserved-type rule moved there too, so the rule exists once.
- **Delete is refused for everyone,** including the sync, so earlier pickup tasks stay as history.
- **Trusted sync marker.** The interceptor context offers no framework trusted flag, and `auth: null` can be built by any in-process caller, so the sync uses its own `AsyncLocalStorage` marker (`lib/pickup-sync-scope.ts`).
- **Stable codes:** `itad_pickup_task_locked` and `itad_pickup_type_reserved`, returned with HTTP 422.
- **Generated registration checked:** `command-interceptors.generated.ts` is used by the app, and the compiled `command-interceptors.generated.mjs` by the CLI and workers. Both contain `itad.pickup-task-guard.*`.
- **Tests:**
  - 21 unit tests: every command × user / trusted sync / system without the marker; delete refused for the sync; delete input shapes; calendar save with the pickup type; reserved type on create and retype; ordinary interactions pass; other organization not revealed.
  - TC-ITAD-405 covers every route: `PUT`, `DELETE`, `complete`, `cancel`, reserved create and retype, and ordinary interactions through each route.
  - TC-ITAD-404 checks that a historical task is protected on `PUT`, `cancel` and `DELETE`.
  - TC-ITAD-401…407 are the sync regression.

**Original plan** (kept for reference):
- Add a **command interceptor** in `src/modules/itad/commands/interceptors.ts` (export `interceptors: CommandInterceptor[]`; `yarn generate` registers it through `command-interceptors.generated`).
- Target `customers.interactions.update`, `customers.interactions.complete`, `customers.interactions.cancel` and `customers.interactions.delete`.
- In `beforeExecute`, for an interaction that has a link in `itad_job_pickup_tasks` in the caller's tenant/organization:
  - block with `{ ok: false }` and HTTP 422, carrying the same message as today ("The date and details of this pickup can only be changed on ITAD job <ref>.");
  - **allow** executions without a user (`auth === null`): the `itad` sync runs the commands in the system command context.
- Command interceptors run inside the command bus for every caller, so the lock no longer depends on which route was used.
- Keep the API interceptor only for reserving the `itad-pickup` type on `POST` / `PUT`, or move that check into the command interceptor on `customers.interactions.create` / `.update` as well.
- Before implementing, check two things with `om-framework-context`:
  - how a command interceptor rejection becomes an HTTP status. The hand-written routes map it with `getCommandInterceptorHttpRejection`;
  - that `auth === null` is reliably the system context and not reachable from a user request.

**Tests to add:**
- unit tests of the command interceptor: linked + user → blocked, linked + system → allowed, unlinked → allowed;
- integration: `POST /api/customers/interactions/complete` and `/cancel` on a pickup task → 422 with the job reference, task unchanged; the same on an ordinary interaction → 200;
- regression: the sync still creates, updates, completes and cancels tasks (TC-ITAD-401…407).

**Related fix already made (2026-10-13, not yet merged):**
- The calendar editor re-sends `interactionType: 'itad-pickup'` on every save. The API interceptor used to check the reserved type first, so a calendar save showed "This activity type is reserved for ITAD pickups." instead of the job message.
- It now checks the link first on `PUT` / `DELETE`. There is a regression unit test, and TC-ITAD-405 has a case for a `PUT` with `interactionType`.

## Phasing

The phases are separate PRs; each leaves the app working.
1. **Phase 1 — Synced and protected pickup task:** link table, domain rules, `customers` integration, sync with drift detection, subscriber, interceptor and dictionary entry. Delivering creation and protection together means no released state lets users edit pickup tasks.
2. **Phase 2 — Coordinator and job page:** the coordinator field (data, API, form), the "Pickup task" section, Retry, and the "Go to job" widget in the calendar's event editor.
3. **Phase 3 — Backfill:** the CLI.

## Implementation Plan

**Phase 1:**
1. Entity `ItadJobPickupTask`, plus the `ItadJob.pickupCoordinatorUserId` column (it lands now so the migration is single, and is used in Phase 2); `yarn db:generate`; review the SQL with the user before migrating.
2. `domain/pickup-task.ts`: `desiredPickupTask` and `planPickupTaskStep`, with unit tests for every row of the two tables above, including deleted jobs and terminal current links.
3. `module-integrations/customers.ts`: `readPickupTask` (query engine; confirm the `customers:customer_interaction` entity id in the generated ids), the command helpers in the system context, and `ensurePickupActivityType`. `setup.ts` `seedDefaults` ensures the dictionary entry.
4. `services/pickup-task-sync.ts` (read → decide → intent → command → finalize, re-run on job change) and `subscribers/sync-pickup-task.ts`.
5. `api/interceptors.ts` guard, with unit tests: linked current or historical → 422, unlinked → pass, reserved type → 422, foreign scope → pass. *(Replaced by the command interceptors in `commands/interceptors.ts`, TODO-501.)*
6. Integration tests:
   - TC-ITAD-401: schedule creates a task visible in `/api/customers/interactions`.
   - TC-ITAD-402: a date change updates it; dispatch completes it.
   - TC-ITAD-403: unschedule, hold and cancel cancel it. Unschedule then delete of the draft leaves the task cancelled.
   - TC-ITAD-404: `return_to_scheduled` creates a second task; the first stays and is still locked.
   - TC-ITAD-405: `PUT`, `DELETE` and the reserved type get 422; an ordinary interaction still saves.
   - TC-ITAD-406: drift through the `customers` commands, corrected by the next job change:
     - external date change → the date is restored;
     - external `complete` → back to planned;
     - external `cancel` → back to planned;
     - external delete → a new task is created and the old link is `lost`.
   - TC-ITAD-407: a user with `itad.jobs.transition` but without `customers.interactions.manage` schedules a job, and the task is created.

**Phase 2:**
1. Coordinator: validators, job commands (`isOrganizationUser`), editability with tests, `GET /api/itad/pickup-coordinators`, and the form field.
2. `pickupTask` in the job detail response, `POST /api/itad/jobs/:id/pickup-task/sync`, and the "Pickup task" section with Retry.
3. Integration tests:
   - TC-ITAD-408: the coordinator becomes the task owner; an invalid user gets 422.
   - TC-ITAD-409: UI — the job page section shows the states; Retry after a forced failure creates the task; the calendar shows the task and rejects an editor save with the message.
   - TC-ITAD-410: UI — the calendar event editor of a pickup task shows the job reference and "Go to job" opens the job; the editor of an ordinary interaction shows no widget; the lookup API returns 404 for an ordinary interaction and 403 without `itad.jobs.view`.

**Phase 3:**
1. `cli.ts` `sync-pickup-tasks` with `--dry-run` and `--job`.
2. TC-ITAD-411: the CLI creates tasks for a pre-existing scheduled job and a completed one for an `in_transit` job; a second run reports no changes.

Validation per phase: `yarn generate && yarn typecheck && yarn lint && yarn ds:check && yarn test`, then the phase's TC-ITAD tests and the TC-ITAD regression on the ephemeral environment.

## Implementation Status

| Phase | Status | Evidence |
|---|---|---|
| 1 — Synced and protected pickup task | Done (2026-10-12) | See below |
| 2 — Coordinator and job page | Done (2026-10-12) | See below |
| 3 — Backfill | Not started | — |

**Phase 1 evidence:**
- `domain/pickup-task.ts`: 31 unit tests.
- `api/interceptors.ts`: 6 unit tests.
- Integration tests TC-ITAD-401…407 on the ephemeral environment, with all drift variants writing to the test database (`changeTaskOutsideApi` asserts one affected row).
- Full TC-ITAD regression: 66/66.
- `yarn typecheck`, `lint`, `ds:check`, `test` (279/279) and `build` pass.
- Migration `Migration20261012063623_itad` applied to the dev database after review.

**Phase 2 evidence:**
- Coordinator in editability (`domain/job-editability.ts`, 2 new unit tests), validators, job commands (`isOrganizationUser`) and the job form (combobox from `GET /api/itad/pickup-coordinators`).
- `pickupCoordinator`, `pickupTask` and `pickupTaskHistoryCount` in the single-job read.
- `POST /api/itad/jobs/{id}/pickup-task/sync` (Retry).
- `GET /api/itad/pickup-tasks/lookup`.
- "Pickup task" section in the status panel.
- "Go to job" widget on `crud-form:customers.customer_interaction`.
- Integration tests:
  - TC-ITAD-408 (API): coordinator, read model, lookup 200/404/403, lock after dispatch;
  - TC-ITAD-409 (UI): section states, Retry clears a recorded failure;
  - TC-ITAD-410 (UI): the calendar editor of a pickup task shows the widget and "Go to job" opens the job, while an ordinary event has no widget.
- TC-ITAD-001 now expects `pickupCoordinatorUserId` among the draft's editable fields (additive).
- Full TC-ITAD regression: 69/69.
- `typecheck`, `lint`, `ds:check`, `test` (281/281) and `build` pass.

**Deviations recorded in this spec:**
- Phase 1's API interceptor returned `{ error: <message> }`. Since TODO-501 the command interceptors return `{ error, code, reference? }`.
- `OM_ITAD_CALENDAR_LOCALE` selects the task text language.
- A `creating` link whose task never appeared is marked `lost` when the job no longer needs a planned task.
- Phase 1 added the coordinator column but did not use it; since Phase 2 the coordinator is the task owner.
- Phase 2 error codes follow the module's existing ones: 400 `pickup_coordinator_invalid` / `field_locked` instead of the planned 422 codes.
- In the calendar's Agenda view a click opens the event editor directly, so the widget is one click away. In the week view the peek popover comes first.

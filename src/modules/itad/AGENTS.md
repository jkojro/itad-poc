# `itad` module — structure rules

Module-specific rules for agents and developers. They add to the root `AGENTS.md` and the framework conventions; when they conflict, the root file and the framework win. Specs for this module live in `.ai/specs/*-itad-*.md` (first: `2026-10-02-itad-jobs.md`).

## One module for the whole ITAD process

Jobs, assets, data erasure, grading, chain of custody, certificates and dispositions all belong to this module. Their invariants must stay transactionally consistent, and cross-module ORM relations are banned. Separate sub-domains by file names, ACL features (`itad.jobs.*`, `itad.assets.*`, …) and directories — not by new modules.

## Directory roles

Framework-discovered paths (`index.ts`, `acl.ts`, `setup.ts`, `events.ts`, `data/entities.ts`, `data/validators.ts`, `api/**/route.ts`, `backend/**/page.tsx` + `page.meta.ts`, `i18n/<locale>.json`, `migrations/`, `subscribers/`, `workers/`, `widgets/`) follow the framework and are not repeated here. The app-owned directories:

| Directory | Holds | Must not |
|---|---|---|
| `domain/` | Pure ITAD business rules and the vocabulary they use: domain types (`job-types.ts` owns `ITAD_JOB_STATUSES` / `ItadJobStatus`), state machine, conditions contract and decision, field editability, reference format. State + requested operation + facts → decision. | Import anything outside `domain/` — no framework, ORM, DI, database, other modules, and no `data/`. Dependencies point inward: `data/`, `commands/`, `api/` and `components/` import from `domain/`, never the reverse. Data a rule needs reaches it as injected facts or lookups (today `ConditionDeps.isCustomerValid`; target shape for asset/exception/document conditions: facts computed by `services/job-condition-evaluator.ts` and passed in). |
| `services/` | Module application/infrastructure services with side effects used by commands, e.g. `job-reference-generator.ts` (sequence allocation). Later: `job-condition-evaluator.ts` (reads assets/exceptions/documents and computes condition facts). **Registration in `di.ts` is optional** — unlike some installed modules where `services/` implies DI; a service that writes inside a command's transaction stays a plain module (see Transactions). | Hold business rules (they belong in `domain/`), know who or why called them, write audit entries or emit events. |
| `module-integrations/` | Reads of other Open Mercato modules through public contracts (`QueryEngine` by entity id, public APIs/DI): `customers.ts`, `users.ts`, later `attachments.ts`. One file per installed module. | Import another module's ORM entity classes or create relations to them. Store foreign IDs as scalars. |
| `commands/` | One file per resource or use case (`jobs.ts` = create/update/delete, `transitions.ts`). Commands are the only entry point for user-initiated writes: they own transactions, guards, optimistic locking, audit (`buildLog`) and post-commit side effects, and orchestrate `domain/` + `services/`. | Duplicate rules that exist in `domain/`. |
| `lib/` | Module-internal glue that knows the framework (HTTP, DI, error shapes, generated ids) but holds no ITAD rules and reads no other module's data. Current examples: coded HTTP errors (`errors.ts`), request context for hand-written routes (`route-context.ts`), generated-id constants (`constants.ts`). | Become a catch-all: business rules go to `domain/`, cross-module data reads to `module-integrations/`, side-effecting operations to `services/`. |
| `components/` | Client UI for this module's pages and widgets. | Call APIs with raw `fetch` (use `@open-mercato/ui` API helpers). |
| `__integration__/` | Playwright API/UI tests `TC-ITAD-NNN-<scenario>.spec.ts` plus shared fixtures (`itad-job-fixtures.ts`). Self-contained data, cleaned up in `finally`. | Depend on seeded/demo data or run order. |
| `<dir>/__tests__/` | Jest unit tests next to the code they test (`domain/__tests__/` for the pure rules). | Hit the database. |

### Allowed touchpoints with other modules outside `module-integrations/`

`module-integrations/` is the only place that **reads data** owned by another module. Two other kinds of cross-module imports are allowed where they are used, and are not data reads:

- **Platform infrastructure** used through DI or shared helpers — authorization/RBAC (`rbacService`), organization scope (`resolveOrganizationScopeForRequest`), command bus, query engine, events — in `lib/`, `api/` and `commands/`.
- **Reusable UI components** exported by installed modules (e.g. `CompanySelectField` from `customers`) in `components/`.

## External systems

External integrations with independent configuration, credentials, lifecycle or reusable capabilities (likely: data-erasure tools such as Blancco, waste registries such as BDO) are implemented as **provider modules** built with `om-integration-builder` — they own credentials, health checks, API clients, webhooks, sync, retries and errors, and talk to `itad` through commands, events and DI contracts. A small, ITAD-only call without its own configuration or lifecycle may stay inside this module as an adapter; the spec that introduces it records which side of this criterion it is on and why.

## Transactions

A service that writes as part of a command never resolves its own `EntityManager`. The command passes the EntityManager of its open transaction (`withAtomicFlush(em, …, { transaction: true })`), e.g. `allocateJobReference(em, scope, at)`, so a sequence increment and the INSERT that consumes it cannot end up in two transactions. For this reason such services are plain modules, not DI registrations with an injected `em`.

## Naming

- Non-component TypeScript files use kebab-case (`job-state-machine.ts`, `job-reference-generator.ts`, `itad-job-fixtures.ts`).
- React component files use PascalCase (`JobsTable.tsx`, `JobStatusPanel.tsx`).
- Stable identifiers do not follow file names and never change on a file move: command ids (`itad.jobs.transition`), event ids (`itad.job.status_changed`), ACL features, entity ids (`itad:itad_job`), i18n keys.

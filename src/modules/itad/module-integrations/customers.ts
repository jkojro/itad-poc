import type { AwilixContainer } from 'awilix'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import {
  INTERACTION_STATUS,
  PICKUP_TASK_INTERACTION_TYPE,
  PICKUP_TASK_SOURCE,
  type ActualPickupTask,
  type PickupTaskContent,
} from '../domain/pickup-task'
import { runAsPickupSync } from '../lib/pickup-sync-scope'

/**
 * Reads customer companies owned by the installed `customers` module.
 *
 * Goes through the query engine by entity id — never through `customers` ORM
 * classes — so the `itad` module holds only a scalar `customerId`. The engine applies
 * the tenant/organization guards, excludes soft-deleted rows, and decrypts
 * `display_name` (encrypted at rest by `customers`).
 */
export const CUSTOMER_ENTITY_ID = 'customers:customer_entity'

type CustomerRow = { id: string; display_name?: string | null; kind?: string | null }

export type CustomerScope = { tenantId: string; organizationId: string }

export async function loadCompanyNames(
  queryEngine: QueryEngine,
  scope: CustomerScope,
  ids: string[],
): Promise<Map<string, string>> {
  const unique = Array.from(new Set(ids.filter((id) => typeof id === 'string' && id.length > 0)))
  const names = new Map<string, string>()
  if (unique.length === 0) return names
  const result = await queryEngine.query<CustomerRow>(CUSTOMER_ENTITY_ID, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    fields: ['id', 'display_name', 'kind'],
    filters: { id: { $in: unique }, kind: 'company' },
    page: { page: 1, pageSize: unique.length },
  })
  for (const row of result.items) {
    if (typeof row.id !== 'string') continue
    names.set(row.id, typeof row.display_name === 'string' ? row.display_name : '')
  }
  return names
}

/** True when `customerId` is a live company in exactly this tenant + organization. */
export async function isCompanyInScope(
  queryEngine: QueryEngine,
  scope: CustomerScope,
  customerId: string,
): Promise<boolean> {
  const names = await loadCompanyNames(queryEngine, scope, [customerId])
  return names.has(customerId)
}

/** Customers scanned when matching an email sender (`primary_email` is encrypted, so there is no index to search). */
const SENDER_SCAN_PAGE = 500
const SENDER_SCAN_PAGES = 4

type CustomerEmailRow = { id: string; kind?: string | null; primary_email?: string | null }
type PersonProfileRow = { entity_id?: string | null; company_entity_id?: string | null }

/**
 * The companies an email address belongs to (ITAD Inbox Ops matching): a company whose
 * primary email is the address, or the company of a person whose primary email is. The
 * email is encrypted at rest without a lookup hash, so this scans the organization's
 * customers (bounded) and compares after decryption — the same approach `inbox_ops` takes.
 */
export async function findCompaniesByEmail(queryEngine: QueryEngine, scope: CustomerScope, address: string): Promise<string[]> {
  const wanted = address.trim().toLowerCase()
  if (!wanted) return []
  const companies = new Set<string>()
  const people: string[] = []
  for (let page = 1; page <= SENDER_SCAN_PAGES; page += 1) {
    const result = await queryEngine.query<CustomerEmailRow>(CUSTOMER_ENTITY_ID, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      fields: ['id', 'kind', 'primary_email'],
      page: { page, pageSize: SENDER_SCAN_PAGE },
    })
    for (const row of result.items) {
      if (typeof row.primary_email !== 'string' || row.primary_email.trim().toLowerCase() !== wanted) continue
      if (row.kind === 'company') companies.add(row.id)
      else people.push(row.id)
    }
    if (result.items.length < SENDER_SCAN_PAGE) break
  }
  if (people.length > 0) {
    const profiles = await queryEngine.query<PersonProfileRow>('customers:customer_person_profile', {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      fields: ['entity_id', 'company_entity_id'],
      filters: { entity_id: { $in: people } },
      page: { page: 1, pageSize: people.length },
    })
    for (const profile of profiles.items) if (profile.company_entity_id) companies.add(profile.company_entity_id)
  }
  return Array.from(companies)
}

/*
 * Pickup tasks (pickup calendar spec). The task is a `customers` interaction: `itad` reads
 * it through the query engine and writes it only through the public `customers.*`
 * commands, in a system command context scoped to the job's organization. The command
 * bus checks scope, not features, so the sync never depends on the permissions of the
 * user who changed the job.
 */
export const INTERACTION_ENTITY_ID = 'customers:customer_interaction'
const DICTIONARY_ENTRY_ENTITY_ID = 'customers:customer_dictionary_entry'
const ACTIVITY_TYPE_KIND = 'activity_type'

type Resolver = { resolve: <T = unknown>(name: string) => T }

type InteractionRow = {
  id: string
  status?: string | null
  scheduled_at?: string | Date | null
  duration_minutes?: number | null
  owner_user_id?: string | null
  title?: string | null
  body?: string | null
  tenant_id?: string | null
  organization_id?: string | null
}

const toDate = (value: string | Date | null | undefined): Date | null => {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/** The live task, or `null` when it is missing or soft-deleted (the engine excludes those). */
export async function readPickupTask(
  queryEngine: QueryEngine,
  scope: CustomerScope,
  interactionId: string,
): Promise<ActualPickupTask | null> {
  const result = await queryEngine.query<InteractionRow>(INTERACTION_ENTITY_ID, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    // `tenant_id` / `organization_id` are projected so the engine can decrypt title/body.
    fields: ['id', 'status', 'scheduled_at', 'duration_minutes', 'owner_user_id', 'title', 'body', 'tenant_id', 'organization_id'],
    filters: { id: interactionId },
    page: { page: 1, pageSize: 1 },
  })
  const row = result.items.find((item) => item.id === interactionId)
  if (!row) return null
  return {
    status: typeof row.status === 'string' ? row.status : '',
    scheduledAt: toDate(row.scheduled_at),
    durationMinutes: typeof row.duration_minutes === 'number' ? row.duration_minutes : null,
    ownerUserId: typeof row.owner_user_id === 'string' ? row.owner_user_id : null,
    title: typeof row.title === 'string' ? row.title : null,
    body: typeof row.body === 'string' ? row.body : null,
  }
}

function systemCommandContext(container: Resolver, scope: CustomerScope): CommandRuntimeContext {
  return {
    container: container as unknown as AwilixContainer,
    auth: null,
    organizationScope: null,
    selectedOrganizationId: scope.organizationId,
    organizationIds: [scope.organizationId],
  }
}

/**
 * Runs a `customers` command as the pickup task sync: system context plus the trusted
 * sync marker, which the `itad` pickup task guard lets through (spec TODO-501).
 */
async function runCustomersCommand(container: Resolver, scope: CustomerScope, commandId: string, input: Record<string, unknown>) {
  const commandBus = container.resolve<CommandBus>('commandBus')
  await runAsPickupSync(() => commandBus.execute(commandId, { input, ctx: systemCommandContext(container, scope) }))
}

const isUniqueViolation = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false
  const record = error as { name?: unknown; code?: unknown }
  return record.name === 'UniqueConstraintViolationException' || record.code === '23505'
}

/**
 * Creates the task with the id `itad` chose beforehand. A row that already exists with
 * that id means an earlier attempt landed, so it counts as done.
 */
export async function createPickupTask(
  container: Resolver,
  scope: CustomerScope,
  input: { interactionId: string; companyId: string; content: PickupTaskContent },
): Promise<void> {
  try {
    await runCustomersCommand(container, scope, 'customers.interactions.create', {
      id: input.interactionId,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      entityId: input.companyId,
      interactionType: PICKUP_TASK_INTERACTION_TYPE,
      source: PICKUP_TASK_SOURCE,
      status: INTERACTION_STATUS.planned,
      title: input.content.title,
      body: input.content.body,
      scheduledAt: input.content.scheduledAt,
      durationMinutes: input.content.durationMinutes,
      ownerUserId: input.content.ownerUserId,
    })
  } catch (error) {
    if (isUniqueViolation(error)) return
    throw error
  }
}

export async function updatePickupTask(
  container: Resolver,
  scope: CustomerScope,
  input: { interactionId: string; content: PickupTaskContent; reopen: boolean },
): Promise<void> {
  await runCustomersCommand(container, scope, 'customers.interactions.update', {
    id: input.interactionId,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    title: input.content.title,
    body: input.content.body,
    scheduledAt: input.content.scheduledAt,
    durationMinutes: input.content.durationMinutes,
    ownerUserId: input.content.ownerUserId,
    ...(input.reopen ? { status: INTERACTION_STATUS.planned, occurredAt: null } : {}),
  })
}

export async function completePickupTask(container: Resolver, scope: CustomerScope, interactionId: string): Promise<void> {
  await runCustomersCommand(container, scope, 'customers.interactions.complete', { id: interactionId })
}

export async function cancelPickupTask(container: Resolver, scope: CustomerScope, interactionId: string): Promise<void> {
  await runCustomersCommand(container, scope, 'customers.interactions.cancel', { id: interactionId })
}

/**
 * Makes sure the `itad-pickup` activity type exists, so the calendar shows its label,
 * colour and icon. An existing entry is left as an admin may have edited it.
 */
export async function ensurePickupActivityType(
  container: Resolver,
  scope: CustomerScope,
  label: string,
): Promise<void> {
  const queryEngine = container.resolve<QueryEngine>('queryEngine')
  const existing = await queryEngine.query<{ id: string }>(DICTIONARY_ENTRY_ENTITY_ID, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    fields: ['id'],
    filters: { kind: ACTIVITY_TYPE_KIND, normalized_value: PICKUP_TASK_INTERACTION_TYPE },
    page: { page: 1, pageSize: 1 },
  })
  if (existing.items.length > 0) return
  await runCustomersCommand(container, scope, 'customers.dictionaryEntries.create', {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    kind: ACTIVITY_TYPE_KIND,
    value: PICKUP_TASK_INTERACTION_TYPE,
    label,
    color: 'brand',
    icon: 'lucide:truck',
  })
}

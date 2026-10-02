import type { QueryEngine } from '@open-mercato/shared/lib/query/types'

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

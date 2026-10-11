import type { QueryEngine } from '@open-mercato/shared/lib/query/types'

/**
 * Display names of staff users (actors in job history, the user who put a job on hold).
 *
 * Reads `auth:user` through the query engine — never `auth` ORM classes. Users of one
 * tenant may belong to different organizations, so only the tenant is pinned (the
 * caller's trusted tenant) and ids are an explicit allow-list. `name` and `email` are
 * encrypted at rest; the engine decrypts them. Mirrors the installed audit-log display
 * rule: name, falling back to email.
 *
 * `tenant_id` and `organization_id` MUST be projected: the engine resolves the
 * encryption map per row from them, and the `auth:user` map is stored per tenant and
 * organization — without them the lookup misses the map and returns ciphertext.
 */
type UserRow = {
  id: string
  name?: string | null
  email?: string | null
  tenant_id?: string | null
  organization_id?: string | null
}

export async function loadUserDisplayNames(
  queryEngine: QueryEngine,
  tenantId: string,
  ids: Array<string | null | undefined>,
): Promise<Map<string, string>> {
  const unique = Array.from(new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0)))
  const names = new Map<string, string>()
  if (!unique.length) return names
  const result = await queryEngine.query<UserRow>('auth:user', {
    tenantId,
    fields: ['id', 'name', 'email', 'tenant_id', 'organization_id'],
    filters: { id: { $in: unique } },
    page: { page: 1, pageSize: unique.length },
  })
  for (const row of result.items) {
    if (typeof row.id !== 'string') continue
    const display = (typeof row.name === 'string' && row.name.trim()) || (typeof row.email === 'string' && row.email) || row.id
    names.set(row.id, display)
  }
  return names
}

export type OrganizationUser = { id: string; name: string | null; email: string | null }

const ORGANIZATION_USER_SCAN_LIMIT = 500

/**
 * Active human users of one organization (exceptions spec Q12: any of them may be an
 * assignee). Soft-deleted users are excluded by the engine. `name` / `email` are
 * encrypted at rest, so `search` is matched after decryption, in memory.
 */
export async function listOrganizationUsers(
  queryEngine: QueryEngine,
  scope: { tenantId: string; organizationId: string },
  options: { search?: string; limit?: number; ids?: string[] } = {},
): Promise<OrganizationUser[]> {
  const result = await queryEngine.query<UserRow & { kind?: string | null }>('auth:user', {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    fields: ['id', 'name', 'email', 'kind', 'tenant_id', 'organization_id'],
    filters: {
      organization_id: scope.organizationId,
      ...(options.ids ? { id: { $in: options.ids } } : {}),
    },
    page: { page: 1, pageSize: ORGANIZATION_USER_SCAN_LIMIT },
  })
  const needle = options.search?.trim().toLocaleLowerCase() ?? ''
  const users = result.items
    .filter((row) => typeof row.id === 'string' && (row.kind ?? 'human') === 'human')
    .map((row) => ({
      id: row.id,
      name: typeof row.name === 'string' && row.name.trim() ? row.name.trim() : null,
      email: typeof row.email === 'string' ? row.email : null,
    }))
    .filter((user) => !needle || `${user.name ?? ''} ${user.email ?? ''}`.toLocaleLowerCase().includes(needle))
    .sort((a, b) => (a.name ?? a.email ?? '').localeCompare(b.name ?? b.email ?? ''))
  return users.slice(0, options.limit ?? 20)
}

/** Whether `userId` is an active human user of the organization. */
export async function isOrganizationUser(
  queryEngine: QueryEngine,
  scope: { tenantId: string; organizationId: string },
  userId: string,
): Promise<boolean> {
  const users = await listOrganizationUsers(queryEngine, scope, { ids: [userId], limit: 1 })
  return users.length === 1
}

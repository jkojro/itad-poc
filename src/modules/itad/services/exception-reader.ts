import type { EntityManager } from '@mikro-orm/postgresql'
import type { ExceptionFacts } from '../domain/exceptions'

/**
 * Read side of exceptions: scoped counts for conditions and list counters. Pass the
 * transaction's EntityManager when the result guards a write (the transition command does).
 */
export type ExceptionScope = { tenantId: string; organizationId: string }

/** Facts for `noBlockingExceptions` (every supported type is blocking while OPEN). */
export async function loadExceptionFacts(em: EntityManager, scope: ExceptionScope, jobId: string): Promise<ExceptionFacts> {
  const row = await em.execute<{ open: string | number }>(
    `select count(*) as "open" from "itad_exceptions"
     where "tenant_id" = ? and "organization_id" = ? and "job_id" = ? and "status" = 'open'`,
    [scope.tenantId, scope.organizationId, jobId],
    'get',
  )
  return { openExceptions: Number(row?.open ?? 0) }
}

/** OPEN exceptions per job (jobs list) or per asset (asset lists): one grouped query. */
export async function countOpenExceptions(
  em: EntityManager,
  tenantId: string,
  by: 'job_id' | 'asset_id',
  ids: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  if (!ids.length) return counts
  const rows = await em.execute<Array<{ key: string; count: string | number }>>(
    `select "${by}" as "key", count(*) as "count" from "itad_exceptions"
     where "tenant_id" = ? and "${by}" in (${ids.map(() => '?').join(', ')}) and "status" = 'open'
     group by "${by}"`,
    [tenantId, ...ids],
  )
  for (const row of rows) counts.set(String(row.key), Number(row.count))
  return counts
}

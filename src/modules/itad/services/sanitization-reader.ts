import type { EntityManager } from '@mikro-orm/postgresql'
import type { ProcessingFacts } from '../domain/job-conditions'

/**
 * Read side of sanitization (scoped SQL; pass the transaction's EntityManager when a
 * result guards a write). Data-bearing assets are active assets with `data_bearing = true`.
 */
export type SanitizationScope = { tenantId: string; organizationId: string }

export type SanitizationCounts = {
  required: number
  inProgress: number
  sanitized: number
  reviewRequired: number
}

const COUNTS_SQL = `select
    count(*) filter (where a."status" = 'sanitization_required') as "required",
    count(*) filter (where a."status" = 'sanitization_in_progress') as "in_progress",
    count(*) filter (where a."status" = 'sanitized') as "sanitized",
    count(*) filter (where a."status" = 'review_required') as "review_required"
  from "itad_assets" a
  where a."tenant_id" = ? and a."organization_id" = ? and a."job_id" = ? and a."deleted_at" is null and a."data_bearing" = true`

/** Counters of the Sanitization tab, by asset status. */
export async function loadSanitizationCounts(em: EntityManager, scope: SanitizationScope, jobId: string): Promise<SanitizationCounts> {
  const row = await em.execute<Record<string, string | number>>(COUNTS_SQL, [scope.tenantId, scope.organizationId, jobId], 'get')
  return {
    required: Number(row?.required ?? 0),
    inProgress: Number(row?.in_progress ?? 0),
    sanitized: Number(row?.sanitized ?? 0),
    reviewRequired: Number(row?.review_required ?? 0),
  }
}

const PENDING_SQL = `select count(*) as "pending" from "itad_assets" a
  where a."tenant_id" = ? and a."organization_id" = ? and a."job_id" = ? and a."deleted_at" is null
    and a."data_bearing" = true and a."status" <> 'sanitized'`

/** Facts for `allAssetsProcessed` (sanitization spec Q14). */
export async function loadProcessingFacts(em: EntityManager, scope: SanitizationScope, jobId: string): Promise<ProcessingFacts> {
  const row = await em.execute<{ pending: string | number }>(PENDING_SQL, [scope.tenantId, scope.organizationId, jobId], 'get')
  return { sanitizationPending: Number(row?.pending ?? 0) }
}

/** `sanitizationPendingCount` per job for the jobs list: one grouped query. */
export async function countSanitizationPending(em: EntityManager, tenantId: string, jobIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  if (!jobIds.length) return counts
  const rows = await em.execute<Array<{ job_id: string; count: string | number }>>(
    `select "job_id", count(*) as "count" from "itad_assets"
     where "tenant_id" = ? and "job_id" in (${jobIds.map(() => '?').join(', ')}) and "deleted_at" is null
       and "data_bearing" = true and "status" <> 'sanitized'
     group by "job_id"`,
    [tenantId, ...jobIds],
  )
  for (const row of rows) counts.set(String(row.job_id), Number(row.count))
  return counts
}

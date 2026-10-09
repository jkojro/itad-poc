import type { EntityManager } from '@mikro-orm/postgresql'

/**
 * Read side of receiving: per-job counters for the job summary. Scoped by the caller's
 * trusted tenant and an explicit list of jobs it may read.
 */

/** `receivedAssetCount` per job: active assets, one grouped query. */
export async function countActiveAssets(em: EntityManager, tenantId: string, jobIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  if (!jobIds.length) return counts
  const rows = await em.execute<Array<{ job_id: string; count: string | number }>>(
    `select "job_id", count(*) as "count" from "itad_assets"
     where "tenant_id" = ? and "job_id" in (${jobIds.map(() => '?').join(', ')}) and "deleted_at" is null
     group by "job_id"`,
    [tenantId, ...jobIds],
  )
  for (const row of rows) counts.set(String(row.job_id), Number(row.count))
  return counts
}

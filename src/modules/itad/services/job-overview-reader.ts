import type { EntityManager } from '@mikro-orm/postgresql'
import { EMPTY_JOB_OVERVIEW_SOURCE, type JobOverviewSource } from '../domain/job-overview'

/**
 * Read side of the operations overview (operations dashboard spec "Read model, not a
 * copy"): one grouped query per source table for a set of jobs, keyed by `job_id`.
 * Nothing is stored; every read reflects the current workflow data (REQ-719).
 *
 * The job ids come from a scoped job query (tenant and readable organizations); the
 * tenant is filtered again here. Matching follows the reconciliation reader: active
 * manifest item and active asset of the same job with the same normalized serial.
 */
type Row = Record<string, string | number | null>

const placeholders = (ids: string[]) => ids.map(() => '?').join(', ')
const num = (value: string | number | null | undefined) => Number(value ?? 0)

export async function loadJobOverviewSources(
  em: EntityManager,
  tenantId: string,
  jobIds: string[],
): Promise<Map<string, JobOverviewSource>> {
  const sources = new Map<string, JobOverviewSource>(jobIds.map((id) => [id, { ...EMPTY_JOB_OVERVIEW_SOURCE }]))
  if (!jobIds.length) return sources
  const inJobs = placeholders(jobIds)
  const params = [tenantId, ...jobIds]

  const [manifest, assets, scans, exceptions] = await Promise.all([
    em.execute<Row[]>(
      `select m."job_id",
              count(*) as "active_items",
              count(*) filter (where exists (
                select 1 from "itad_assets" a
                where a."tenant_id" = m."tenant_id" and a."organization_id" = m."organization_id" and a."job_id" = m."job_id"
                  and a."serial_normalized" = m."serial_normalized" and a."deleted_at" is null)) as "matched"
       from "itad_manifest_items" m
       where m."tenant_id" = ? and m."job_id" in (${inJobs}) and m."deleted_at" is null
       group by m."job_id"`,
      params,
    ),
    em.execute<Row[]>(
      `select a."job_id",
              count(*) as "active_assets",
              count(*) filter (where a."data_bearing" = true and a."status" in ('sanitization_required', 'sanitization_in_progress')) as "awaiting_wipe",
              count(*) filter (where a."data_bearing" = true and a."status" = 'sanitized') as "sanitized",
              count(*) filter (where a."status" = 'review_required') as "failed",
              count(*) filter (where a."data_bearing" is null) as "data_bearing_unknown",
              count(*) filter (where a."data_bearing" = true and a."status" = 'sanitized' and exists (
                select 1 from "itad_certificates" c
                where c."tenant_id" = a."tenant_id" and c."organization_id" = a."organization_id"
                  and c."asset_id" = a."id" and c."status" = 'issued')) as "certified_sanitized"
       from "itad_assets" a
       where a."tenant_id" = ? and a."job_id" in (${inJobs}) and a."deleted_at" is null
       group by a."job_id"`,
      params,
    ),
    em.execute<Row[]>(
      `select s."job_id", count(*) as "unresolved_duplicates"
       from "itad_intake_scans" s
       where s."tenant_id" = ? and s."job_id" in (${inJobs}) and s."result" = 'duplicate' and s."resolved_at" is null
       group by s."job_id"`,
      params,
    ),
    em.execute<Row[]>(
      `select e."job_id",
              count(*) as "open_exceptions",
              count(*) filter (where e."type" = 'missing_from_delivery') as "open_missing",
              count(*) filter (where e."type" = 'unexpected_asset') as "open_unexpected"
       from "itad_exceptions" e
       where e."tenant_id" = ? and e."job_id" in (${inJobs}) and e."status" = 'open'
       group by e."job_id"`,
      params,
    ),
  ])

  const update = (row: Row, patch: Partial<JobOverviewSource>) => {
    const source = sources.get(String(row.job_id))
    if (source) Object.assign(source, patch)
  }
  for (const row of manifest) update(row, { activeManifestItems: num(row.active_items), matched: num(row.matched) })
  for (const row of assets) {
    update(row, {
      activeAssets: num(row.active_assets),
      awaitingWipe: num(row.awaiting_wipe),
      sanitized: num(row.sanitized),
      failed: num(row.failed),
      dataBearingUnknown: num(row.data_bearing_unknown),
      certifiedSanitized: num(row.certified_sanitized),
    })
  }
  for (const row of scans) update(row, { unresolvedDuplicates: num(row.unresolved_duplicates) })
  for (const row of exceptions) {
    update(row, {
      openExceptions: num(row.open_exceptions),
      openMissingExceptions: num(row.open_missing),
      openUnexpectedExceptions: num(row.open_unexpected),
    })
  }
  return sources
}

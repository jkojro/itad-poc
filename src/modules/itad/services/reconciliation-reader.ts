import type { EntityManager } from '@mikro-orm/postgresql'
import { summarizeReconciliation, type ReceivingFacts, type ReconciliationSummary } from '../domain/reconciliation'

/**
 * Read side of reconciliation (manifest spec "Reconciliation"): scoped SQL counts the
 * domain turns into states. Matching is on `serial_normalized` among active items and
 * active assets of the same job; nothing is stored. Pass the transaction's
 * `EntityManager` when the result guards a write (the transition command does).
 */
export type ReconciliationScope = { tenantId: string; organizationId: string }

type CountRow = {
  active_manifest_items: string | number
  active_assets: string | number
  matched: string | number
  pending_duplicates: string | number
  different_device_unresolved: string | number
}

const ACTIVE_ITEMS = `select count(*) from "itad_manifest_items" m
  where m."tenant_id" = ? and m."organization_id" = ? and m."job_id" = ? and m."deleted_at" is null`
const ACTIVE_ASSETS = `select count(*) from "itad_assets" a
  where a."tenant_id" = ? and a."organization_id" = ? and a."job_id" = ? and a."deleted_at" is null`
const MATCHED = `select count(*) from "itad_manifest_items" m
  where m."tenant_id" = ? and m."organization_id" = ? and m."job_id" = ? and m."deleted_at" is null
    and exists (select 1 from "itad_assets" a
      where a."tenant_id" = m."tenant_id" and a."organization_id" = m."organization_id" and a."job_id" = m."job_id"
        and a."serial_normalized" = m."serial_normalized" and a."deleted_at" is null)`
const PENDING_DUPLICATES = (flagged: boolean) => `select count(*) from "itad_intake_scans" s
  where s."tenant_id" = ? and s."organization_id" = ? and s."job_id" = ?
    and s."result" = 'duplicate' and s."resolved_at" is null
    and s."flagged_different_device_at" is ${flagged ? 'not null' : 'null'}`

async function loadCounts(em: EntityManager, scope: ReconciliationScope, jobId: string, withAssets: boolean): Promise<CountRow> {
  const params = [scope.tenantId, scope.organizationId, jobId]
  const row = await em.execute<CountRow>(
    `select (${ACTIVE_ITEMS}) as "active_manifest_items",
            ${withAssets ? `(${ACTIVE_ASSETS})` : '0'} as "active_assets",
            ${withAssets ? `(${MATCHED})` : '0'} as "matched",
            (${PENDING_DUPLICATES(false)}) as "pending_duplicates",
            (${PENDING_DUPLICATES(true)}) as "different_device_unresolved"`,
    withAssets ? [...params, ...params, ...params, ...params, ...params] : [...params, ...params, ...params],
    'get',
  )
  return row
}

/** Facts for the `receivingComplete` condition. */
export async function loadReceivingFacts(em: EntityManager, scope: ReconciliationScope, jobId: string): Promise<ReceivingFacts> {
  const row = await loadCounts(em, scope, jobId, false)
  return {
    activeManifestItems: Number(row.active_manifest_items),
    pendingDuplicates: Number(row.pending_duplicates),
    differentDeviceUnresolved: Number(row.different_device_unresolved),
  }
}

/** Job summary counters: expected, received, matched, missing, unexpected, pending duplicates. */
export async function loadReconciliationSummary(
  em: EntityManager,
  scope: ReconciliationScope,
  jobId: string,
): Promise<ReconciliationSummary> {
  const row = await loadCounts(em, scope, jobId, true)
  return summarizeReconciliation({
    activeManifestItems: Number(row.active_manifest_items),
    activeAssets: Number(row.active_assets),
    matched: Number(row.matched),
    pendingDuplicates: Number(row.pending_duplicates),
    differentDeviceUnresolved: Number(row.different_device_unresolved),
  })
}

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

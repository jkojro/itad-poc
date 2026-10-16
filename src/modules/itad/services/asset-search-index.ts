import type { EntityManager } from '@mikro-orm/postgresql'
import { ITAD_ASSET_ENTITY_ID } from '../lib/constants'

/**
 * Keeps ITAD assets in the platform's global search (operations dashboard spec "Global
 * search", Q6): the asset row is projected by `query_index` (which the token strategy and
 * the search-time presenter read) through `query_index.upsert_one`, and removed through
 * `query_index.delete_one`. Only identifiers are tokenized — serial, tag, manufacturer,
 * model and job reference — never the status, which is shown only where it is read live.
 */
type EventBus = { emitEvent: (name: string, body: unknown, options?: unknown) => Promise<void> }
type Resolver = { resolve: <T = unknown>(name: string) => T }

type AssetSearchRow = {
  id: string
  organization_id: string
  serial: string
  serial_normalized: string
  customer_asset_tag: string | null
  manufacturer: string | null
  model: string | null
  deleted_at: Date | string | null
  job_reference: string
}

/** The asset with its job reference, also when removed (`deleted_at` set). */
async function loadAssetSearchRow(em: EntityManager, tenantId: string, assetId: string): Promise<AssetSearchRow | null> {
  const row = await em.execute<AssetSearchRow>(
    `select a."id", a."organization_id", a."serial", a."serial_normalized", a."customer_asset_tag", a."manufacturer", a."model",
            a."deleted_at", j."internal_reference" as "job_reference"
     from "itad_assets" a join "itad_jobs" j on j."id" = a."job_id" and j."tenant_id" = a."tenant_id"
     where a."tenant_id" = ? and a."id" = ?`,
    [tenantId, assetId],
    'get',
  )
  return row ?? null
}

/** The identifiers the global search matches on; the status is deliberately absent. */
export function assetSearchTokenDoc(row: Pick<AssetSearchRow, 'serial' | 'serial_normalized' | 'customer_asset_tag' | 'manufacturer' | 'model' | 'job_reference'>) {
  return {
    serial: row.serial,
    serial_normalized: row.serial_normalized,
    customer_asset_tag: row.customer_asset_tag ?? null,
    manufacturer: row.manufacturer ?? null,
    model: row.model ?? null,
    job_reference: row.job_reference,
  }
}

/** Re-projects one asset into the search index, or removes it when the asset is removed. */
export async function refreshAssetSearchIndex(
  ctx: Resolver,
  input: { assetId: string; tenantId: string; crudAction?: 'created' | 'updated' },
): Promise<void> {
  let eventBus: EventBus
  let em: EntityManager
  try {
    eventBus = ctx.resolve<EventBus>('eventBus')
    em = ctx.resolve<EntityManager>('em').fork()
  } catch {
    return
  }
  const row = await loadAssetSearchRow(em, input.tenantId, input.assetId)
  if (!row) return
  const scope = { tenantId: input.tenantId, organizationId: row.organization_id }
  if (row.deleted_at) {
    await eventBus
      .emitEvent('query_index.delete_one', { entityType: ITAD_ASSET_ENTITY_ID, recordId: row.id, ...scope }, scope)
      .catch(() => undefined)
    return
  }
  await eventBus
    .emitEvent(
      'query_index.upsert_one',
      {
        entityType: ITAD_ASSET_ENTITY_ID,
        recordId: row.id,
        ...scope,
        crudAction: input.crudAction ?? 'updated',
        searchTokenDoc: assetSearchTokenDoc(row),
      },
      scope,
    )
    .catch(() => undefined)
}

/** Every active asset of a tenant (optionally one organization), for the backfill command. */
export async function listAssetIdsForSearch(em: EntityManager, tenantId: string, organizationId?: string | null): Promise<string[]> {
  const rows = await em.execute<Array<{ id: string }>>(
    `select "id" from "itad_assets" where "tenant_id" = ? and "deleted_at" is null${organizationId ? ' and "organization_id" = ?' : ''} order by "created_at"`,
    organizationId ? [tenantId, organizationId] : [tenantId],
  )
  return rows.map((row) => row.id)
}

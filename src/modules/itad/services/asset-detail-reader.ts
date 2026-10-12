import type { EntityManager } from '@mikro-orm/postgresql'
import type { TimelineSources } from '../domain/asset-timeline'
import type { ItadDataBearingSource } from '../domain/data-bearing'
import type { ItadAssetStatus, ItadScanResult } from '../domain/job-types'

/**
 * Read side of the Asset detail page (exceptions spec "Asset detail", "Business
 * timeline"): the device with its reconciliation, and the timeline source rows. Scoped
 * SQL over records the module already keeps; nothing is written.
 */
export type DetailScope = { tenantId: string; organizationId: string }

export type AssetDetailRow = {
  id: string
  serial: string
  customer_asset_tag: string | null
  manufacturer: string | null
  model: string | null
  data_bearing: boolean | null
  data_bearing_source: ItadDataBearingSource | null
  status: ItadAssetStatus
  received_at: Date | string
  received_by_user_id: string
  deleted_at: Date | string | null
  deleted_by_user_id: string | null
  delete_reason: string | null
  updated_at: Date | string
  manifest_item_id: string | null
  open_exceptions: string | number
}

export async function loadAssetDetail(em: EntityManager, scope: DetailScope, jobId: string, assetId: string): Promise<AssetDetailRow | null> {
  const row = await em.execute<AssetDetailRow>(
    `select a."id", a."serial", a."customer_asset_tag", a."manufacturer", a."model", a."data_bearing", a."data_bearing_source",
            a."status", a."received_at", a."received_by_user_id", a."deleted_at", a."deleted_by_user_id", a."delete_reason", a."updated_at",
            (select m."id" from "itad_manifest_items" m
              where m."tenant_id" = a."tenant_id" and m."organization_id" = a."organization_id" and m."job_id" = a."job_id"
                and m."serial_normalized" = a."serial_normalized" and m."deleted_at" is null limit 1) as "manifest_item_id",
            (select count(*) from "itad_exceptions" e
              where e."tenant_id" = a."tenant_id" and e."asset_id" = a."id" and e."status" = 'open') as "open_exceptions"
     from "itad_assets" a
     where a."tenant_id" = ? and a."organization_id" = ? and a."job_id" = ? and a."id" = ?`,
    [scope.tenantId, scope.organizationId, jobId, assetId],
    'get',
  )
  return row ?? null
}

const toDate = (value: Date | string | null): Date | null => (value ? new Date(value) : null)

/** Every row the timeline needs, read in a few scoped queries (one connection, sequential). */
export async function loadTimelineSources(
  em: EntityManager,
  scope: DetailScope,
  jobId: string,
  asset: AssetDetailRow,
): Promise<TimelineSources> {
  const params = [scope.tenantId, scope.organizationId, jobId, asset.id]
  const firstScan = await em.execute<{ result: ItadScanResult }>(
    `select "result" from "itad_intake_scans"
     where "tenant_id" = ? and "organization_id" = ? and "job_id" = ? and "asset_id" = ? and "result" <> 'duplicate'
     order by "scanned_at" asc, "id" asc limit 1`,
    params,
    'get',
  )
  const duplicates = await em.execute<
    Array<{
      scanned_at: Date | string
      scanned_by_user_id: string
      resolution: string | null
      resolution_note: string | null
      resolved_at: Date | string | null
      resolved_by_user_id: string | null
      flagged_different_device_at: Date | string | null
      flagged_different_device_by_user_id: string | null
      flagged_different_device_note: string | null
    }>
  >(
    `select "scanned_at", "scanned_by_user_id", "resolution", "resolution_note", "resolved_at", "resolved_by_user_id",
            "flagged_different_device_at", "flagged_different_device_by_user_id", "flagged_different_device_note"
     from "itad_intake_scans"
     where "tenant_id" = ? and "organization_id" = ? and "job_id" = ? and "asset_id" = ? and "result" = 'duplicate'
     order by "scanned_at" asc, "id" asc`,
    params,
  )
  const transitions = await em.execute<
    Array<{
      created_at: Date | string
      action: TimelineSources['transitions'][number]['action']
      from_status: TimelineSources['transitions'][number]['fromStatus']
      to_status: TimelineSources['transitions'][number]['toStatus']
      data_bearing_from: boolean | null
      data_bearing_to: boolean | null
      reason: string | null
      actor_user_id: string | null
      run_method: TimelineSources['transitions'][number]['runMethod']
      run_tool: string | null
    }>
  >(
    `select t."created_at", t."action", t."from_status", t."to_status", t."data_bearing_from", t."data_bearing_to", t."reason",
            t."actor_user_id", r."method" as "run_method", r."tool" as "run_tool"
     from "itad_asset_status_transitions" t
     left join "itad_sanitization_runs" r on r."id" = t."run_id"
     where t."tenant_id" = ? and t."organization_id" = ? and t."job_id" = ? and t."asset_id" = ?
     order by t."created_at" asc, t."id" asc`,
    params,
  )
  const exceptionEvents = await em.execute<
    Array<{
      created_at: Date | string
      kind: TimelineSources['exceptionEvents'][number]['kind']
      type: TimelineSources['exceptionEvents'][number]['exceptionType']
      assigned_to_user_id: string | null
      outcome: TimelineSources['exceptionEvents'][number]['outcome']
      reason: string | null
      actor_user_id: string | null
    }>
  >(
    `select ev."created_at", ev."kind", e."type", ev."assigned_to_user_id", ev."outcome", ev."reason", ev."actor_user_id"
     from "itad_exception_events" ev
     join "itad_exceptions" e on e."id" = ev."exception_id"
     where e."tenant_id" = ? and e."organization_id" = ? and e."job_id" = ? and e."asset_id" = ?
     order by ev."created_at" asc, ev."id" asc`,
    params,
  )
  const jobTransitions = await em.execute<Array<{ created_at: Date | string; action: string; reason: string | null; actor_user_id: string }>>(
    `select "created_at", "action", "reason", "actor_user_id" from "itad_job_status_transitions"
     where "tenant_id" = ? and "organization_id" = ? and "job_id" = ? and "action" in ('start_processing', 'complete', 'cancel')
     order by "created_at" asc, "id" asc`,
    [scope.tenantId, scope.organizationId, jobId],
  )
  return {
    asset: {
      receivedAt: new Date(asset.received_at),
      receivedByUserId: asset.received_by_user_id,
      firstScanResult: firstScan?.result ?? null,
      dataBearingSource: asset.data_bearing_source,
      deletedAt: toDate(asset.deleted_at),
      deletedByUserId: asset.deleted_by_user_id,
      deleteReason: asset.delete_reason,
    },
    duplicateScans: duplicates.map((row) => ({
      scannedAt: new Date(row.scanned_at),
      scannedByUserId: row.scanned_by_user_id,
      resolution: row.resolution,
      resolutionNote: row.resolution_note,
      resolvedAt: toDate(row.resolved_at),
      resolvedByUserId: row.resolved_by_user_id,
      flaggedAt: toDate(row.flagged_different_device_at),
      flaggedByUserId: row.flagged_different_device_by_user_id,
      flaggedNote: row.flagged_different_device_note,
    })),
    transitions: transitions.map((row) => ({
      createdAt: new Date(row.created_at),
      action: row.action,
      fromStatus: row.from_status,
      toStatus: row.to_status,
      dataBearingFrom: row.data_bearing_from,
      dataBearingTo: row.data_bearing_to,
      reason: row.reason,
      actorUserId: row.actor_user_id,
      runMethod: row.run_method,
      runTool: row.run_tool,
    })),
    exceptionEvents: exceptionEvents.map((row) => ({
      createdAt: new Date(row.created_at),
      kind: row.kind,
      exceptionType: row.type,
      assignedToUserId: row.assigned_to_user_id,
      outcome: row.outcome,
      reason: row.reason,
      actorUserId: row.actor_user_id,
    })),
    jobTransitions: jobTransitions.map((row) => ({
      createdAt: new Date(row.created_at),
      action: row.action,
      reason: row.reason,
      actorUserId: row.actor_user_id,
    })),
  }
}

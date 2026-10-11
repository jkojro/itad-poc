import type { EntityManager } from '@mikro-orm/postgresql'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import type { ItadExceptionEventKind, ItadExceptionOutcome, ItadExceptionStatus, ItadExceptionType } from '../domain/exceptions'
import { loadUserDisplayNames } from '../module-integrations/users'

/** Read model of the exceptions of a job (list and detail routes). */
type Actor = { id: string; name: string | null } | null

export type ExceptionListItem = {
  id: string
  type: ItadExceptionType
  status: ItadExceptionStatus
  serial: string
  assetId: string | null
  manifestItemId: string | null
  intakeScanId: string | null
  sanitizationRunId: string | null
  /** Short source context: e.g. the duplicate flag or the failed run's tool. */
  context: { flaggedDifferentDevice?: boolean; scanResolution?: string | null; runTool?: string | null; runFinishedAt?: string | null }
  assignedTo: Actor
  createdAt: string
  resolutionOutcome: ItadExceptionOutcome | null
  resolutionReason: string | null
  resolvedBy: Actor
  resolvedAt: string | null
  updatedAt: string
}

type Row = {
  id: string
  type: ItadExceptionType
  status: ItadExceptionStatus
  serial: string
  asset_id: string | null
  manifest_item_id: string | null
  intake_scan_id: string | null
  sanitization_run_id: string | null
  assigned_to_user_id: string | null
  resolution_outcome: ItadExceptionOutcome | null
  resolution_reason: string | null
  resolved_by_user_id: string | null
  resolved_at: Date | string | null
  created_at: Date | string
  updated_at: Date | string
  flagged_at: Date | string | null
  scan_resolution: string | null
  run_tool: string | null
  run_finished_at: Date | string | null
}

const iso = (value: Date | string | null) => (value ? new Date(value).toISOString() : null)

export const EXCEPTION_SELECT = `select e."id", e."type", e."status", e."serial", e."asset_id", e."manifest_item_id", e."intake_scan_id",
    e."sanitization_run_id", e."assigned_to_user_id", e."resolution_outcome", e."resolution_reason", e."resolved_by_user_id",
    e."resolved_at", e."created_at", e."updated_at",
    s."flagged_different_device_at" as "flagged_at", s."resolution" as "scan_resolution",
    r."tool" as "run_tool", r."finished_at" as "run_finished_at"
  from "itad_exceptions" e
  left join "itad_intake_scans" s on s."id" = e."intake_scan_id"
  left join "itad_sanitization_runs" r on r."id" = e."sanitization_run_id"`

export async function toExceptionItems(queryEngine: QueryEngine, tenantId: string, rows: Row[]): Promise<ExceptionListItem[]> {
  const names = await loadUserDisplayNames(
    queryEngine,
    tenantId,
    rows.flatMap((row) => [row.assigned_to_user_id, row.resolved_by_user_id]),
  )
  const actor = (id: string | null): Actor => (id ? { id, name: names.get(id) ?? null } : null)
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    status: row.status,
    serial: row.serial,
    assetId: row.asset_id,
    manifestItemId: row.manifest_item_id,
    intakeScanId: row.intake_scan_id,
    sanitizationRunId: row.sanitization_run_id,
    context: {
      ...(row.intake_scan_id ? { flaggedDifferentDevice: Boolean(row.flagged_at), scanResolution: row.scan_resolution } : {}),
      ...(row.sanitization_run_id ? { runTool: row.run_tool, runFinishedAt: iso(row.run_finished_at) } : {}),
    },
    assignedTo: actor(row.assigned_to_user_id),
    createdAt: iso(row.created_at)!,
    resolutionOutcome: row.resolution_outcome,
    resolutionReason: row.resolution_reason,
    resolvedBy: actor(row.resolved_by_user_id),
    resolvedAt: iso(row.resolved_at),
    updatedAt: iso(row.updated_at)!,
  }))
}

export type ExceptionEventItem = {
  id: string
  kind: ItadExceptionEventKind
  assignedTo: Actor
  previousAssignedTo: Actor
  outcome: ItadExceptionOutcome | null
  reason: string | null
  actor: Actor
  createdAt: string
}

export async function loadExceptionEvents(
  em: EntityManager,
  queryEngine: QueryEngine,
  scope: { tenantId: string; organizationId: string },
  exceptionId: string,
): Promise<ExceptionEventItem[]> {
  const rows = await em.execute<
    Array<{
      id: string
      kind: ItadExceptionEventKind
      assigned_to_user_id: string | null
      previous_assigned_to_user_id: string | null
      outcome: ItadExceptionOutcome | null
      reason: string | null
      actor_user_id: string | null
      created_at: Date | string
    }>
  >(
    `select "id", "kind", "assigned_to_user_id", "previous_assigned_to_user_id", "outcome", "reason", "actor_user_id", "created_at"
     from "itad_exception_events" where "tenant_id" = ? and "organization_id" = ? and "exception_id" = ?
     order by "created_at" asc, "id" asc`,
    [scope.tenantId, scope.organizationId, exceptionId],
  )
  const names = await loadUserDisplayNames(
    queryEngine,
    scope.tenantId,
    rows.flatMap((row) => [row.assigned_to_user_id, row.previous_assigned_to_user_id, row.actor_user_id]),
  )
  const actor = (id: string | null): Actor => (id ? { id, name: names.get(id) ?? null } : null)
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    assignedTo: actor(row.assigned_to_user_id),
    previousAssignedTo: actor(row.previous_assigned_to_user_id),
    outcome: row.outcome,
    reason: row.reason,
    actor: actor(row.actor_user_id),
    createdAt: iso(row.created_at)!,
  }))
}

export type ExceptionRow = Row

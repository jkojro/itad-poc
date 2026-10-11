import { Entity, Index, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy'
import type { ItadDataBearingSource } from '../domain/data-bearing'
import type {
  ItadAssetHistoryStatus,
  ItadAssetStatus,
  ItadAssetTransitionAction,
  ItadJobStatus,
  ItadScanResolution,
  ItadScanResult,
} from '../domain/job-types'
import type { ManifestFieldMapping, RowWarningCode, SourceDataEntry } from '../domain/manifest-mapping'

/**
 * One unit of ITAD work for one customer company.
 *
 * `customerId` is a plain uuid of a `customers:customer_entity` (kind `company`);
 * cross-module ORM relations are banned, so the company is resolved through the
 * query engine at read time.
 *
 * `status` and the hold/system timestamps are never written through CRUD: the
 * transition command (spec Phase 2) is their only writer.
 */
@Entity({ tableName: 'itad_jobs' })
@Unique({
  name: 'itad_jobs_internal_reference_unique',
  properties: ['tenantId', 'organizationId', 'internalReference'],
})
@Index({ name: 'itad_jobs_scope_status_idx', properties: ['tenantId', 'organizationId', 'status'] })
@Index({ name: 'itad_jobs_scope_customer_idx', properties: ['tenantId', 'organizationId', 'customerId'] })
// Case-insensitive, scoped uniqueness that a soft-deleted draft releases.
// Cancelled jobs keep the value reserved because they are not soft-deleted.
@Index({
  name: 'itad_jobs_customer_reference_unique',
  expression:
    'create unique index "itad_jobs_customer_reference_unique" on "itad_jobs" ("tenant_id", "organization_id", lower("customer_reference")) where "deleted_at" is null and "customer_reference" is not null',
})
export class ItadJob {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'customer_id', type: 'uuid' })
  customerId!: string

  @Property({ name: 'internal_reference', type: 'text' })
  internalReference!: string

  @Property({ name: 'customer_reference', type: 'text', nullable: true })
  customerReference?: string | null

  @Property({ type: 'text' })
  name!: string

  @Property({ type: 'text', default: 'draft' })
  status: ItadJobStatus = 'draft'

  @Property({ name: 'status_before_hold', type: 'text', nullable: true })
  statusBeforeHold?: ItadJobStatus | null

  @Property({ name: 'held_at', type: Date, nullable: true })
  heldAt?: Date | null

  @Property({ name: 'held_by_user_id', type: 'uuid', nullable: true })
  heldByUserId?: string | null

  @Property({ name: 'hold_reason', type: 'text', nullable: true })
  holdReason?: string | null

  @Property({ name: 'expected_asset_estimate', type: 'integer', nullable: true })
  expectedAssetEstimate?: number | null

  /**
   * `dataBearing` applied to devices scanned after it is set when the manifest gives no
   * value (sanitization spec REQ-303). `null` = no default.
   */
  @Property({ name: 'default_data_bearing', type: 'boolean', nullable: true })
  defaultDataBearing?: boolean | null

  @Property({ name: 'scheduled_pickup_at', type: Date, nullable: true })
  scheduledPickupAt?: Date | null

  @Property({ name: 'started_at', type: Date, nullable: true })
  startedAt?: Date | null

  @Property({ name: 'completed_at', type: Date, nullable: true })
  completedAt?: Date | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

/**
 * Per-organization, per-year counter behind `ItadJob.internalReference`.
 *
 * Allocated with a single `insert … on conflict do update … returning` inside the
 * job-create transaction, so a rolled-back create also rolls back its increment and
 * an issued number is never handed out twice. Exempt from the editable-entity
 * optimistic-lock rule: no user edits it.
 */
@Entity({ tableName: 'itad_reference_sequences' })
@Unique({
  name: 'itad_reference_sequences_scope_unique',
  properties: ['tenantId', 'organizationId', 'kind', 'year'],
})
export class ItadReferenceSequence {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ type: 'text' })
  kind!: string

  @Property({ type: 'integer' })
  year!: number

  @Property({ name: 'last_value', type: 'integer', default: 0 })
  lastValue: number = 0

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

/**
 * Domain history of a job's lifecycle (spec "History vs. audit log"): one append-only
 * row per transition, shown to operators. Never updated or deleted; business history is
 * never reconstructed from the platform `audit_logs`.
 */
@Entity({ tableName: 'itad_job_status_transitions' })
@Index({
  name: 'itad_job_status_transitions_scope_job_idx',
  properties: ['tenantId', 'organizationId', 'job', 'createdAt'],
})
export class ItadJobStatusTransition {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @ManyToOne(() => ItadJob, { fieldName: 'job_id' })
  job!: ItadJob

  @Property({ type: 'text' })
  action!: string

  @Property({ name: 'from_status', type: 'text' })
  fromStatus!: ItadJobStatus

  @Property({ name: 'to_status', type: 'text' })
  toStatus!: ItadJobStatus

  @Property({ type: 'text', nullable: true })
  reason?: string | null

  @Property({ name: 'actor_user_id', type: 'uuid' })
  actorUserId!: string

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()
}

/**
 * Audited manual confirmation of an operational condition, created atomically with the
 * transition it enabled. Append-only.
 */
@Entity({ tableName: 'itad_job_condition_confirmations' })
@Index({
  name: 'itad_job_condition_confirmations_scope_job_idx',
  properties: ['tenantId', 'organizationId', 'job'],
})
export class ItadJobConditionConfirmation {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @ManyToOne(() => ItadJob, { fieldName: 'job_id' })
  job!: ItadJob

  @ManyToOne(() => ItadJobStatusTransition, { fieldName: 'transition_id' })
  transition!: ItadJobStatusTransition

  @Property({ type: 'text' })
  condition!: string

  @Property({ type: 'text' })
  comment!: string

  @Property({ name: 'confirmed_by_user_id', type: 'uuid' })
  confirmedByUserId!: string

  @Property({ name: 'confirmed_at', type: Date, onCreate: () => new Date() })
  confirmedAt: Date = new Date()
}

export type ManifestImportMapping = { fields: ManifestFieldMapping; unused: string[] }

/**
 * One committed manifest file import (spec "Data Models"). Append-only. The original
 * file lives in the installed `attachments` module (owner `itad:itad_manifest_import` /
 * this id), referenced by `attachmentId` only. Identity = job + file hash + sheet, so a
 * double submit is rejected while other sheets of a workbook stay importable.
 */
@Entity({ tableName: 'itad_manifest_imports' })
@Index({
  name: 'itad_manifest_imports_scope_job_idx',
  properties: ['tenantId', 'organizationId', 'job', 'createdAt'],
})
@Index({
  name: 'itad_manifest_imports_file_unique',
  expression:
    'create unique index "itad_manifest_imports_file_unique" on "itad_manifest_imports" ("tenant_id", "organization_id", "job_id", "file_sha256", coalesce("sheet_name", \'\'))',
})
export class ItadManifestImport {
  @PrimaryKey({ type: 'uuid' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @ManyToOne(() => ItadJob, { fieldName: 'job_id' })
  job!: ItadJob

  @Property({ name: 'attachment_id', type: 'uuid' })
  attachmentId!: string

  @Property({ name: 'file_name', type: 'text' })
  fileName!: string

  @Property({ name: 'mime_type', type: 'text' })
  mimeType!: string

  @Property({ name: 'file_size', type: 'integer' })
  fileSize!: number

  @Property({ name: 'file_sha256', type: 'text' })
  fileSha256!: string

  @Property({ type: 'text' })
  format!: 'csv' | 'xlsx'

  @Property({ name: 'sheet_name', type: 'text', nullable: true })
  sheetName?: string | null

  @Property({ name: 'source_columns', type: 'jsonb' })
  sourceColumns!: string[]

  @Property({ type: 'jsonb' })
  mapping!: ManifestImportMapping

  @Property({ type: 'jsonb' })
  warnings: Array<{ code: RowWarningCode; row: number; column?: string }> = []

  @Property({ name: 'accepted_warnings_by_user_id', type: 'uuid', nullable: true })
  acceptedWarningsByUserId?: string | null

  @Property({ name: 'total_rows', type: 'integer' })
  totalRows!: number

  @Property({ name: 'imported_count', type: 'integer' })
  importedCount!: number

  @Property({ name: 'skipped_count', type: 'integer' })
  skippedCount!: number

  @Property({ name: 'blank_count', type: 'integer' })
  blankCount!: number

  @Property({ name: 'skipped_rows', type: 'jsonb' })
  skippedRows: Array<{ row: number; serial: string }> = []

  @Property({ name: 'job_status_at_change', type: 'text' })
  jobStatusAtChange!: ItadJobStatus

  @Property({ name: 'imported_by_user_id', type: 'uuid' })
  importedByUserId!: string

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()
}

/**
 * One expected device from a customer manifest. `serialNormalized` is unique per job
 * among active items. `sourceData` holds every column of the source row as parsed
 * logical values; it is immutable and belongs to the import that created the item.
 */
@Entity({ tableName: 'itad_manifest_items' })
@Index({
  name: 'itad_manifest_items_scope_job_idx',
  properties: ['tenantId', 'organizationId', 'job', 'deletedAt'],
})
@Index({
  name: 'itad_manifest_items_serial_unique',
  expression:
    'create unique index "itad_manifest_items_serial_unique" on "itad_manifest_items" ("tenant_id", "organization_id", "job_id", "serial_normalized") where "deleted_at" is null',
})
export class ItadManifestItem {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @ManyToOne(() => ItadJob, { fieldName: 'job_id' })
  job!: ItadJob

  @ManyToOne(() => ItadManifestImport, { fieldName: 'import_id' })
  manifestImport!: ItadManifestImport

  @Property({ name: 'source_row', type: 'integer' })
  sourceRow!: number

  @Property({ type: 'text' })
  serial!: string

  @Property({ name: 'serial_normalized', type: 'text' })
  serialNormalized!: string

  @Property({ name: 'customer_asset_tag', type: 'text', nullable: true })
  customerAssetTag?: string | null

  @Property({ type: 'text', nullable: true })
  manufacturer?: string | null

  @Property({ type: 'text', nullable: true })
  model?: string | null

  /** Explicit "carries data" value from a mapped column; `null` = the file gave none. */
  @Property({ name: 'data_bearing', type: 'boolean', nullable: true })
  dataBearing?: boolean | null

  @Property({ name: 'source_data', type: 'jsonb' })
  sourceData!: SourceDataEntry[]

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null

  @Property({ name: 'deleted_by_user_id', type: 'uuid', nullable: true })
  deletedByUserId?: string | null

  @Property({ name: 'delete_reason', type: 'text', nullable: true })
  deleteReason?: string | null

  @Property({ name: 'delete_job_status', type: 'text', nullable: true })
  deleteJobStatus?: ItadJobStatus | null
}

/**
 * One physically received device (manifest spec "Receiving scan"). Created by the first
 * scan of a serial in a job; `serialNormalized` is unique per job among active assets.
 * Its manifest match is derived at read time from the serial, never stored. Later
 * epics (erasure, grading, certificates) attach to it through same-module relations.
 */
@Entity({ tableName: 'itad_assets' })
@Index({
  name: 'itad_assets_scope_job_idx',
  properties: ['tenantId', 'organizationId', 'job', 'deletedAt'],
})
// Cross-job serial lookup (exact or prefix) within one organization (manifest spec REQ-107).
@Index({
  name: 'itad_assets_serial_lookup_idx',
  expression:
    'create index "itad_assets_serial_lookup_idx" on "itad_assets" ("tenant_id", "organization_id", "serial_normalized" text_pattern_ops) where "deleted_at" is null',
})
@Index({
  name: 'itad_assets_scope_job_status_idx',
  expression:
    'create index "itad_assets_scope_job_status_idx" on "itad_assets" ("tenant_id", "organization_id", "job_id", "status") where "deleted_at" is null',
})
@Index({
  name: 'itad_assets_serial_unique',
  expression:
    'create unique index "itad_assets_serial_unique" on "itad_assets" ("tenant_id", "organization_id", "job_id", "serial_normalized") where "deleted_at" is null',
})
export class ItadAsset {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @ManyToOne(() => ItadJob, { fieldName: 'job_id' })
  job!: ItadJob

  @Property({ type: 'text' })
  serial!: string

  @Property({ name: 'serial_normalized', type: 'text' })
  serialNormalized!: string

  @Property({ name: 'customer_asset_tag', type: 'text', nullable: true })
  customerAssetTag?: string | null

  @Property({ type: 'text', nullable: true })
  manufacturer?: string | null

  @Property({ type: 'text', nullable: true })
  model?: string | null

  /**
   * `null` = not yet determined whether the device carries data. Resolved once at the
   * scan and owned by the asset from then on (sanitization spec "Snapshot rule").
   */
  @Property({ name: 'data_bearing', type: 'boolean', nullable: true })
  dataBearing?: boolean | null

  @Property({ name: 'data_bearing_source', type: 'text', nullable: true })
  dataBearingSource?: ItadDataBearingSource | null

  /** `null` when decided by the system at the scan. */
  @Property({ name: 'data_bearing_decided_by_user_id', type: 'uuid', nullable: true })
  dataBearingDecidedByUserId?: string | null

  @Property({ name: 'data_bearing_decided_at', type: Date, nullable: true })
  dataBearingDecidedAt?: Date | null

  @Property({ type: 'text', default: 'received' })
  status: ItadAssetStatus = 'received'

  /** First entry into `sanitization_required`; guards the one-time event. */
  @Property({ name: 'sanitization_required_at', type: Date, nullable: true })
  sanitizationRequiredAt?: Date | null

  @Property({ name: 'received_at', type: Date })
  receivedAt!: Date

  @Property({ name: 'received_by_user_id', type: 'uuid' })
  receivedByUserId!: string

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  /** Optimistic-lock version for asset edits and deletes. */
  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null

  @Property({ name: 'deleted_by_user_id', type: 'uuid', nullable: true })
  deletedByUserId?: string | null

  @Property({ name: 'delete_reason', type: 'text', nullable: true })
  deleteReason?: string | null
}

/**
 * Log of every receiving scan. `result` is what the operator saw at scan time. A
 * `duplicate` scan created no asset and stays pending until `resolvedAt` is set; the
 * different-device flag keeps it pending (blocking) and remains as history.
 */
@Entity({ tableName: 'itad_intake_scans' })
@Index({
  name: 'itad_intake_scans_scope_job_idx',
  properties: ['tenantId', 'organizationId', 'job', 'scannedAt'],
})
@Index({
  name: 'itad_intake_scans_pending_duplicates_idx',
  expression:
    'create index "itad_intake_scans_pending_duplicates_idx" on "itad_intake_scans" ("tenant_id", "organization_id", "job_id") where "result" = \'duplicate\' and "resolved_at" is null',
})
export class ItadIntakeScan {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @ManyToOne(() => ItadJob, { fieldName: 'job_id' })
  job!: ItadJob

  /** The created asset, or the already registered one for a `duplicate`. */
  @ManyToOne(() => ItadAsset, { fieldName: 'asset_id' })
  asset!: ItadAsset

  /** Manifest item matched at scan time (history only; reconciliation is derived). */
  @ManyToOne(() => ItadManifestItem, { fieldName: 'manifest_item_id', nullable: true })
  manifestItem?: ItadManifestItem | null

  @Property({ name: 'raw_serial', type: 'text' })
  rawSerial!: string

  @Property({ name: 'serial_normalized', type: 'text' })
  serialNormalized!: string

  @Property({ type: 'text' })
  result!: ItadScanResult

  @Property({ name: 'scanned_by_user_id', type: 'uuid' })
  scannedByUserId!: string

  @Property({ name: 'scanned_at', type: Date })
  scannedAt!: Date

  @Property({ type: 'text', nullable: true })
  resolution?: ItadScanResolution | null

  @Property({ name: 'resolution_note', type: 'text', nullable: true })
  resolutionNote?: string | null

  @Property({ name: 'resolved_by_user_id', type: 'uuid', nullable: true })
  resolvedByUserId?: string | null

  @Property({ name: 'resolved_at', type: Date, nullable: true })
  resolvedAt?: Date | null

  @Property({ name: 'flagged_different_device_at', type: Date, nullable: true })
  flaggedDifferentDeviceAt?: Date | null

  @Property({ name: 'flagged_different_device_by_user_id', type: 'uuid', nullable: true })
  flaggedDifferentDeviceByUserId?: string | null

  @Property({ name: 'flagged_different_device_note', type: 'text', nullable: true })
  flaggedDifferentDeviceNote?: string | null
}

/**
 * Append-only history of an asset's status and `dataBearing` decisions (sanitization
 * spec "ItadAssetStatusTransition"). Statuses come from `ITAD_ASSET_HISTORY_STATUSES`, so
 * the transition state `sanitization_failed` may appear here and nowhere else.
 * `fromStatus` is `null` for the decision made at the scan; `actorUserId` is `null`
 * when the system decided.
 */
@Entity({ tableName: 'itad_asset_status_transitions' })
@Index({
  name: 'itad_asset_status_transitions_asset_idx',
  properties: ['tenantId', 'organizationId', 'asset', 'createdAt'],
})
export class ItadAssetStatusTransition {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @ManyToOne(() => ItadJob, { fieldName: 'job_id' })
  job!: ItadJob

  @ManyToOne(() => ItadAsset, { fieldName: 'asset_id' })
  asset!: ItadAsset

  @Property({ type: 'text' })
  action!: ItadAssetTransitionAction

  @Property({ name: 'from_status', type: 'text', nullable: true })
  fromStatus?: ItadAssetHistoryStatus | null

  @Property({ name: 'to_status', type: 'text' })
  toStatus!: ItadAssetHistoryStatus

  @Property({ name: 'data_bearing_from', type: 'boolean', nullable: true })
  dataBearingFrom?: boolean | null

  @Property({ name: 'data_bearing_to', type: 'boolean', nullable: true })
  dataBearingTo?: boolean | null

  @Property({ type: 'text', nullable: true })
  reason?: string | null

  @Property({ name: 'actor_user_id', type: 'uuid', nullable: true })
  actorUserId?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()
}

import { Entity, Index, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy'

export const ITAD_JOB_STATUSES = [
  'draft',
  'scheduled',
  'in_transit',
  'receiving',
  'processing',
  'closeout_review',
  'completed',
  'on_hold',
  'cancelled',
] as const

export type ItadJobStatus = (typeof ITAD_JOB_STATUSES)[number]

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

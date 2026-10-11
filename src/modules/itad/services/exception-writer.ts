import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import {
  ItadAsset,
  ItadException,
  ItadExceptionEvent,
  ItadManifestItem,
  type ItadIntakeScan,
  type ItadJob,
  type ItadSanitizationRun,
} from '../data/entities'
import { exceptionSourceKey, type ItadExceptionOutcome, type ItadExceptionType } from '../domain/exceptions'

/**
 * Exception writes shared by the domain commands (exceptions spec "Creation points").
 * Plain module (module AGENTS.md "Transactions"): the caller passes its transaction's
 * EntityManager and holds the job row lock; events are emitted by the caller after
 * commit from the returned changes (read `exception.id` only after the flush — the id
 * comes from the database default).
 */
export type ExceptionChange = { kind: 'created' | 'resolved'; exception: ItadException }

type Source =
  | { type: 'missing_from_delivery'; manifestItem: ItadManifestItem }
  | { type: 'unexpected_asset'; asset: ItadAsset }
  | { type: 'duplicate_serial'; intakeScan: ItadIntakeScan; asset: ItadAsset }
  | { type: 'sanitization_failed'; run: ItadSanitizationRun; asset: ItadAsset }

function sourceKeyOf(source: Source): string {
  switch (source.type) {
    case 'missing_from_delivery':
      return exceptionSourceKey({ type: source.type, manifestItemId: source.manifestItem.id })
    case 'unexpected_asset':
      return exceptionSourceKey({ type: source.type, assetId: source.asset.id })
    case 'duplicate_serial':
      return exceptionSourceKey({ type: source.type, intakeScanId: source.intakeScan.id })
    case 'sanitization_failed':
      return exceptionSourceKey({ type: source.type, runId: source.run.id })
  }
}

/**
 * Opens the exception of one source occurrence, unless one already exists for its key in
 * any status (E4-014). The source record must already have its id (flush it first when
 * it was created in the same transaction).
 */
export async function openException(
  tx: EntityManager,
  input: { job: ItadJob; source: Source; now: Date },
): Promise<ExceptionChange | null> {
  const { job, source, now } = input
  const sourceKey = sourceKeyOf(source)
  const existing = await tx.findOne(ItadException, {
    tenantId: job.tenantId,
    organizationId: job.organizationId,
    sourceKey,
  } as FilterQuery<ItadException>)
  if (existing) return null
  return createException(tx, job, source, sourceKey, now)
}

function createException(tx: EntityManager, job: ItadJob, source: Source, sourceKey: string, now: Date): ExceptionChange {
  const exception = tx.create(ItadException, {
    tenantId: job.tenantId,
    organizationId: job.organizationId,
    job,
    type: source.type as ItadExceptionType,
    status: 'open',
    sourceKey,
    asset: 'asset' in source ? source.asset : null,
    manifestItem: source.type === 'missing_from_delivery' ? source.manifestItem : null,
    intakeScan: source.type === 'duplicate_serial' ? source.intakeScan : null,
    sanitizationRun: source.type === 'sanitization_failed' ? source.run : null,
    serial: source.type === 'missing_from_delivery' ? source.manifestItem.serial : source.asset.serial,
    createdAt: now,
    updatedAt: now,
  })
  tx.persist(exception)
  tx.persist(
    tx.create(ItadExceptionEvent, {
      tenantId: job.tenantId,
      organizationId: job.organizationId,
      job,
      exception,
      kind: 'created',
      actorUserId: null,
      createdAt: now,
    }),
  )
  return { kind: 'created', exception }
}

/** Resolves one OPEN exception with an outcome; a resolved one is left untouched (`null`). */
export function resolveException(
  tx: EntityManager,
  input: { exception: ItadException; outcome: ItadExceptionOutcome; reason: string | null; actorUserId: string; now: Date },
): ExceptionChange | null {
  const { exception, outcome, reason, actorUserId, now } = input
  if (exception.status !== 'open') return null
  exception.status = 'resolved'
  exception.resolutionOutcome = outcome
  exception.resolutionReason = reason
  exception.resolvedByUserId = actorUserId
  exception.resolvedAt = now
  exception.updatedAt = now
  tx.persist(
    tx.create(ItadExceptionEvent, {
      tenantId: exception.tenantId,
      organizationId: exception.organizationId,
      job: exception.job,
      exception,
      kind: 'resolved',
      outcome,
      reason,
      actorUserId,
      createdAt: now,
    }),
  )
  return { kind: 'resolved', exception }
}

/** Resolves the OPEN exceptions of a job matching `where` (e.g. one scan, one asset's FAIL, all). */
export async function resolveOpenExceptions(
  tx: EntityManager,
  input: {
    job: ItadJob
    where?: Record<string, unknown>
    outcome: ItadExceptionOutcome
    reason: string | null
    actorUserId: string
    now: Date
  },
): Promise<ExceptionChange[]> {
  const { job, where, outcome, reason, actorUserId, now } = input
  const open = await tx.find(
    ItadException,
    { tenantId: job.tenantId, organizationId: job.organizationId, job: job.id, status: 'open', ...(where ?? {}) } as FilterQuery<ItadException>,
    { orderBy: { createdAt: 'asc', id: 'asc' } },
  )
  const changes: ExceptionChange[] = []
  for (const exception of open) {
    const change = resolveException(tx, { exception, outcome, reason, actorUserId, now })
    if (change) changes.push(change)
  }
  return changes
}

/**
 * Materializes MISSING_FROM_DELIVERY and UNEXPECTED_ASSET when the job leaves receiving
 * (E4-010, E4-011): active manifest items without an active asset, and active assets
 * without an active item, matched on the normalized serial as reconciliation does.
 */
export async function materializeReceivingExceptions(
  tx: EntityManager,
  input: { job: ItadJob; now: Date },
): Promise<ExceptionChange[]> {
  const { job, now } = input
  const params = [job.tenantId, job.organizationId, job.id]
  const missingIds = await tx.execute<Array<{ id: string }>>(
    `select m."id" from "itad_manifest_items" m
     where m."tenant_id" = ? and m."organization_id" = ? and m."job_id" = ? and m."deleted_at" is null
       and not exists (select 1 from "itad_assets" a where a."tenant_id" = m."tenant_id" and a."organization_id" = m."organization_id"
         and a."job_id" = m."job_id" and a."serial_normalized" = m."serial_normalized" and a."deleted_at" is null)
     order by m."source_row" asc, m."id" asc`,
    params,
  )
  const unexpectedIds = await tx.execute<Array<{ id: string }>>(
    `select a."id" from "itad_assets" a
     where a."tenant_id" = ? and a."organization_id" = ? and a."job_id" = ? and a."deleted_at" is null
       and not exists (select 1 from "itad_manifest_items" m where m."tenant_id" = a."tenant_id" and m."organization_id" = a."organization_id"
         and m."job_id" = a."job_id" and m."serial_normalized" = a."serial_normalized" and m."deleted_at" is null)
     order by a."received_at" asc, a."id" asc`,
    params,
  )
  // Sequential: one transaction, one connection.
  const items = missingIds.length
    ? await tx.find(ItadManifestItem, { id: { $in: missingIds.map((row) => row.id) } } as FilterQuery<ItadManifestItem>, { orderBy: { sourceRow: 'asc', id: 'asc' } })
    : []
  const assets = unexpectedIds.length
    ? await tx.find(ItadAsset, { id: { $in: unexpectedIds.map((row) => row.id) } } as FilterQuery<ItadAsset>, { orderBy: { receivedAt: 'asc', id: 'asc' } })
    : []
  const sources: Source[] = [
    ...items.map((manifestItem) => ({ type: 'missing_from_delivery' as const, manifestItem })),
    ...assets.map((asset) => ({ type: 'unexpected_asset' as const, asset })),
  ]
  if (sources.length === 0) return []
  // One lookup for every key; a key that already exists is never opened again (E4-014).
  const keys = sources.map(sourceKeyOf)
  const existing = await tx.find(
    ItadException,
    { tenantId: job.tenantId, organizationId: job.organizationId, sourceKey: { $in: keys } } as FilterQuery<ItadException>,
    { fields: ['sourceKey'] as never[] },
  )
  const taken = new Set(existing.map((row) => row.sourceKey))
  const changes: ExceptionChange[] = []
  for (const [index, source] of sources.entries()) {
    if (taken.has(keys[index])) continue
    changes.push(createException(tx, job, source, keys[index], now))
  }
  return changes
}

/** Assigns, reassigns or unassigns an OPEN exception, with a history row (E4-022). */
export function assignException(
  tx: EntityManager,
  input: { exception: ItadException; assignedToUserId: string | null; actorUserId: string; now: Date },
): boolean {
  const { exception, assignedToUserId, actorUserId, now } = input
  const previous = exception.assignedToUserId ?? null
  if (previous === assignedToUserId) return false
  exception.assignedToUserId = assignedToUserId
  exception.updatedAt = now
  tx.persist(
    tx.create(ItadExceptionEvent, {
      tenantId: exception.tenantId,
      organizationId: exception.organizationId,
      job: exception.job,
      exception,
      kind: assignedToUserId ? 'assigned' : 'unassigned',
      assignedToUserId,
      previousAssignedToUserId: previous,
      actorUserId,
      createdAt: now,
    }),
  )
  return true
}

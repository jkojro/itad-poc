import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import { isUniqueViolation, notFound } from '@open-mercato/shared/lib/crud/errors'
import { enforceCommandOptimisticLock } from '@open-mercato/shared/lib/crud/optimistic-lock-command'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { ItadAsset, ItadIntakeScan, ItadManifestItem, type ItadJob } from '../data/entities'
import {
  ITAD_ASSET_SYSTEM_FIELDS,
  itadAssetDeleteSchema,
  itadAssetScanSchema,
  itadAssetUpdateSchema,
  itadScanActionSchema,
  type ItadAssetDeleteInput,
  type ItadAssetScanInput,
  type ItadAssetUpdateInput,
  type ItadScanActionInput,
} from '../data/validators'
import type { ItadScanResult } from '../domain/job-types'
import {
  canFlagDifferentDevice,
  canResolveAsSameDevice,
  decideScanResult,
  isReceivingActive,
  resolveNote,
} from '../domain/receiving-rules'
import { validateSerial } from '../domain/serial'
import { emitItadEvent, type ItadEventId } from '../events'
import { assetError } from '../lib/asset-errors'
import { lockJob } from './job-lock'
import { ensureScope, loadJob, type JobScope } from './jobs'

const logger = createLogger('itad').child({ component: 'receiving' })

const ASSET_SERIAL_UNIQUE_INDEX = 'itad_assets_serial_unique'
export const ITAD_ASSET_LOCK_RESOURCE_KIND = 'itad.asset'

type Actor = { scope: JobScope; actorUserId: string; em: EntityManager }

async function resolveActor(ctx: CommandRuntimeContext): Promise<Actor> {
  const scope = await ensureScope(ctx)
  const actorUserId = ctx.auth?.sub ?? null
  if (!actorUserId) throw new Error('[internal] Receiving commands require an authenticated actor')
  return { scope, actorUserId, em: ctx.container.resolve<EntityManager>('em').fork() }
}

async function assertReceiving(job: ItadJob): Promise<void> {
  if (!isReceivingActive(job)) await assetError(409, 'receiving_not_active')
}

async function assertAssetsEditable(job: ItadJob): Promise<void> {
  if (!isReceivingActive(job)) await assetError(409, 'assets_locked')
}

/** After commit; a failed emit is logged, never undoes the committed write. */
async function emitAfterCommit(eventId: ItadEventId, payload: Record<string, unknown>, persistent = false): Promise<void> {
  try {
    await emitItadEvent(eventId, payload, persistent ? { persistent: true } : undefined)
  } catch (err) {
    logger.error(`Failed to emit ${eventId}`, { err })
  }
}

export type ItadScanResponseAsset = {
  id: string
  serial: string
  customerAssetTag: string | null
  manufacturer: string | null
  model: string | null
  deleted: boolean
}

export type ItadAssetScanResult = {
  jobId: string
  tenantId: string
  organizationId: string
  result: ItadScanResult
  scan: { id: string; rawSerial: string; scannedAt: string }
  asset: ItadScanResponseAsset
  manifestItem: { id: string; serial: string } | null
}

function toResponseAsset(asset: ItadAsset): ItadScanResponseAsset {
  return {
    id: asset.id,
    serial: asset.serial,
    customerAssetTag: asset.customerAssetTag ?? null,
    manufacturer: asset.manufacturer ?? null,
    model: asset.model ?? null,
    deleted: Boolean(asset.deletedAt),
  }
}

/**
 * Registers one receiving scan (spec "Receiving scan"). Under the job row lock: the
 * first scan of a serial creates the asset (matched or unexpected against the active
 * manifest); a repeat creates no asset and logs a pending `duplicate` scan. Every
 * accepted scan is logged. Not undoable: corrections are asset removal and duplicate
 * resolution.
 */
const scanCommand: CommandHandler<ItadAssetScanInput, ItadAssetScanResult> = {
  id: 'itad.assets.scan',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = itadAssetScanSchema.parse(rawInput)
    const serial = validateSerial(input.serial)
    if (!serial.ok) return await assetError(400, serial.code)
    const { scope, actorUserId, em } = await resolveActor(ctx)
    await loadJob(em, scope, input.jobId)

    let outcome: ItadAssetScanResult
    try {
      outcome = await em.transactional(async (tx) => {
        const job = await lockJob(tx, scope, input.jobId)
        await assertReceiving(job)
        const where = { tenantId: scope.tenantId, organizationId: scope.organizationId, job: job.id, deletedAt: null }
        const existing = await tx.findOne(ItadAsset, { ...where, serialNormalized: serial.normalized } as FilterQuery<ItadAsset>)
        const manifestItem = existing
          ? null
          : await tx.findOne(ItadManifestItem, { ...where, serialNormalized: serial.normalized } as FilterQuery<ItadManifestItem>)
        const result = decideScanResult({ activeAssetExists: Boolean(existing), manifestItemExists: Boolean(manifestItem) })
        const now = new Date()
        const asset =
          existing ??
          tx.create(ItadAsset, {
            tenantId: scope.tenantId,
            organizationId: scope.organizationId,
            job,
            serial: serial.serial,
            serialNormalized: serial.normalized,
            customerAssetTag: manifestItem?.customerAssetTag ?? null,
            manufacturer: manifestItem?.manufacturer ?? null,
            model: manifestItem?.model ?? null,
            dataBearing: null,
            status: 'received',
            receivedAt: now,
            receivedByUserId: actorUserId,
            createdAt: now,
            updatedAt: now,
          })
        if (!existing) tx.persist(asset)
        const scan = tx.create(ItadIntakeScan, {
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
          job,
          asset,
          manifestItem: manifestItem ?? null,
          rawSerial: serial.serial,
          serialNormalized: serial.normalized,
          result,
          scannedByUserId: actorUserId,
          scannedAt: now,
        })
        tx.persist(scan)
        await tx.flush()
        return {
          jobId: job.id,
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
          result,
          scan: { id: scan.id, rawSerial: scan.rawSerial, scannedAt: now.toISOString() },
          asset: toResponseAsset(asset),
          manifestItem: manifestItem ? { id: manifestItem.id, serial: manifestItem.serial } : null,
        }
      })
    } catch (err) {
      // The job lock serializes scans, so this is only a backstop.
      if (isUniqueViolation(err, ASSET_SERIAL_UNIQUE_INDEX)) return await assetError(409, 'serial_conflict')
      throw err
    }

    const base = { jobId: outcome.jobId, actorUserId, tenantId: outcome.tenantId, organizationId: outcome.organizationId }
    if (outcome.result === 'duplicate') {
      await emitAfterCommit('itad.intake_scan.duplicate_detected', { ...base, scanId: outcome.scan.id, assetId: outcome.asset.id }, true)
    } else {
      await emitAfterCommit('itad.asset.received', { ...base, assetId: outcome.asset.id, scanId: outcome.scan.id, result: outcome.result })
    }
    return outcome
  },
  buildLog: async ({ result }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('itad.audit.assets.scan', 'Receiving scan'),
      resourceKind: 'itad.intake_scan',
      resourceId: result.scan.id,
      parentResourceKind: 'itad.job',
      parentResourceId: result.jobId,
      tenantId: result.tenantId,
      organizationId: result.organizationId,
      snapshotAfter: { scanId: result.scan.id, assetId: result.asset.id, result: result.result, serial: result.asset.serial },
    }
  },
}

export type ItadScanActionResult = {
  jobId: string
  scanId: string
  assetId: string
  tenantId: string
  organizationId: string
  note: string | null
}

type ScanAction = 'resolve' | 'flag'

async function runScanAction(rawInput: unknown, ctx: CommandRuntimeContext, action: ScanAction): Promise<ItadScanActionResult> {
  const input = itadScanActionSchema.parse(rawInput)
  const note = resolveNote(input.note, action === 'flag')
  if (note === false) return await assetError(400, 'note_required')
  const { scope, actorUserId, em } = await resolveActor(ctx)
  await loadJob(em, scope, input.jobId)

  return em.transactional(async (tx) => {
    const job = await lockJob(tx, scope, input.jobId)
    await assertReceiving(job)
    const scan = await tx.findOne(
      ItadIntakeScan,
      { id: input.scanId, tenantId: scope.tenantId, organizationId: scope.organizationId, job: job.id } as FilterQuery<ItadIntakeScan>,
    )
    if (!scan) {
      const { translate } = await resolveTranslations()
      throw notFound(translate('itad.assets.errors.scan_not_found', 'Scan not found'))
    }
    const allowed = action === 'resolve' ? canResolveAsSameDevice(scan) : canFlagDifferentDevice(scan)
    if (!allowed) return await assetError(409, 'scan_not_resolvable')
    const now = new Date()
    if (action === 'resolve') {
      scan.resolution = 'same_device'
      scan.resolutionNote = note
      scan.resolvedAt = now
      scan.resolvedByUserId = actorUserId
    } else {
      scan.flaggedDifferentDeviceAt = now
      scan.flaggedDifferentDeviceByUserId = actorUserId
      scan.flaggedDifferentDeviceNote = note
    }
    await tx.flush()
    return {
      jobId: job.id,
      scanId: scan.id,
      assetId: String(scan.asset.id),
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      note,
    }
  })
}

/** Closes a pending duplicate as "the same device scanned again" (also after a mistaken flag). */
const resolveDuplicateCommand: CommandHandler<ItadScanActionInput, ItadScanActionResult> = {
  id: 'itad.assets.resolve_duplicate',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const result = await runScanAction(rawInput, ctx, 'resolve')
    await emitAfterCommit('itad.intake_scan.resolved', {
      jobId: result.jobId,
      scanId: result.scanId,
      resolution: 'same_device',
      actorUserId: ctx.auth?.sub ?? null,
      tenantId: result.tenantId,
      organizationId: result.organizationId,
    })
    return result
  },
  buildLog: async ({ result }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('itad.audit.assets.resolveDuplicate', 'Resolve duplicate scan as the same device'),
      resourceKind: 'itad.intake_scan',
      resourceId: result.scanId,
      parentResourceKind: 'itad.job',
      parentResourceId: result.jobId,
      tenantId: result.tenantId,
      organizationId: result.organizationId,
      snapshotAfter: { scanId: result.scanId, resolution: 'same_device', note: result.note },
    }
  },
}

/**
 * Records that a different physical device carries an already registered serial. The
 * scan stays pending and blocking (spec "Duplicate resolution") until the exceptions
 * mechanism registers the second device, or a "same device" correction closes it.
 */
const flagDifferentDeviceCommand: CommandHandler<ItadScanActionInput, ItadScanActionResult> = {
  id: 'itad.assets.flag_different_device',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const result = await runScanAction(rawInput, ctx, 'flag')
    await emitAfterCommit(
      'itad.intake_scan.flagged_different_device',
      {
        jobId: result.jobId,
        scanId: result.scanId,
        assetId: result.assetId,
        actorUserId: ctx.auth?.sub ?? null,
        tenantId: result.tenantId,
        organizationId: result.organizationId,
      },
      true,
    )
    return result
  },
  buildLog: async ({ result }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('itad.audit.assets.flagDifferentDevice', 'Flag duplicate scan as a different device'),
      resourceKind: 'itad.intake_scan',
      resourceId: result.scanId,
      parentResourceKind: 'itad.job',
      parentResourceId: result.jobId,
      tenantId: result.tenantId,
      organizationId: result.organizationId,
      snapshotAfter: { scanId: result.scanId, flaggedDifferentDevice: true, note: result.note },
    }
  },
}

export type ItadAssetChangeResult = {
  jobId: string
  assetId: string
  tenantId: string
  organizationId: string
  updatedAt: string
  snapshot: Record<string, unknown>
}

async function loadLockedAsset(tx: EntityManager, scope: JobScope, job: ItadJob, assetId: string): Promise<ItadAsset> {
  const asset = await tx.findOne(ItadAsset, {
    id: assetId,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    job: job.id,
    deletedAt: null,
  } as FilterQuery<ItadAsset>)
  if (!asset) {
    const { translate } = await resolveTranslations()
    throw notFound(translate('itad.assets.errors.asset_not_found', 'Asset not found'))
  }
  return asset
}

function assetSnapshot(asset: ItadAsset): Record<string, unknown> {
  return {
    id: asset.id,
    serial: asset.serial,
    customerAssetTag: asset.customerAssetTag ?? null,
    manufacturer: asset.manufacturer ?? null,
    model: asset.model ?? null,
    dataBearing: asset.dataBearing ?? null,
    status: asset.status,
  }
}

/** Edits an asset's descriptive fields while receiving; optimistic lock on the asset's `updatedAt`. */
const updateAssetCommand: CommandHandler<ItadAssetUpdateInput, ItadAssetChangeResult> = {
  id: 'itad.assets.update',
  isUndoable: false,
  async execute(rawInput, ctx) {
    if (rawInput && typeof rawInput === 'object') {
      const present = ITAD_ASSET_SYSTEM_FIELDS.find((field) => field in (rawInput as Record<string, unknown>))
      if (present) return await assetError(400, 'field_not_writable', { [present]: 'not writable' })
    }
    const input = itadAssetUpdateSchema.parse(rawInput)
    const { scope, actorUserId, em } = await resolveActor(ctx)
    await loadJob(em, scope, input.jobId)

    const result = await em.transactional(async (tx) => {
      const job = await lockJob(tx, scope, input.jobId)
      await assertAssetsEditable(job)
      const asset = await loadLockedAsset(tx, scope, job, input.assetId)
      enforceCommandOptimisticLock({
        resourceKind: ITAD_ASSET_LOCK_RESOURCE_KIND,
        resourceId: asset.id,
        current: asset.updatedAt,
        request: ctx.request ?? null,
      })
      if (input.customerAssetTag !== undefined) asset.customerAssetTag = input.customerAssetTag
      if (input.manufacturer !== undefined) asset.manufacturer = input.manufacturer
      if (input.model !== undefined) asset.model = input.model
      if (input.dataBearing !== undefined) asset.dataBearing = input.dataBearing
      asset.updatedAt = new Date()
      await tx.flush()
      return {
        jobId: job.id,
        assetId: asset.id,
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        updatedAt: asset.updatedAt.toISOString(),
        snapshot: assetSnapshot(asset),
      }
    })
    await emitAfterCommit('itad.asset.updated', {
      jobId: result.jobId,
      assetId: result.assetId,
      actorUserId,
      tenantId: result.tenantId,
      organizationId: result.organizationId,
    })
    return result
  },
  buildLog: async ({ result }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('itad.audit.assets.update', 'Update ITAD asset'),
      resourceKind: 'itad.asset',
      resourceId: result.assetId,
      parentResourceKind: 'itad.job',
      parentResourceId: result.jobId,
      tenantId: result.tenantId,
      organizationId: result.organizationId,
      snapshotAfter: result.snapshot,
    }
  },
}

/**
 * Voids a wrongly scanned asset while receiving (spec "Wrong-scan correction"). Its
 * scans stay in the log; scanning the serial again later creates a new asset.
 */
const deleteAssetCommand: CommandHandler<ItadAssetDeleteInput, ItadAssetChangeResult> = {
  id: 'itad.assets.delete',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = itadAssetDeleteSchema.parse(rawInput)
    const reason = resolveNote(input.reason, true)
    if (reason === false) return await assetError(400, 'reason_required')
    const { scope, actorUserId, em } = await resolveActor(ctx)
    await loadJob(em, scope, input.jobId)

    const result = await em.transactional(async (tx) => {
      const job = await lockJob(tx, scope, input.jobId)
      await assertAssetsEditable(job)
      const asset = await loadLockedAsset(tx, scope, job, input.assetId)
      enforceCommandOptimisticLock({
        resourceKind: ITAD_ASSET_LOCK_RESOURCE_KIND,
        resourceId: asset.id,
        current: asset.updatedAt,
        request: ctx.request ?? null,
      })
      const now = new Date()
      asset.deletedAt = now
      asset.deletedByUserId = actorUserId
      asset.deleteReason = reason
      asset.updatedAt = now
      await tx.flush()
      return {
        jobId: job.id,
        assetId: asset.id,
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        updatedAt: now.toISOString(),
        snapshot: { ...assetSnapshot(asset), deleteReason: reason },
      }
    })
    await emitAfterCommit(
      'itad.asset.deleted',
      {
        jobId: result.jobId,
        assetId: result.assetId,
        reason,
        actorUserId,
        tenantId: result.tenantId,
        organizationId: result.organizationId,
      },
      true,
    )
    return result
  },
  buildLog: async ({ result }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('itad.audit.assets.delete', 'Remove ITAD asset'),
      resourceKind: 'itad.asset',
      resourceId: result.assetId,
      parentResourceKind: 'itad.job',
      parentResourceId: result.jobId,
      tenantId: result.tenantId,
      organizationId: result.organizationId,
      snapshotAfter: result.snapshot,
    }
  },
}

registerCommand(scanCommand)
registerCommand(resolveDuplicateCommand)
registerCommand(flagDifferentDeviceCommand)
registerCommand(updateAssetCommand)
registerCommand(deleteAssetCommand)

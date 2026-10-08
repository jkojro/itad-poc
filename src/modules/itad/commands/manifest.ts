import { randomUUID } from 'node:crypto'
import { LockMode } from '@mikro-orm/core'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import { isUniqueViolation, notFound } from '@open-mercato/shared/lib/crud/errors'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { ItadJob, ItadManifestImport, ItadManifestItem } from '../data/entities'
import {
  itadManifestImportSchema,
  itadManifestItemDeleteSchema,
  type ItadManifestImportInput,
  type ItadManifestItemDeleteInput,
} from '../data/validators'
import { MANIFEST_LIMITS, evaluateManifestRows, type ManifestFieldMapping } from '../domain/manifest-mapping'
import type { ItadJobStatus } from '../domain/job-types'
import { effectiveJobStatus, resolveItemDeleteReason } from '../domain/manifest-rules'
import { emitItadEvent } from '../events'
import { ITAD_MANIFEST_IMPORT_ENTITY_ID } from '../lib/constants'
import { assertManifestEditable, manifestError } from '../lib/manifest-errors'
import { MANIFEST_ATTACHMENT_PARTITION, resolveAttachmentService } from '../module-integrations/attachments'
import { loadActiveManifestSerials, prepareManifest } from '../services/manifest-import'
import { ensureScope, loadJob, type JobScope } from './jobs'

const logger = createLogger('itad').child({ component: 'manifest' })

const MANIFEST_FILE_UNIQUE_INDEX = 'itad_manifest_imports_file_unique'
const SKIPPED_ROWS_STORED = 500
const WARNINGS_STORED = 500

/** Carries the uploaded bytes from the route to the command outside the durable input. */
export const ITAD_MANIFEST_UPLOAD_CONTEXT = Symbol.for('itad.manifest.upload-context')

type ManifestUploadRuntimeContext = CommandRuntimeContext & {
  [ITAD_MANIFEST_UPLOAD_CONTEXT]?: { buffer: Buffer }
}

export type ItadManifestImportResult = {
  importId: string
  jobId: string
  tenantId: string
  organizationId: string
  fileName: string
  format: 'csv' | 'xlsx'
  sheetName: string | null
  totalRows: number
  importedCount: number
  skippedCount: number
  skippedRows: Array<{ row: number; serial: string }>
}

function resolveUploadBuffer(ctx: CommandRuntimeContext): Buffer {
  const payload = (ctx as ManifestUploadRuntimeContext)[ITAD_MANIFEST_UPLOAD_CONTEXT]
  if (!payload || !Buffer.isBuffer(payload.buffer)) throw new Error('[internal] Manifest upload payload is missing')
  return payload.buffer
}

function toFieldMapping(mapping: ItadManifestImportInput['mapping']): ManifestFieldMapping {
  const result: ManifestFieldMapping = { serial: mapping.serial }
  if (mapping.customerAssetTag) result.customerAssetTag = mapping.customerAssetTag
  if (mapping.manufacturer) result.manufacturer = mapping.manufacturer
  if (mapping.model) result.model = mapping.model
  return result
}

async function lockJob(tx: EntityManager, scope: JobScope, jobId: string): Promise<ItadJob> {
  const job = await tx.findOne(
    ItadJob,
    { id: jobId, tenantId: scope.tenantId, organizationId: scope.organizationId, deletedAt: null } as FilterQuery<ItadJob>,
    { lockMode: LockMode.PESSIMISTIC_WRITE },
  )
  if (!job) {
    const { translate } = await resolveTranslations()
    throw notFound(translate('itad.jobs.errors.not_found', 'ITAD job not found'))
  }
  return job
}

/**
 * Imports one manifest file into a job (spec "Import flow", step 3). Validation runs
 * before the upload; the attachment row, the import record and its items then commit
 * in the attachment service's transaction, where the job row is locked and the rows
 * are re-evaluated so a concurrent change can only turn rows into skipped ones.
 * Not undoable: corrections are item deletions (Phase 2).
 */
const importManifestCommand: CommandHandler<ItadManifestImportInput, ItadManifestImportResult> = {
  id: 'itad.manifest.import',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = itadManifestImportSchema.parse(rawInput)
    const buffer = resolveUploadBuffer(ctx)
    if (buffer.byteLength !== input.fileSize) throw new Error('[internal] Manifest upload size does not match the input')
    const scope = await ensureScope(ctx)
    const actorUserId = ctx.auth?.sub ?? null
    if (!actorUserId) throw new Error('[internal] Manifest import requires an authenticated actor')

    const attachments = resolveAttachmentService(ctx.container)
    attachments.validateUpload({ fileName: input.fileName, fileSize: input.fileSize })

    const em = ctx.container.resolve<EntityManager>('em').fork()
    const job = await loadJob(em, scope, input.jobId)
    await assertManifestEditable(job)

    const mapping = toFieldMapping(input.mapping)
    const result = await prepareManifest({
      em,
      scope,
      jobId: job.id,
      fileName: input.fileName,
      buffer,
      sheet: input.sheet ?? null,
      mapping,
    })
    if (!result.ok) return await manifestError(400, result.code)
    const prepared = result.prepared
    if (prepared.sha256 !== input.expectedSha256) return await manifestError(400, 'file_changed')
    if (prepared.mappingError || !prepared.evaluation) {
      return await manifestError(400, 'mapping_invalid', { mappingError: prepared.mappingError })
    }
    if (prepared.evaluation.counts.invalid > 0) {
      return await manifestError(400, 'manifest_rows_invalid', {
        rowErrors: prepared.evaluation.errors.slice(0, MANIFEST_LIMITS.maxReportedErrors),
        errorCount: prepared.evaluation.errors.length,
      })
    }
    const warnings = prepared.evaluation.warnings
    if (warnings.length > 0 && !input.acceptWarnings) {
      return await manifestError(400, 'warnings_not_accepted', {
        warnings: warnings.slice(0, MANIFEST_LIMITS.maxReportedErrors),
        warningCount: warnings.length,
      })
    }
    const alreadyImported = await em.count(ItadManifestImport, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      job: job.id,
      fileSha256: prepared.sha256,
      sheetName: prepared.sheetName,
    } as FilterQuery<ItadManifestImport>)
    if (alreadyImported > 0) return await manifestError(409, 'manifest_already_imported')

    const importId = randomUUID()
    const holder: { result?: ItadManifestImportResult } = {}
    await attachments.createScoped({
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      entityId: ITAD_MANIFEST_IMPORT_ENTITY_ID,
      recordId: importId,
      partitionCode: MANIFEST_ATTACHMENT_PARTITION,
      fileName: input.fileName,
      declaredMimeType: input.fileType,
      buffer,
      persistLink: async (tx, attachmentId) => {
        const locked = await lockJob(tx, scope, job.id)
        await assertManifestEditable(locked)
        const evaluation = evaluateManifestRows({
          table: prepared.table,
          mapping,
          existingSerials: await loadActiveManifestSerials(tx, scope, locked.id),
        })
        const now = new Date()
        const skipped = evaluation.rows
          .filter((row) => row.state === 'skipped_existing')
          .map((row) => ({ row: row.rowNumber, serial: row.serial ?? '' }))
        const importRecord = tx.create(ItadManifestImport, {
          id: importId,
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
          job: locked,
          attachmentId,
          fileName: input.fileName,
          mimeType: input.fileType || 'text/csv',
          fileSize: input.fileSize,
          fileSha256: prepared.sha256,
          format: prepared.format,
          sheetName: prepared.sheetName,
          sourceColumns: prepared.table.columns,
          mapping: { fields: mapping, unused: prepared.unusedColumns },
          warnings: evaluation.warnings.slice(0, WARNINGS_STORED),
          acceptedWarningsByUserId: evaluation.warnings.length > 0 ? actorUserId : null,
          totalRows: evaluation.rows.length,
          importedCount: evaluation.counts.valid,
          skippedCount: evaluation.counts.skippedExisting,
          blankCount: evaluation.counts.blankIgnored,
          skippedRows: skipped.slice(0, SKIPPED_ROWS_STORED),
          jobStatusAtChange: effectiveJobStatus(locked),
          importedByUserId: actorUserId,
          createdAt: now,
        })
        tx.persist(importRecord)
        for (const row of evaluation.rows) {
          if (row.state !== 'valid' || !row.serial || !row.serialNormalized) continue
          tx.persist(
            tx.create(ItadManifestItem, {
              tenantId: scope.tenantId,
              organizationId: scope.organizationId,
              job: locked,
              manifestImport: importRecord,
              sourceRow: row.rowNumber,
              serial: row.serial,
              serialNormalized: row.serialNormalized,
              customerAssetTag: row.customerAssetTag,
              manufacturer: row.manufacturer,
              model: row.model,
              sourceData: row.sourceData,
              createdAt: now,
              updatedAt: now,
            }),
          )
        }
        try {
          await tx.flush()
        } catch (err) {
          if (isUniqueViolation(err, MANIFEST_FILE_UNIQUE_INDEX)) await manifestError(409, 'manifest_already_imported')
          throw err
        }
        holder.result = {
          importId,
          jobId: locked.id,
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
          fileName: input.fileName,
          format: prepared.format,
          sheetName: prepared.sheetName,
          totalRows: evaluation.rows.length,
          importedCount: evaluation.counts.valid,
          skippedCount: evaluation.counts.skippedExisting,
          skippedRows: skipped.slice(0, SKIPPED_ROWS_STORED),
        }
      },
    })

    const imported = holder.result
    if (!imported) throw new Error('[internal] Manifest import was not persisted')
    try {
      await emitItadEvent(
        'itad.manifest.imported',
        {
          jobId: imported.jobId,
          importId: imported.importId,
          importedCount: imported.importedCount,
          skippedCount: imported.skippedCount,
          actorUserId,
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
        },
        { persistent: true },
      )
    } catch (err) {
      logger.error('Failed to emit itad.manifest.imported', { err, importId: imported.importId })
    }
    return imported
  },
  // Audit record: identifiers and counts only — never row values (spec Q14).
  buildLog: async ({ result }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('itad.audit.manifest.import', 'Import ITAD manifest'),
      resourceKind: 'itad.manifest_import',
      resourceId: result.importId,
      parentResourceKind: 'itad.job',
      parentResourceId: result.jobId,
      tenantId: result.tenantId,
      organizationId: result.organizationId,
      snapshotAfter: {
        id: result.importId,
        jobId: result.jobId,
        fileName: result.fileName,
        format: result.format,
        sheetName: result.sheetName,
        totalRows: result.totalRows,
        importedCount: result.importedCount,
        skippedCount: result.skippedCount,
      },
    }
  },
}

registerCommand(importManifestCommand)

export type ItadManifestItemDeleteResult = {
  itemId: string
  jobId: string
  tenantId: string
  organizationId: string
  serialNormalized: string
  reason: string | null
  jobStatusAtChange: ItadJobStatus
}

/**
 * Soft-deletes one manifest item (spec "Where changes are allowed"). Under the job row
 * lock it checks that the manifest is still editable and that a reason is given while
 * receiving; the deleter, reason and effective job status are kept on the item for the
 * history. Source data stays on the row. Not undoable: re-import restores an item.
 */
const deleteManifestItemCommand: CommandHandler<ItadManifestItemDeleteInput, ItadManifestItemDeleteResult> = {
  id: 'itad.manifest.delete_item',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = itadManifestItemDeleteSchema.parse(rawInput)
    const scope = await ensureScope(ctx)
    const actorUserId = ctx.auth?.sub ?? null
    if (!actorUserId) throw new Error('[internal] Manifest item delete requires an authenticated actor')
    const em = ctx.container.resolve<EntityManager>('em').fork()
    await loadJob(em, scope, input.jobId)

    const result = await em.transactional(async (tx) => {
      const locked = await lockJob(tx, scope, input.jobId)
      await assertManifestEditable(locked)
      const reason = resolveItemDeleteReason(locked, input.reason)
      if (!reason.ok) return manifestError(400, 'reason_required')
      const item = await tx.findOne(ItadManifestItem, {
        id: input.itemId,
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        job: locked.id,
        deletedAt: null,
      } as FilterQuery<ItadManifestItem>)
      if (!item) {
        const { translate } = await resolveTranslations()
        throw notFound(translate('itad.manifest.errors.item_not_found', 'Manifest item not found'))
      }
      const jobStatusAtChange = effectiveJobStatus(locked)
      const now = new Date()
      item.deletedAt = now
      item.deletedByUserId = actorUserId
      item.deleteReason = reason.reason
      item.deleteJobStatus = jobStatusAtChange
      item.updatedAt = now
      await tx.flush()
      return {
        itemId: item.id,
        jobId: locked.id,
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        serialNormalized: item.serialNormalized,
        reason: reason.reason,
        jobStatusAtChange,
      }
    })

    try {
      await emitItadEvent(
        'itad.manifest.item_deleted',
        {
          jobId: result.jobId,
          itemId: result.itemId,
          serialNormalized: result.serialNormalized,
          reason: result.reason,
          actorUserId,
          tenantId: result.tenantId,
          organizationId: result.organizationId,
        },
        { persistent: true },
      )
    } catch (err) {
      logger.error('Failed to emit itad.manifest.item_deleted', { err, itemId: result.itemId })
    }
    return result
  },
  // Audit record: identifiers, serial and reason only — never the item's source data.
  buildLog: async ({ result }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('itad.audit.manifest.deleteItem', 'Remove ITAD manifest item'),
      resourceKind: 'itad.manifest_item',
      resourceId: result.itemId,
      parentResourceKind: 'itad.job',
      parentResourceId: result.jobId,
      tenantId: result.tenantId,
      organizationId: result.organizationId,
      snapshotAfter: {
        id: result.itemId,
        jobId: result.jobId,
        serialNormalized: result.serialNormalized,
        reason: result.reason,
        jobStatusAtChange: result.jobStatusAtChange,
      },
    }
  },
}

registerCommand(deleteManifestItemCommand)

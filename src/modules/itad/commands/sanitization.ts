import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import { isUniqueViolation, notFound } from '@open-mercato/shared/lib/crud/errors'
import { enforceCommandOptimisticLock } from '@open-mercato/shared/lib/crud/optimistic-lock-command'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { ItadAsset, ItadSanitizationEvidence, ItadSanitizationRun, type ItadJob } from '../data/entities'
import {
  itadSanitizationAbortSchema,
  itadSanitizationEvidenceSchema,
  itadSanitizationResultSchema,
  itadSanitizationRetrySchema,
  itadSanitizationStartSchema,
  type ItadSanitizationAbortInput,
  type ItadSanitizationEvidenceInput,
  type ItadSanitizationResultInput,
  type ItadSanitizationRetryInput,
  type ItadSanitizationStartInput,
} from '../data/validators'
import { resolveNote } from '../domain/receiving-rules'
import {
  canAttachEvidence,
  decideRunAction,
  verificationNotesRequired,
  type ItadRunResult,
  type RunAction,
} from '../domain/sanitization-state-machine'
import { emitItadEvent, type ItadEventId } from '../events'
import { ITAD_JOB_ENTITY_ID } from '../lib/constants'
import { sanitizationError } from '../lib/sanitization-errors'
import { EVIDENCE_ATTACHMENT_PARTITION, resolveAttachmentService } from '../module-integrations/attachments'
import { recordAssetSteps } from '../services/sanitization-writer'
import { ITAD_ASSET_LOCK_RESOURCE_KIND } from './assets'
import { lockJob } from './job-lock'
import { ensureScope, loadJob, type JobScope } from './jobs'

const logger = createLogger('itad').child({ component: 'sanitization' })

const OPEN_RUN_UNIQUE_INDEX = 'itad_sanitization_runs_open_unique'

/** Context key carrying the evidence file bytes, outside the durable (audited) input. */
export const ITAD_EVIDENCE_UPLOAD_CONTEXT = '__itadEvidenceUpload'
type EvidenceUploadRuntimeContext = CommandRuntimeContext & { [ITAD_EVIDENCE_UPLOAD_CONTEXT]?: { buffer: Buffer } }

type Actor = { scope: JobScope; actorUserId: string; em: EntityManager }

async function resolveActor(ctx: CommandRuntimeContext): Promise<Actor> {
  const scope = await ensureScope(ctx)
  const actorUserId = ctx.auth?.sub ?? null
  if (!actorUserId) throw new Error('[internal] Sanitization commands require an authenticated actor')
  return { scope, actorUserId, em: ctx.container.resolve<EntityManager>('em').fork() }
}

/** After commit; a failed emit is logged, never undoes the committed write. */
async function emitAfterCommit(eventId: ItadEventId, payload: Record<string, unknown>, persistent = false): Promise<void> {
  try {
    await emitItadEvent(eventId, payload, persistent ? { persistent: true } : undefined)
  } catch (err) {
    logger.error(`Failed to emit ${eventId}`, { err })
  }
}

async function loadAsset(tx: EntityManager, scope: JobScope, job: ItadJob, assetId: string): Promise<ItadAsset> {
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

async function loadRun(tx: EntityManager, scope: JobScope, job: ItadJob, runId: string): Promise<ItadSanitizationRun> {
  const run = await tx.findOne(
    ItadSanitizationRun,
    { id: runId, tenantId: scope.tenantId, organizationId: scope.organizationId, job: job.id } as FilterQuery<ItadSanitizationRun>,
    { populate: ['asset'] as never[] },
  )
  if (!run) {
    const { translate } = await resolveTranslations()
    throw notFound(translate('itad.sanitization.errors.run_not_found', 'Sanitization run not found'))
  }
  return run
}

async function decideOrThrow(job: ItadJob, asset: ItadAsset, action: RunAction) {
  const decision = decideRunAction({ jobStatus: job.status, assetStatus: asset.status, action })
  if (!decision.ok) return await sanitizationError(409, decision.code)
  return decision
}

function lockAsset(ctx: CommandRuntimeContext, asset: ItadAsset): void {
  enforceCommandOptimisticLock({
    resourceKind: ITAD_ASSET_LOCK_RESOURCE_KIND,
    resourceId: asset.id,
    current: asset.updatedAt,
    request: ctx.request ?? null,
  })
}

export type ItadRunChangeResult = {
  jobId: string
  tenantId: string
  organizationId: string
  runId: string
  assetId: string
  assetStatus: ItadAsset['status']
  result: ItadRunResult | null
  updatedAt: string
}

function runChangeResult(scope: JobScope, job: ItadJob, run: ItadSanitizationRun, asset: ItadAsset): ItadRunChangeResult {
  return {
    jobId: job.id,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    runId: run.id,
    assetId: asset.id,
    assetStatus: asset.status,
    result: run.result ?? null,
    updatedAt: asset.updatedAt.toISOString(),
  }
}

function runLog(actionKey: string, fallback: string) {
  return async ({ result }: { result: ItadRunChangeResult }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate(actionKey, fallback),
      resourceKind: 'itad.sanitization_run',
      resourceId: result.runId,
      parentResourceKind: 'itad.job',
      parentResourceId: result.jobId,
      tenantId: result.tenantId,
      organizationId: result.organizationId,
      snapshotAfter: { runId: result.runId, assetId: result.assetId, assetStatus: result.assetStatus, result: result.result },
    }
  }
}

/**
 * Opens a Sanitization Run for one asset in `sanitization_required` (spec "Transitions",
 * `start_run`). Job in `processing`; optimistic lock on the asset's `updatedAt`.
 */
const startRunCommand: CommandHandler<ItadSanitizationStartInput, ItadRunChangeResult> = {
  id: 'itad.sanitization.start',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = itadSanitizationStartSchema.parse(rawInput)
    const { scope, actorUserId, em } = await resolveActor(ctx)
    await loadJob(em, scope, input.jobId)

    let result: ItadRunChangeResult & { method: string }
    try {
      result = await em.transactional(async (tx) => {
        const job = await lockJob(tx, scope, input.jobId)
        const asset = await loadAsset(tx, scope, job, input.assetId)
        lockAsset(ctx, asset)
        const decision = await decideOrThrow(job, asset, 'start_run')
        const now = new Date()
        const run = tx.create(ItadSanitizationRun, {
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
          job,
          asset,
          method: input.method,
          methodDetail: input.methodDetail ?? null,
          tool: input.tool,
          toolVersion: input.toolVersion,
          operatorUserId: actorUserId,
          startedAt: now,
          result: null,
          createdAt: now,
          updatedAt: now,
        })
        tx.persist(run)
        recordAssetSteps(tx, {
          job,
          asset,
          action: 'start_run',
          steps: decision.steps,
          toStatus: decision.toStatus,
          run,
          reason: null,
          actorUserId,
          now,
        })
        await tx.flush()
        return { ...runChangeResult(scope, job, run, asset), method: run.method }
      })
    } catch (err) {
      // The job lock serializes starts; the open-run index is a backstop.
      if (isUniqueViolation(err, OPEN_RUN_UNIQUE_INDEX)) return await sanitizationError(409, 'asset_transition_not_allowed')
      throw err
    }
    const { method, ...publicResult } = result
    await emitAfterCommit('itad.sanitization.run_started', {
      jobId: result.jobId,
      runId: result.runId,
      assetId: result.assetId,
      method,
      bulkBatchId: null,
      actorUserId,
      tenantId: result.tenantId,
      organizationId: result.organizationId,
    })
    return publicResult
  },
  buildLog: runLog('itad.audit.sanitization.start', 'Start ITAD sanitization run'),
}

/**
 * Completes an open run with PASS or FAIL (spec "Run data", at result). PASS: asset
 * `sanitized`. FAIL: notes required; history `in_progress → sanitization_failed →
 * review_required` in one transaction. The run is immutable afterwards.
 */
const recordResultCommand: CommandHandler<ItadSanitizationResultInput, ItadRunChangeResult> = {
  id: 'itad.sanitization.record_result',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = itadSanitizationResultSchema.parse(rawInput)
    if (verificationNotesRequired(input.result) && !input.verificationNotes) {
      return await sanitizationError(400, 'verification_notes_required')
    }
    const { scope, actorUserId, em } = await resolveActor(ctx)
    await loadJob(em, scope, input.jobId)

    const result = await em.transactional(async (tx) => {
      const job = await lockJob(tx, scope, input.jobId)
      const run = await loadRun(tx, scope, job, input.runId)
      if (run.result) return await sanitizationError(409, 'run_closed')
      const asset = run.asset
      const action: RunAction = input.result === 'PASS' ? 'record_pass' : 'record_fail'
      const decision = await decideOrThrow(job, asset, action)
      const now = new Date()
      run.result = input.result
      run.verificationMethod = input.verificationMethod
      run.verificationNotes = input.verificationNotes ?? null
      run.finishedAt = now
      run.finishedByUserId = actorUserId
      run.updatedAt = now
      recordAssetSteps(tx, {
        job,
        asset,
        action,
        steps: decision.steps,
        toStatus: decision.toStatus,
        run,
        reason: input.result === 'FAIL' ? input.verificationNotes ?? null : null,
        actorUserId,
        now,
      })
      await tx.flush()
      return runChangeResult(scope, job, run, asset)
    })
    const passed = input.result === 'PASS'
    await emitAfterCommit(
      passed ? 'itad.sanitization.run_passed' : 'itad.sanitization.run_failed',
      {
        jobId: result.jobId,
        runId: result.runId,
        assetId: result.assetId,
        actorUserId,
        tenantId: result.tenantId,
        organizationId: result.organizationId,
      },
      !passed,
    )
    return result
  },
  buildLog: runLog('itad.audit.sanitization.recordResult', 'Record ITAD sanitization result'),
}

/** Aborts an open run started by mistake (Q8): ABORTED with a reason; the asset is required again. */
const abortRunCommand: CommandHandler<ItadSanitizationAbortInput, ItadRunChangeResult> = {
  id: 'itad.sanitization.abort',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = itadSanitizationAbortSchema.parse(rawInput)
    const reason = resolveNote(input.reason, true)
    if (reason === false) return await sanitizationError(400, 'reason_required')
    const { scope, actorUserId, em } = await resolveActor(ctx)
    await loadJob(em, scope, input.jobId)

    const result = await em.transactional(async (tx) => {
      const job = await lockJob(tx, scope, input.jobId)
      const run = await loadRun(tx, scope, job, input.runId)
      if (run.result) return await sanitizationError(409, 'run_closed')
      const asset = run.asset
      const decision = await decideOrThrow(job, asset, 'abort_run')
      const now = new Date()
      run.result = 'ABORTED'
      run.abortReason = reason
      run.finishedAt = now
      run.finishedByUserId = actorUserId
      run.updatedAt = now
      recordAssetSteps(tx, {
        job,
        asset,
        action: 'abort_run',
        steps: decision.steps,
        toStatus: decision.toStatus,
        run,
        reason,
        actorUserId,
        now,
      })
      await tx.flush()
      return runChangeResult(scope, job, run, asset)
    })
    await emitAfterCommit('itad.sanitization.run_aborted', {
      jobId: result.jobId,
      runId: result.runId,
      assetId: result.assetId,
      reason,
      actorUserId,
      tenantId: result.tenantId,
      organizationId: result.organizationId,
    })
    return result
  },
  buildLog: runLog('itad.audit.sanitization.abort', 'Abort ITAD sanitization run'),
}

export type ItadRetryResult = {
  jobId: string
  tenantId: string
  organizationId: string
  assetId: string
  assetStatus: ItadAsset['status']
  updatedAt: string
}

/**
 * Manager decision after a FAIL (Q4): `review_required → sanitization_required` with a
 * reason. The failed run stays in the history; the next start opens a new run.
 */
const approveRetryCommand: CommandHandler<ItadSanitizationRetryInput, ItadRetryResult> = {
  id: 'itad.sanitization.approve_retry',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = itadSanitizationRetrySchema.parse(rawInput)
    const reason = resolveNote(input.reason, true)
    if (reason === false) return await sanitizationError(400, 'reason_required')
    const { scope, actorUserId, em } = await resolveActor(ctx)
    await loadJob(em, scope, input.jobId)

    const result = await em.transactional(async (tx) => {
      const job = await lockJob(tx, scope, input.jobId)
      const asset = await loadAsset(tx, scope, job, input.assetId)
      lockAsset(ctx, asset)
      const decision = await decideOrThrow(job, asset, 'approve_retry')
      const now = new Date()
      recordAssetSteps(tx, {
        job,
        asset,
        action: 'approve_retry',
        steps: decision.steps,
        toStatus: decision.toStatus,
        run: null,
        reason,
        actorUserId,
        now,
      })
      await tx.flush()
      return {
        jobId: job.id,
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        assetId: asset.id,
        assetStatus: asset.status,
        updatedAt: asset.updatedAt.toISOString(),
      }
    })
    await emitAfterCommit('itad.asset.sanitization_retry_approved', {
      jobId: result.jobId,
      assetId: result.assetId,
      reason,
      actorUserId,
      tenantId: result.tenantId,
      organizationId: result.organizationId,
    })
    return result
  },
  buildLog: async ({ result }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('itad.audit.sanitization.approveRetry', 'Approve ITAD sanitization retry'),
      resourceKind: 'itad.asset',
      resourceId: result.assetId,
      parentResourceKind: 'itad.job',
      parentResourceId: result.jobId,
      tenantId: result.tenantId,
      organizationId: result.organizationId,
      snapshotAfter: { assetId: result.assetId, assetStatus: result.assetStatus },
    }
  },
}

export type ItadEvidenceResult = {
  jobId: string
  tenantId: string
  organizationId: string
  attachmentId: string
  fileName: string
  runIds: string[]
}

function resolveEvidenceBuffer(ctx: CommandRuntimeContext): Buffer {
  const payload = (ctx as EvidenceUploadRuntimeContext)[ITAD_EVIDENCE_UPLOAD_CONTEXT]
  if (!payload || !Buffer.isBuffer(payload.buffer)) throw new Error('[internal] Evidence upload payload is missing')
  return payload.buffer
}

/**
 * Stores one evidence file and links it to one or more runs of the job (spec "Evidence
 * files"). The attachment is owned by the job, so one bulk report can serve a batch of
 * runs; the link rows are written in the attachment row's transaction under the job lock.
 * Links are append-only; finished runs stay otherwise immutable.
 */
const attachEvidenceCommand: CommandHandler<ItadSanitizationEvidenceInput, ItadEvidenceResult> = {
  id: 'itad.sanitization.attach_evidence',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = itadSanitizationEvidenceSchema.parse(rawInput)
    const buffer = resolveEvidenceBuffer(ctx)
    if (buffer.byteLength !== input.fileSize) throw new Error('[internal] Evidence upload size does not match the input')
    const { scope, actorUserId, em } = await resolveActor(ctx)
    const attachments = resolveAttachmentService(ctx.container)
    attachments.validateUpload({ fileName: input.fileName, fileSize: input.fileSize })
    const job = await loadJob(em, scope, input.jobId)
    if (!canAttachEvidence(job.status)) return await sanitizationError(409, 'job_terminal')

    const stored = await attachments.createScoped({
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      entityId: ITAD_JOB_ENTITY_ID,
      recordId: job.id,
      partitionCode: EVIDENCE_ATTACHMENT_PARTITION,
      fileName: input.fileName,
      declaredMimeType: input.fileType,
      buffer,
      persistLink: async (tx, attachmentId) => {
        const locked = await lockJob(tx, scope, job.id)
        if (!canAttachEvidence(locked.status)) return await sanitizationError(409, 'job_terminal')
        const runs = await tx.find(ItadSanitizationRun, {
          id: { $in: input.runIds },
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
          job: locked.id,
        } as FilterQuery<ItadSanitizationRun>)
        if (runs.length !== input.runIds.length) {
          const found = new Set(runs.map((run) => run.id))
          return await sanitizationError(409, 'runs_not_found', { runIds: input.runIds.filter((id) => !found.has(id)) })
        }
        const now = new Date()
        for (const run of runs) {
          tx.persist(
            tx.create(ItadSanitizationEvidence, {
              tenantId: scope.tenantId,
              organizationId: scope.organizationId,
              job: locked,
              run,
              attachmentId,
              fileName: input.fileName,
              addedByUserId: actorUserId,
              createdAt: now,
            }),
          )
        }
        await tx.flush()
      },
    })
    return {
      jobId: job.id,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      attachmentId: stored.id,
      fileName: stored.fileName,
      runIds: input.runIds,
    }
  },
  buildLog: async ({ result }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('itad.audit.sanitization.attachEvidence', 'Attach ITAD sanitization evidence'),
      resourceKind: 'itad.job',
      resourceId: result.jobId,
      tenantId: result.tenantId,
      organizationId: result.organizationId,
      snapshotAfter: { attachmentId: result.attachmentId, runCount: result.runIds.length },
    }
  },
}

registerCommand(startRunCommand)
registerCommand(recordResultCommand)
registerCommand(abortRunCommand)
registerCommand(approveRetryCommand)
registerCommand(attachEvidenceCommand)

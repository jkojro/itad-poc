import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import { emitCrudSideEffects, buildChanges, requireId } from '@open-mercato/shared/lib/commands/helpers'
import { withAtomicFlush } from '@open-mercato/shared/lib/commands/flush'
import { isUniqueViolation, notFound } from '@open-mercato/shared/lib/crud/errors'
import type { CrudEmitContext, CrudEventsConfig, CrudIndexerConfig } from '@open-mercato/shared/lib/crud/types'
import type { DataEngine } from '@open-mercato/shared/lib/data/engine'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import { ItadJob } from '../data/entities'
import {
  ITAD_JOB_SYSTEM_FIELDS,
  itadJobCreateSchema,
  itadJobUpdateSchema,
} from '../data/validators'
import { itadJobError } from '../lib/errors'
import { allocateJobReference } from '../services/job-reference-generator'
import { isCompanyInScope } from '../module-integrations/customers'
import {
  findEditabilityViolation,
  isTerminalStatus,
  type JobFieldValues,
} from '../domain/job-editability'
import { ITAD_JOB_ENTITY_ID } from '../lib/constants'

const CUSTOMER_REFERENCE_INDEX = 'itad_jobs_customer_reference_unique'
const INTERNAL_REFERENCE_INDEX = 'itad_jobs_internal_reference_unique'

export type JobScope = { tenantId: string; organizationId: string }

export type SerializedJob = {
  id: string
  tenantId: string
  organizationId: string
  customerId: string
  internalReference: string
  customerReference: string | null
  name: string
  status: string
  expectedAssetEstimate: number | null
  scheduledPickupAt: string | null
  defaultDataBearing: boolean | null
}

export const itadJobCrudEvents: CrudEventsConfig<ItadJob> = {
  module: 'itad',
  entity: 'job',
  persistent: true,
  buildPayload: (ctx: CrudEmitContext<ItadJob>) => ({
    id: ctx.identifiers.id,
    tenantId: ctx.identifiers.tenantId,
    organizationId: ctx.identifiers.organizationId,
    customerId: ctx.entity?.customerId ?? null,
    internalReference: ctx.entity?.internalReference ?? null,
    status: ctx.entity?.status ?? null,
  }),
}

export const itadJobCrudIndexer: CrudIndexerConfig<ItadJob> = {
  entityType: ITAD_JOB_ENTITY_ID,
  buildUpsertPayload: (ctx: CrudEmitContext<ItadJob>) => ({
    entityType: ITAD_JOB_ENTITY_ID,
    recordId: ctx.identifiers.id,
    tenantId: ctx.identifiers.tenantId,
    organizationId: ctx.identifiers.organizationId,
  }),
  buildDeletePayload: (ctx: CrudEmitContext<ItadJob>) => ({
    entityType: ITAD_JOB_ENTITY_ID,
    recordId: ctx.identifiers.id,
    tenantId: ctx.identifiers.tenantId,
    organizationId: ctx.identifiers.organizationId,
  }),
}

export async function ensureScope(ctx: CommandRuntimeContext): Promise<JobScope> {
  const { translate } = await resolveTranslations()
  const tenantId = ctx.auth?.tenantId ?? null
  if (!tenantId) {
    throw itadJobError(400, 'tenant_required', translate('itad.jobs.errors.tenant_required', 'Tenant context is required'))
  }
  const organizationId = ctx.selectedOrganizationId ?? ctx.auth?.orgId ?? null
  if (!organizationId) {
    throw itadJobError(
      400,
      'organization_required',
      translate('itad.jobs.errors.organization_required', 'Select an organization to change ITAD jobs'),
    )
  }
  return { tenantId, organizationId }
}

async function rejectSystemFields(rawInput: unknown): Promise<void> {
  if (!rawInput || typeof rawInput !== 'object') return
  const present = ITAD_JOB_SYSTEM_FIELDS.find((field) => field in (rawInput as Record<string, unknown>))
  if (!present) return
  const { translate } = await resolveTranslations()
  const message = translate('itad.jobs.errors.field_not_writable', 'This field is managed by the system and cannot be set')
  throw itadJobError(400, 'field_not_writable', message, { [present]: message })
}

async function assertCustomerCompany(ctx: CommandRuntimeContext, scope: JobScope, customerId: string): Promise<void> {
  const queryEngine = ctx.container.resolve<QueryEngine>('queryEngine')
  if (await isCompanyInScope(queryEngine, scope, customerId)) return
  const { translate } = await resolveTranslations()
  const message = translate('itad.jobs.errors.customer_invalid', 'Select a customer company from this organization')
  throw itadJobError(400, 'customer_invalid', message, { customerId: message })
}

async function mapUniqueViolation(err: unknown): Promise<never> {
  const { translate } = await resolveTranslations()
  if (isUniqueViolation(err, CUSTOMER_REFERENCE_INDEX)) {
    const message = translate(
      'itad.jobs.errors.customer_reference_taken',
      'Another job in this organization already uses this customer reference',
    )
    throw itadJobError(409, 'customer_reference_taken', message, { customerReference: message })
  }
  if (isUniqueViolation(err, INTERNAL_REFERENCE_INDEX)) {
    throw itadJobError(
      409,
      'reference_conflict',
      translate('itad.jobs.errors.reference_conflict', 'The job reference could not be issued. Try again.'),
    )
  }
  throw err
}

function toDateOrNull(value: string | null | undefined): Date | null {
  return value ? new Date(value) : null
}

function currentValues(job: ItadJob): JobFieldValues {
  return {
    customerId: job.customerId,
    name: job.name,
    customerReference: job.customerReference ?? null,
    scheduledPickupAt: job.scheduledPickupAt ?? null,
    expectedAssetEstimate: job.expectedAssetEstimate ?? null,
    defaultDataBearing: job.defaultDataBearing ?? null,
  }
}

export function serializeJob(job: ItadJob): SerializedJob {
  return {
    id: String(job.id),
    tenantId: job.tenantId,
    organizationId: job.organizationId,
    customerId: job.customerId,
    internalReference: job.internalReference,
    customerReference: job.customerReference ?? null,
    name: job.name,
    status: job.status,
    expectedAssetEstimate: job.expectedAssetEstimate ?? null,
    scheduledPickupAt: job.scheduledPickupAt ? job.scheduledPickupAt.toISOString() : null,
    defaultDataBearing: job.defaultDataBearing ?? null,
  }
}

export async function loadJob(em: EntityManager, scope: JobScope, id: string): Promise<ItadJob> {
  const job = await em.findOne(ItadJob, {
    id,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    deletedAt: null,
  } as FilterQuery<ItadJob>)
  if (!job) {
    const { translate } = await resolveTranslations()
    throw notFound(translate('itad.jobs.errors.not_found', 'ITAD job not found'))
  }
  return job
}

export async function emitJobEffects(
  ctx: CommandRuntimeContext,
  action: 'created' | 'updated' | 'deleted',
  job: ItadJob,
  scope: JobScope,
): Promise<void> {
  await emitCrudSideEffects({
    dataEngine: ctx.container.resolve<DataEngine>('dataEngine'),
    action,
    entity: job,
    identifiers: { id: String(job.id), tenantId: scope.tenantId, organizationId: scope.organizationId },
    syncOrigin: ctx.syncOrigin,
    events: itadJobCrudEvents,
    indexer: itadJobCrudIndexer,
  })
}

// No `itad.jobs.*` command is undoable (spec: Design Decisions): undo would bypass the
// status and editability guards. Corrections go through edits and backward transitions.

const createJobCommand: CommandHandler<Record<string, unknown>, ItadJob> = {
  id: 'itad.jobs.create',
  isUndoable: false,
  async execute(rawInput, ctx) {
    await rejectSystemFields(rawInput)
    const parsed = itadJobCreateSchema.parse(rawInput)
    const scope = await ensureScope(ctx)
    await assertCustomerCompany(ctx, scope, parsed.customerId)

    const em = ctx.container.resolve<EntityManager>('em').fork()
    const createdAt = new Date()
    const holder: { job?: ItadJob } = {}
    try {
      await withAtomicFlush(
        em,
        [
          async () => {
            const internalReference = await allocateJobReference(em, scope, createdAt)
            const job = em.create(ItadJob, {
              tenantId: scope.tenantId,
              organizationId: scope.organizationId,
              customerId: parsed.customerId,
              internalReference,
              customerReference: parsed.customerReference ?? null,
              name: parsed.name,
              status: 'draft',
              expectedAssetEstimate: parsed.expectedAssetEstimate ?? null,
              scheduledPickupAt: toDateOrNull(parsed.scheduledPickupAt),
              defaultDataBearing: parsed.defaultDataBearing ?? null,
              createdAt,
              updatedAt: createdAt,
            })
            em.persist(job)
            holder.job = job
          },
        ],
        { transaction: true, label: 'itad.jobs.create' },
      )
    } catch (err) {
      await mapUniqueViolation(err)
    }
    const created = holder.job
    if (!created) throw new Error('[internal] ITAD job was not created')
    await emitJobEffects(ctx, 'created', created, scope)
    return created
  },
  captureAfter: (_input, result) => serializeJob(result),
  buildLog: async ({ result }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('itad.audit.jobs.create', 'Create ITAD job'),
      resourceKind: 'itad.job',
      resourceId: String(result.id),
      tenantId: result.tenantId,
      organizationId: result.organizationId,
      snapshotAfter: serializeJob(result),
    }
  },
}

const updateJobCommand: CommandHandler<Record<string, unknown>, ItadJob> = {
  id: 'itad.jobs.update',
  isUndoable: false,
  async prepare(rawInput, ctx) {
    const parsed = itadJobUpdateSchema.parse(rawInput)
    const scope = await ensureScope(ctx)
    const em = ctx.container.resolve<EntityManager>('em').fork()
    const existing = await loadJob(em, scope, parsed.id)
    return { before: serializeJob(existing) }
  },
  async execute(rawInput, ctx) {
    const scope = await ensureScope(ctx)
    const em = ctx.container.resolve<EntityManager>('em').fork()
    const id = typeof (rawInput as { id?: unknown })?.id === 'string' ? String((rawInput as { id: string }).id) : ''
    const parsedId = itadJobUpdateSchema.shape.id.parse(id)
    const job = await loadJob(em, scope, parsedId)
    const { translate } = await resolveTranslations()

    if (isTerminalStatus(job.status)) {
      throw itadJobError(409, 'terminal', translate('itad.jobs.errors.terminal', 'Completed or cancelled jobs cannot be changed'))
    }
    await rejectSystemFields(rawInput)
    const parsed = itadJobUpdateSchema.parse(rawInput)

    const changes: Partial<JobFieldValues> = {}
    if (parsed.customerId !== undefined) changes.customerId = parsed.customerId
    if (parsed.name !== undefined) changes.name = parsed.name
    if (parsed.customerReference !== undefined) changes.customerReference = parsed.customerReference
    if (parsed.expectedAssetEstimate !== undefined) changes.expectedAssetEstimate = parsed.expectedAssetEstimate
    if (parsed.scheduledPickupAt !== undefined) changes.scheduledPickupAt = toDateOrNull(parsed.scheduledPickupAt)
    if (parsed.defaultDataBearing !== undefined) changes.defaultDataBearing = parsed.defaultDataBearing

    const violation = findEditabilityViolation(job, currentValues(job), changes)
    if (violation) {
      const message = violation.reason === 'not_clearable'
        ? translate('itad.jobs.errors.field_not_clearable', 'This field can no longer be cleared')
        : translate('itad.jobs.errors.field_locked', 'This field can no longer be changed in the current status')
      throw itadJobError(400, 'field_locked', message, { [violation.field]: message })
    }
    if (changes.customerId !== undefined && changes.customerId !== job.customerId) {
      await assertCustomerCompany(ctx, scope, changes.customerId)
    }

    try {
      await withAtomicFlush(
        em,
        [
          () => {
            if (changes.customerId !== undefined) job.customerId = changes.customerId
            if (changes.name !== undefined) job.name = changes.name
            if (changes.customerReference !== undefined) job.customerReference = changes.customerReference
            if (changes.expectedAssetEstimate !== undefined) job.expectedAssetEstimate = changes.expectedAssetEstimate
            if (changes.scheduledPickupAt !== undefined) job.scheduledPickupAt = changes.scheduledPickupAt
            if (changes.defaultDataBearing !== undefined) job.defaultDataBearing = changes.defaultDataBearing
          },
        ],
        { transaction: true, label: 'itad.jobs.update' },
      )
    } catch (err) {
      await mapUniqueViolation(err)
    }
    await emitJobEffects(ctx, 'updated', job, scope)
    return job
  },
  captureAfter: (_input, result) => serializeJob(result),
  buildLog: async ({ result, snapshots }) => {
    const { translate } = await resolveTranslations()
    const before = (snapshots.before as SerializedJob | undefined) ?? null
    const after = serializeJob(result)
    return {
      actionLabel: translate('itad.audit.jobs.update', 'Update ITAD job'),
      resourceKind: 'itad.job',
      resourceId: String(result.id),
      tenantId: result.tenantId,
      organizationId: result.organizationId,
      changes: buildChanges(before, after as unknown as Record<string, unknown>, [
        'customerId',
        'name',
        'customerReference',
        'expectedAssetEstimate',
        'scheduledPickupAt',
        'defaultDataBearing',
      ]),
      snapshotBefore: before,
      snapshotAfter: after,
    }
  },
}

const deleteJobCommand: CommandHandler<{ body?: Record<string, unknown>; query?: Record<string, unknown> }, ItadJob> = {
  id: 'itad.jobs.delete',
  isUndoable: false,
  async prepare(input, ctx) {
    const id = requireId(input, 'ITAD job id required')
    const scope = await ensureScope(ctx)
    const em = ctx.container.resolve<EntityManager>('em').fork()
    const existing = await em.findOne(ItadJob, {
      id,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      deletedAt: null,
    } as FilterQuery<ItadJob>)
    return existing ? { before: serializeJob(existing) } : {}
  },
  async execute(input, ctx) {
    const id = requireId(input, 'ITAD job id required')
    const scope = await ensureScope(ctx)
    const em = ctx.container.resolve<EntityManager>('em').fork()
    const job = await loadJob(em, scope, id)
    if (job.status !== 'draft') {
      const { translate } = await resolveTranslations()
      throw itadJobError(409, 'delete_not_draft', translate('itad.jobs.errors.delete_not_draft', 'Only draft jobs can be deleted'))
    }
    await withAtomicFlush(
      em,
      [
        () => {
          job.deletedAt = new Date()
        },
      ],
      { transaction: true, label: 'itad.jobs.delete' },
    )
    await emitJobEffects(ctx, 'deleted', job, scope)
    return job
  },
  buildLog: async ({ snapshots, input }) => {
    const { translate } = await resolveTranslations()
    const before = (snapshots.before as SerializedJob | undefined) ?? null
    return {
      actionLabel: translate('itad.audit.jobs.delete', 'Delete ITAD job'),
      resourceKind: 'itad.job',
      resourceId: requireId(input, 'ITAD job id required'),
      tenantId: before?.tenantId ?? null,
      organizationId: before?.organizationId ?? null,
      snapshotBefore: before,
    }
  },
}

registerCommand(createJobCommand)
registerCommand(updateJobCommand)
registerCommand(deleteJobCommand)

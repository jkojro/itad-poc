import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import { notFound } from '@open-mercato/shared/lib/crud/errors'
import { enforceCommandOptimisticLock } from '@open-mercato/shared/lib/crud/optimistic-lock-command'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import { ItadException, type ItadJob } from '../data/entities'
import {
  itadExceptionAssignSchema,
  itadExceptionResolveSchema,
  type ItadExceptionAssignInput,
  type ItadExceptionResolveInput,
} from '../data/validators'
import { decideManualResolution, type ItadExceptionOutcome } from '../domain/exceptions'
import { resolveNote } from '../domain/receiving-rules'
import { emitItadEvent } from '../events'
import { exceptionError } from '../lib/exception-errors'
import { isOrganizationUser } from '../module-integrations/users'
import { assignException, resolveException } from '../services/exception-writer'
import { emitExceptionChanges } from './exception-effects'
import { lockJob } from './job-lock'
import { ensureScope, loadJob, type JobScope } from './jobs'

const logger = createLogger('itad').child({ component: 'exceptions' })

export const ITAD_EXCEPTION_LOCK_RESOURCE_KIND = 'itad.exception'

type Actor = { scope: JobScope; actorUserId: string; em: EntityManager }

async function resolveActor(ctx: CommandRuntimeContext): Promise<Actor> {
  const scope = await ensureScope(ctx)
  const actorUserId = ctx.auth?.sub ?? null
  if (!actorUserId) throw new Error('[internal] Exception commands require an authenticated actor')
  return { scope, actorUserId, em: ctx.container.resolve<EntityManager>('em').fork() }
}

async function loadException(tx: EntityManager, scope: JobScope, job: ItadJob, exceptionId: string): Promise<ItadException> {
  const exception = await tx.findOne(ItadException, {
    id: exceptionId,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    job: job.id,
  } as FilterQuery<ItadException>)
  if (!exception) {
    const { translate } = await resolveTranslations()
    throw notFound(translate('itad.exceptions.errors.not_found', 'Exception not found'))
  }
  return exception
}

function lockException(ctx: CommandRuntimeContext, exception: ItadException): void {
  enforceCommandOptimisticLock({
    resourceKind: ITAD_EXCEPTION_LOCK_RESOURCE_KIND,
    resourceId: exception.id,
    current: exception.updatedAt,
    request: ctx.request ?? null,
  })
}

export type ItadExceptionChangeResult = {
  jobId: string
  tenantId: string
  organizationId: string
  exceptionId: string
  status: ItadException['status']
  assignedToUserId: string | null
  resolutionOutcome: ItadExceptionOutcome | null
  updatedAt: string
}

function changeResult(scope: JobScope, job: ItadJob, exception: ItadException): ItadExceptionChangeResult {
  return {
    jobId: job.id,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    exceptionId: exception.id,
    status: exception.status,
    assignedToUserId: exception.assignedToUserId ?? null,
    resolutionOutcome: exception.resolutionOutcome ?? null,
    updatedAt: exception.updatedAt.toISOString(),
  }
}

function exceptionLog(actionKey: string, fallback: string) {
  return async ({ result }: { result: ItadExceptionChangeResult }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate(actionKey, fallback),
      resourceKind: ITAD_EXCEPTION_LOCK_RESOURCE_KIND,
      resourceId: result.exceptionId,
      parentResourceKind: 'itad.job',
      parentResourceId: result.jobId,
      tenantId: result.tenantId,
      organizationId: result.organizationId,
      snapshotAfter: {
        status: result.status,
        assignedToUserId: result.assignedToUserId,
        resolutionOutcome: result.resolutionOutcome,
      },
    }
  }
}

/**
 * Assigns, reassigns or unassigns an OPEN exception (E4-022). The assignee is any active
 * user of the job's organization (Q12). Assignment never resolves. Optimistic lock on the
 * exception's `updatedAt`.
 */
const assignCommand: CommandHandler<ItadExceptionAssignInput, ItadExceptionChangeResult> = {
  id: 'itad.exceptions.assign',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = itadExceptionAssignSchema.parse(rawInput)
    const { scope, actorUserId, em } = await resolveActor(ctx)
    await loadJob(em, scope, input.jobId)
    if (input.assignedToUserId) {
      const valid = await isOrganizationUser(ctx.container.resolve<QueryEngine>('queryEngine'), scope, input.assignedToUserId)
      if (!valid) return await exceptionError(400, 'assignee_invalid')
    }
    const outcome = await em.transactional(async (tx) => {
      const job = await lockJob(tx, scope, input.jobId)
      const exception = await loadException(tx, scope, job, input.exceptionId)
      lockException(ctx, exception)
      if (exception.status !== 'open') return await exceptionError(409, 'exception_resolved')
      const changed = assignException(tx, { exception, assignedToUserId: input.assignedToUserId, actorUserId, now: new Date() })
      await tx.flush()
      return { result: changeResult(scope, job, exception), changed }
    })
    if (outcome.changed) {
      try {
        await emitItadEvent('itad.exception.assigned', {
          exceptionId: outcome.result.exceptionId,
          jobId: outcome.result.jobId,
          assignedToUserId: outcome.result.assignedToUserId,
          actorUserId,
          tenantId: outcome.result.tenantId,
          organizationId: outcome.result.organizationId,
        })
      } catch (err) {
        logger.error('Failed to emit itad.exception.assigned', { err })
      }
    }
    return outcome.result
  },
  buildLog: exceptionLog('itad.audit.exceptions.assign', 'Assign ITAD exception'),
}

/**
 * Manager resolution of a MISSING_FROM_DELIVERY or UNEXPECTED_ASSET exception with an
 * outcome and a required reason (Q4, Q5). Never changes manifest or asset data. Other
 * types are resolved by their domain action (`resolve_through_domain_action`, E4-021).
 */
const resolveCommand: CommandHandler<ItadExceptionResolveInput, ItadExceptionChangeResult> = {
  id: 'itad.exceptions.resolve',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = itadExceptionResolveSchema.parse(rawInput)
    const { scope, actorUserId, em } = await resolveActor(ctx)
    await loadJob(em, scope, input.jobId)
    const result = await em.transactional(async (tx) => {
      const job = await lockJob(tx, scope, input.jobId)
      const exception = await loadException(tx, scope, job, input.exceptionId)
      lockException(ctx, exception)
      const decision = decideManualResolution({ type: exception.type, status: exception.status, outcome: input.outcome })
      if (!decision.ok) return await exceptionError(decision.code === 'outcome_invalid' ? 400 : 409, decision.code)
      const reason = resolveNote(input.reason, true)
      if (reason === false) return await exceptionError(400, 'reason_required')
      const change = resolveException(tx, {
        exception,
        outcome: input.outcome as ItadExceptionOutcome,
        reason,
        actorUserId,
        now: new Date(),
      })
      await tx.flush()
      return { ...changeResult(scope, job, exception), changes: change ? [change] : [] }
    })
    const { changes, ...publicResult } = result
    await emitExceptionChanges(changes, actorUserId)
    return publicResult
  },
  buildLog: exceptionLog('itad.audit.exceptions.resolve', 'Resolve ITAD exception'),
}

registerCommand(assignCommand)
registerCommand(resolveCommand)

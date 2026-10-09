import type { EntityManager } from '@mikro-orm/postgresql'
import { z } from 'zod'
import type { CommandHandler } from '@open-mercato/shared/lib/commands'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import { enforceCommandOptimisticLock } from '@open-mercato/shared/lib/crud/optimistic-lock-command'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { ItadJob, ItadJobConditionConfirmation, ItadJobStatusTransition } from '../data/entities'
import type { ItadJobStatus } from '../domain/job-types'
import { emitItadEvent } from '../events'
import { buildConditionDeps } from '../services/job-condition-evaluator'
import { decideTransition, type TransitionRejection } from '../domain/job-conditions'
import { isTerminalStatus } from '../domain/job-editability'
import { ITAD_JOB_ACTIONS, type ItadJobAction } from '../domain/job-state-machine'
import { itadJobError } from '../lib/errors'
import { lockJob } from './job-lock'
import { emitJobEffects, ensureScope, loadJob } from './jobs'

const logger = createLogger('itad').child({ component: 'transition' })

export const ITAD_JOB_LOCK_RESOURCE_KIND = 'itad.job'

export const itadJobTransitionSchema = z.object({
  id: z.string().uuid(),
  action: z.enum(ITAD_JOB_ACTIONS),
  reason: z.string().max(2000).nullable().optional(),
  confirmations: z
    .array(z.object({ condition: z.string().min(1).max(100), comment: z.string().max(2000).nullable().optional() }))
    .max(10)
    .optional(),
})

export type ItadJobTransitionInput = z.infer<typeof itadJobTransitionSchema>

export type ItadJobTransitionResult = {
  jobId: string
  transitionId: string
  action: ItadJobAction
  from: ItadJobStatus
  to: ItadJobStatus
  status: ItadJobStatus
  updatedAt: string
  confirmations: string[]
}

const REJECTION_MESSAGES: Record<TransitionRejection['code'], [string, string]> = {
  transition_not_allowed: ['itad.jobs.errors.transition_not_allowed', 'This status change is not allowed from the current status'],
  reason_required: ['itad.jobs.errors.reason_required', 'Enter a reason (3–1000 characters)'],
  comment_required: ['itad.jobs.errors.comment_required', 'Enter a comment for the manual confirmation (3–1000 characters)'],
  confirmation_duplicate: ['itad.jobs.errors.confirmation_duplicate', 'The same condition was confirmed more than once'],
  confirmation_not_allowed: ['itad.jobs.errors.confirmation_not_allowed', 'This condition cannot be confirmed manually'],
  confirmation_not_required: ['itad.jobs.errors.confirmation_not_required', 'This condition does not need a confirmation for this action'],
  condition_unmet: ['itad.jobs.errors.condition_unmet', 'Required conditions are not met'],
}

async function throwRejection(rejection: TransitionRejection): Promise<never> {
  const { translate } = await resolveTranslations()
  const [key, fallback] = REJECTION_MESSAGES[rejection.code]
  const extra: Record<string, unknown> = {}
  if (rejection.code === 'condition_unmet') extra.conditions = rejection.conditions
  if ('condition' in rejection) extra.condition = rejection.condition
  throw itadJobError(400, rejection.code, translate(key, fallback), undefined, extra)
}

/**
 * Applies one guarded status change (spec "Transition table"). The job row is locked;
 * the version check, conditions (evaluated with that transaction's facts), status-derived
 * fields, the history row and its confirmations commit in one transaction; events and
 * CRUD side effects run after commit. Not undoable: corrections
 * use the explicit backward transitions.
 *
 * The caller (route) has already checked `itad.jobs.transition` and, when confirmations
 * are present, `itad.jobs.confirm_conditions`.
 */
const transitionJobCommand: CommandHandler<ItadJobTransitionInput, ItadJobTransitionResult> = {
  id: 'itad.jobs.transition',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = itadJobTransitionSchema.parse(rawInput)
    const scope = await ensureScope(ctx)
    const actorUserId = ctx.auth?.sub ?? null
    if (!actorUserId) throw new Error('[internal] Transition requires an authenticated actor')
    const em = ctx.container.resolve<EntityManager>('em').fork()
    // 404 for a job outside the scope before any lock is taken.
    await loadJob(em, scope, input.id)
    const queryEngine = ctx.container.resolve<QueryEngine>('queryEngine')
    const now = new Date()
    const holder: {
      job?: ItadJob
      from?: ItadJobStatus
      to?: ItadJobStatus
      transition?: ItadJobStatusTransition
      confirmations?: Array<{ condition: string; comment: string }>
    } = {}

    // Manifest spec "Concurrency": the job row is locked first and the conditions are
    // evaluated inside the same transaction, so a scan, duplicate or manifest change
    // cannot slip in between `receivingComplete` being checked and the status change.
    await em.transactional(async (tx) => {
      const job = await lockJob(tx, scope, input.id)
      enforceCommandOptimisticLock({
        resourceKind: ITAD_JOB_LOCK_RESOURCE_KIND,
        resourceId: job.id,
        current: job.updatedAt,
        request: ctx.request ?? null,
      })
      if (isTerminalStatus(job.status)) {
        const { translate } = await resolveTranslations()
        throw itadJobError(409, 'terminal', translate('itad.jobs.errors.terminal', 'Completed or cancelled jobs cannot be changed'))
      }

      const decision = await decideTransition({
        job,
        action: input.action,
        reason: input.reason,
        confirmations: (input.confirmations ?? []).map((entry) => ({ condition: entry.condition, comment: entry.comment ?? null })),
        deps: buildConditionDeps({ em: tx, queryEngine, scope }),
      })
      if (!decision.ok) return await throwRejection(decision.rejection)

      const from = job.status
      const to = decision.target
      const reason = typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim() : null
      if (input.action === 'hold') {
        job.statusBeforeHold = from
        job.heldAt = now
        job.heldByUserId = actorUserId
        job.holdReason = reason
      } else if (from === 'on_hold') {
        job.statusBeforeHold = null
        job.heldAt = null
        job.heldByUserId = null
        job.holdReason = null
      }
      if (to === 'receiving' && !job.startedAt) job.startedAt = now
      if (to === 'completed') job.completedAt = now
      job.status = to
      job.updatedAt = now

      const transition = tx.create(ItadJobStatusTransition, {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        job,
        action: input.action,
        fromStatus: from,
        toStatus: to,
        reason,
        actorUserId,
        createdAt: now,
      })
      tx.persist(transition)
      for (const confirmation of decision.confirmations) {
        tx.persist(
          tx.create(ItadJobConditionConfirmation, {
            tenantId: scope.tenantId,
            organizationId: scope.organizationId,
            job,
            transition,
            condition: confirmation.condition,
            comment: confirmation.comment,
            confirmedByUserId: actorUserId,
            confirmedAt: now,
          }),
        )
      }
      await tx.flush()
      Object.assign(holder, { job, from, to, transition, confirmations: decision.confirmations })
    })

    const job = holder.job
    const from = holder.from
    const to = holder.to
    if (!job || !from || !to) throw new Error('[internal] Transition was not applied')
    const decision = { confirmations: holder.confirmations ?? [] }
    const transition = holder.transition
    if (!transition) throw new Error('[internal] Transition row missing')
    const transitionId = String(transition.id)

    // After commit: CRUD side effects (index, cache, `itad.job.updated`) and domain events.
    await emitJobEffects(ctx, 'updated', job, scope)
    try {
      await emitItadEvent(
        'itad.job.status_changed',
        {
          jobId: job.id,
          transitionId,
          action: input.action,
          from,
          to,
          actorUserId,
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
        },
        { persistent: true },
      )
      for (const confirmation of decision.confirmations) {
        await emitItadEvent(
          'itad.job.condition_manually_confirmed',
          {
            jobId: job.id,
            transitionId,
            condition: confirmation.condition,
            confirmedByUserId: actorUserId,
            tenantId: scope.tenantId,
            organizationId: scope.organizationId,
          },
          { persistent: true },
        )
      }
    } catch (err) {
      // The transition is committed; a failed emit must not report the change as failed.
      logger.error('Failed to emit ITAD job transition events', { err, jobId: job.id, transitionId })
    }

    return {
      jobId: job.id,
      transitionId,
      action: input.action,
      from,
      to,
      status: job.status,
      updatedAt: job.updatedAt.toISOString(),
      confirmations: decision.confirmations.map((entry) => entry.condition),
    }
  },
  buildLog: async ({ result }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('itad.audit.jobs.transition', 'Change ITAD job status'),
      resourceKind: ITAD_JOB_LOCK_RESOURCE_KIND,
      resourceId: result.jobId,
      changes: { status: { from: result.from, to: result.to } },
      payload: { action: result.action, transitionId: result.transitionId, confirmations: result.confirmations },
    }
  },
}

registerCommand(transitionJobCommand)


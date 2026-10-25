import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import { CrudHttpError, isCrudHttpError, notFound } from '@open-mercato/shared/lib/crud/errors'
import { enforceCommandOptimisticLock } from '@open-mercato/shared/lib/crud/optimistic-lock-command'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { RbacService } from '@open-mercato/core/modules/auth/services/rbacService'
import type { ItadAiAuditContext } from '../ai-tools/_writes'
import { ITAD_INBOX_ACTION_RESOURCE_KIND } from '../commands/inbox'
import { ItadException, ItadInboxAction, ItadInboxMessage, ItadJob } from '../data/entities'
import type { ItadInboxRecordDecisionInput } from '../data/validators'
import type { ItadExceptionType } from '../domain/exceptions'
import { reschedulePickupEligibility, resolveExceptionEligibility, resolvePickupInstant, type WriteEligibility } from '../lib/ai-write-rules'
import { runGuardedCommand } from '../lib/command-route'
import { resolveTrustedRecordRoute, type ItadRouteContext } from '../lib/route-context'

/**
 * Accept of an ITAD Inbox action (spec "Execute and audit"): the operator's decision runs
 * the same domain command as the UI, re-validated against the current state.
 *
 * 1. the action is still the version the operator saw, pending, complete;
 * 2. the operator holds the command's feature AND the target's view feature in the
 *    record's organization (`manage` does not imply `view` in RBAC);
 * 3. the target is still the version captured for the action — otherwise a change that
 *    made it ineligible fails the action, any other change answers 409 (rebuild in Match);
 * 4. the command runs through the mutation guard with the target version as its lock and
 *    the email audit context; its outcome is recorded on the action.
 */

const logger = createLogger('itad').child({ component: 'inbox-decisions' })

const COMMAND_FEATURES = {
  update_pickup: { manage: 'itad.jobs.manage', view: 'itad.jobs.view', commandId: 'itad.jobs.update' },
  resolve_exception: { manage: 'itad.exceptions.manage', view: 'itad.exceptions.view', commandId: 'itad.exceptions.resolve' },
} as const

const WRITE_MESSAGES: Record<string, string> = {
  field_locked: 'The pickup can no longer be rescheduled in the current job status',
  time_in_past: 'The pickup time is in the past',
  time_invalid: 'The pickup time is not a valid date and time',
  timezone_required: 'A local time needs its time zone',
  timezone_invalid: 'Unknown time zone',
  exception_resolved: 'The exception is no longer open',
  outcome_invalid: 'This outcome is not allowed for this exception type',
  reason_required: 'A reason of 3 to 1000 characters is required',
  resolve_through_domain_action: 'This exception type is resolved through its own action, not here',
}

async function fail(status: number, code: string, fallback: string): Promise<never> {
  const { translate } = await resolveTranslations()
  throw new CrudHttpError(status, { error: translate(`itad.inbox.errors.${code}`, fallback), code })
}

async function writeMessage(code: string): Promise<string> {
  const { translate } = await resolveTranslations()
  return translate(`itad.ai.write.${code}`, WRITE_MESSAGES[code] ?? code)
}

export type AcceptResult = { actionId: string; status: 'executed' | 'failed'; recordId: string | null; error: { code: string; message: string } | null }

export async function acceptInboxAction(
  route: ItadRouteContext,
  request: Request,
  input: { actionId: string; timeZone?: string },
): Promise<AcceptResult | { response: Response }> {
  const em = route.container.resolve<EntityManager>('em').fork()
  const tenantScope = { tenantId: route.tenantId }
  const action = await findOneWithDecryption(em, ItadInboxAction, { id: input.actionId, tenantId: route.tenantId } as never, undefined, tenantScope)
  if (!action || (route.readableOrganizationIds !== null && !route.readableOrganizationIds.includes(action.organizationId))) {
    const { translate } = await resolveTranslations()
    throw notFound(translate('itad.inbox.errors.action_not_found', 'Action not found'))
  }
  const scope = { tenantId: action.tenantId, organizationId: action.organizationId }
  const message = await findOneWithDecryption(em, ItadInboxMessage, { id: (action.message as unknown as { id: string }).id, ...scope } as never, undefined, scope)
  if (!message) throw notFound('Message not found')

  // 1. The action as the operator saw it.
  enforceCommandOptimisticLock({ resourceKind: ITAD_INBOX_ACTION_RESOURCE_KIND, resourceId: action.id, current: action.updatedAt, request })
  if (action.status !== 'pending') return fail(409, 'already_decided', 'This action was already decided')
  if (action.type === 'create_job') return fail(409, 'action_not_available', 'Creating a job from an email comes in a later release; create it from the jobs page')
  if (action.missingFields.length > 0) return fail(400, 'missing_fields', 'Fill in the missing values before accepting')
  const spec = COMMAND_FEATURES[action.type]
  // The decision is recorded in the action's organization, whatever organization the request selected.
  const decisionRoute = await resolveTrustedRecordRoute({
    userId: route.userId,
    tenantId: action.tenantId,
    organizationId: action.organizationId,
    isSuperAdmin: Boolean(route.ctx.auth?.isSuperAdmin),
    lockVersion: null,
  })

  // 2. Features in the record's organization: the command's and the target's view.
  const rbac = route.container.resolve<RbacService>('rbacService')
  if (!(await rbac.userHasAllFeatures(route.userId, [spec.manage, spec.view], scope))) return fail(403, 'forbidden', 'You are not allowed to make this change')

  // 3. The target, its version and eligibility now.
  const job = await em.findOne(ItadJob, { id: action.target.jobId, ...scope, deletedAt: null } as never)
  if (!job) return fail(404, 'target_not_found', 'The job or exception of this action no longer exists')
  const exception =
    action.type === 'resolve_exception'
      ? await em.findOne(ItadException, { id: action.target.exceptionId, ...scope, job: job.id } as never)
      : null
  if (action.type === 'resolve_exception' && !exception) return fail(404, 'target_not_found', 'The job or exception of this action no longer exists')
  const currentVersion = (exception ?? job).updatedAt.toISOString()

  let eligibility: WriteEligibility
  let commandInput: Record<string, unknown>
  if (action.type === 'update_pickup') {
    const zone = (typeof action.payload.timeZone === 'string' && action.payload.timeZone) || input.timeZone
    const instant = resolvePickupInstant(String(action.payload.scheduledPickupAt ?? ''), zone ?? undefined)
    if (!instant.ok) return fail(400, instant.code, await writeMessage(instant.code))
    eligibility = reschedulePickupEligibility({ job, at: instant.at, now: new Date() })
    commandInput = { id: job.id, scheduledPickupAt: instant.at.toISOString() }
  } else {
    eligibility = resolveExceptionEligibility({
      type: exception!.type as ItadExceptionType,
      status: exception!.status,
      outcome: String(action.payload.outcome ?? ''),
      reason: String(action.payload.reason ?? ''),
    })
    commandInput = { jobId: job.id, exceptionId: exception!.id, outcome: action.payload.outcome, reason: action.payload.reason }
  }
  if (!eligibility.ok && eligibility.level === 'input') return fail(400, eligibility.code, await writeMessage(eligibility.code))
  if (!eligibility.ok) {
    // The state no longer allows it: the action fails for good, with the domain reason.
    const error = { code: eligibility.code, message: await writeMessage(eligibility.code) }
    await recordDecision(decisionRoute, { actionId: action.id, outcome: 'failed', error })
    return { actionId: action.id, status: 'failed', recordId: null, error }
  }
  if (action.targetVersion && currentVersion !== action.targetVersion) {
    return fail(409, 'target_changed', 'The job or exception changed since the proposal; rebuild the action in Match or reprocess the email')
  }

  // 4. The domain command, as the operator, with the target version and the email audit context.
  const context: ItadAiAuditContext = {
    source: 'ai',
    channel: 'email',
    actionId: action.id,
    toolName: `inbox.${action.type}`,
    origin: { type: 'email', ...(message.messageId ? { messageId: message.messageId } : {}) },
    proposalId: message.id,
  }
  const trusted = await resolveTrustedRecordRoute({
    userId: route.userId,
    tenantId: action.tenantId,
    organizationId: action.organizationId,
    isSuperAdmin: Boolean(route.ctx.auth?.isSuperAdmin),
    lockVersion: currentVersion,
  })
  const resourceKind = action.type === 'update_pickup' ? 'itad.job' : 'itad.exception'
  const resourceId = action.type === 'update_pickup' ? job.id : exception!.id
  try {
    const outcome = await runGuardedCommand<Record<string, unknown>, unknown>(trusted, trusted.ctx.request as Request, {
      commandId: spec.commandId,
      input: commandInput,
      resourceKind,
      resourceId,
      operation: 'update',
      metadata: { context },
    })
    // A mutation guard (e.g. a record lock) refused: nothing ran, the action stays pending.
    if (!outcome.ok) return { response: outcome.response }
  } catch (err) {
    if (isCrudHttpError(err) && err.status < 500) {
      const code = typeof err.body?.code === 'string' ? err.body.code : 'domain_refused'
      const error = { code, message: typeof err.body?.error === 'string' ? err.body.error : 'The change was refused' }
      await recordDecision(decisionRoute, { actionId: action.id, outcome: 'failed', error })
      return { actionId: action.id, status: 'failed', recordId: null, error }
    }
    logger.error('Inbox accept failed', { actionId: action.id, err })
    throw err
  }
  await recordDecision(decisionRoute, { actionId: action.id, outcome: 'executed', recordId: resourceId, commandId: spec.commandId })
  return { actionId: action.id, status: 'executed', recordId: resourceId, error: null }
}

async function recordDecision(route: ItadRouteContext, input: ItadInboxRecordDecisionInput): Promise<void> {
  const commandBus = route.container.resolve<CommandBus>('commandBus')
  await commandBus.execute('itad.inbox.record_decision', { input, ctx: route.ctx })
}

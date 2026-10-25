import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import { CrudHttpError, notFound } from '@open-mercato/shared/lib/crud/errors'
import { enforceCommandOptimisticLock } from '@open-mercato/shared/lib/crud/optimistic-lock-command'
import { findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import type { RbacService } from '@open-mercato/core/modules/auth/services/rbacService'
import { ItadException, ItadInboxAction, ItadInboxMessage, ItadJob } from '../data/entities'
import {
  itadInboxActionFieldSchemas,
  itadInboxEditActionSchema,
  itadInboxImportSchema,
  itadInboxMessageRefSchema,
  itadInboxRecordDecisionSchema,
  itadInboxRejectActionSchema,
  itadInboxSelectMatchSchema,
  type ItadInboxEditActionInput,
  type ItadInboxImportInput,
  type ItadInboxMessageRefInput,
  type ItadInboxRecordDecisionInput,
  type ItadInboxRejectActionInput,
  type ItadInboxSelectMatchInput,
} from '../data/validators'
import { isStalled, type FieldSource, type InboxExtraction } from '../domain/inbox'
import type { EmailParts } from '../domain/inbox-matching'
import { TARGET_KEYS, isFullyDecided, missingFieldsOf, rebuildActions, type MatchLevels } from '../domain/inbox-proposals'
import { isCompanyInScope } from '../module-integrations/customers'
import { jobContext } from '../services/inbox-matcher'
import { createMessageEntity, enqueueProcessing } from '../services/inbox-intake'
import { buildRefreshedDraft } from '../services/inbox-processor'
import { ensureScope, type JobScope } from './jobs'

/**
 * User-initiated writes on ITAD's own Inbox records (spec 2026-10-24-itad-inbox-ops):
 * manual import, reprocess, refresh draft. Processing itself runs in the worker; these
 * commands only change the message and enqueue its current generation after commit.
 */

export const ITAD_INBOX_MESSAGE_RESOURCE_KIND = 'itad.inbox_message'

type Actor = { scope: JobScope; actorUserId: string; em: EntityManager }

async function resolveActor(ctx: CommandRuntimeContext): Promise<Actor> {
  const scope = await ensureScope(ctx)
  const actorUserId = ctx.auth?.sub ?? null
  if (!actorUserId) throw new Error('[internal] Inbox commands require an authenticated actor')
  return { scope, actorUserId, em: ctx.container.resolve<EntityManager>('em').fork() }
}

async function inboxError(status: number, code: string, fallback: string): Promise<never> {
  const { translate } = await resolveTranslations()
  throw new CrudHttpError(status, { error: translate(`itad.inbox.errors.${code}`, fallback), code })
}

async function loadMessage(em: EntityManager, scope: JobScope, messageId: string): Promise<ItadInboxMessage> {
  const message = await findOneWithDecryption(em, ItadInboxMessage, { id: messageId, ...scope, deletedAt: null }, undefined, scope)
  if (!message) {
    const { translate } = await resolveTranslations()
    throw notFound(translate('itad.inbox.errors.not_found', 'Message not found'))
  }
  return message
}

function lockMessage(ctx: CommandRuntimeContext, message: ItadInboxMessage): void {
  enforceCommandOptimisticLock({
    resourceKind: ITAD_INBOX_MESSAGE_RESOURCE_KIND,
    resourceId: message.id,
    current: message.updatedAt,
    request: ctx.request ?? null,
  })
}

type MessageResult = { messageId: string; tenantId: string; organizationId: string; generation: number; status: string }

const result = (message: ItadInboxMessage): MessageResult => ({
  messageId: message.id,
  tenantId: message.tenantId,
  organizationId: message.organizationId,
  generation: message.generation,
  status: message.status,
})

function messageLog(actionKey: string, fallback: string) {
  return async ({ result: changed }: { result: MessageResult }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate(actionKey, fallback),
      resourceKind: ITAD_INBOX_MESSAGE_RESOURCE_KIND,
      resourceId: changed.messageId,
      tenantId: changed.tenantId,
      organizationId: changed.organizationId,
      snapshotAfter: { status: changed.status, generation: changed.generation },
    }
  }
}

/** Manual import: the customer email typed or pasted by the operator (tests, demo recovery, debugging). */
const importCommand: CommandHandler<ItadInboxImportInput, MessageResult> = {
  id: 'itad.inbox.import',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = itadInboxImportSchema.parse(rawInput)
    const { scope, actorUserId, em } = await resolveActor(ctx)
    const message = createMessageEntity(em, scope, {
      source: 'manual',
      fromAddress: input.fromAddress,
      fromName: input.fromName ?? null,
      customerAddress: input.fromAddress,
      customerName: input.fromName ?? null,
      subject: input.subject,
      currentText: input.bodyText,
      receivedAt: input.receivedAt ? new Date(input.receivedAt) : new Date(),
      createdByUserId: actorUserId,
    })
    // Integration tests supply the interpretation so no model is called (spec "Model in tests").
    if (process.env.OM_TEST_MODE === '1' && input.extraction) message.extraction = input.extraction as unknown as InboxExtraction
    await em.persist(message).flush()
    await enqueueProcessing(message)
    return result(message)
  },
  buildLog: messageLog('itad.audit.inbox.import', 'Import email into ITAD Inbox'),
}

/**
 * Reprocess: a new generation of matching and interpretation. Allowed when the message
 * failed, stalled, or was proposed without any executed action; a late job of the old
 * generation then writes nothing.
 */
const reprocessCommand: CommandHandler<ItadInboxMessageRefInput, MessageResult> = {
  id: 'itad.inbox.reprocess',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = itadInboxMessageRefSchema.parse(rawInput)
    const { scope, em } = await resolveActor(ctx)
    const message = await loadMessage(em, scope, input.messageId)
    lockMessage(ctx, message)
    const executed = await em.count(ItadInboxAction, { message: message.id, status: 'executed' } as never)
    if (executed > 0) return inboxError(409, 'already_executed', 'An action of this message was already executed; it cannot be reprocessed')
    const allowed =
      message.status === 'failed' ||
      message.status === 'proposed' ||
      isStalled(message.status, message.processingStartedAt ?? null, new Date())
    if (!allowed) return inboxError(409, 'still_processing', 'The message is still being processed')
    message.generation += 1
    message.status = 'processing'
    message.processingStartedAt = new Date()
    message.processingError = null
    if (process.env.OM_TEST_MODE !== '1') message.extraction = null
    await em.flush()
    await enqueueProcessing(message)
    return result(message)
  },
  buildLog: messageLog('itad.audit.inbox.reprocess', 'Reprocess ITAD Inbox email'),
}

/** Refresh draft: the reply rebuilt from the job's current facts (US-IN-04). Never sent. */
const refreshDraftCommand: CommandHandler<ItadInboxMessageRefInput, MessageResult & { draftReply: string }> = {
  id: 'itad.inbox.refresh_draft',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = itadInboxMessageRefSchema.parse(rawInput)
    const { scope, em } = await resolveActor(ctx)
    const message = await loadMessage(em, scope, input.messageId)
    lockMessage(ctx, message)
    if (message.status === 'processing') return inboxError(409, 'still_processing', 'The message is still being processed')
    message.draftReply = await buildRefreshedDraft(ctx.container, message)
    message.draftGeneratedAt = new Date()
    await em.flush()
    return { ...result(message), draftReply: message.draftReply }
  },
  buildLog: messageLog('itad.audit.inbox.refreshDraft', 'Refresh ITAD Inbox reply draft'),
}

// ─── Phase 2: decisions (spec "Review", "Target vs fields") ──────────────────

export const ITAD_INBOX_ACTION_RESOURCE_KIND = 'itad.inbox_action'

type ActionResult = { actionId: string; messageId: string; tenantId: string; organizationId: string; status: string; messageStatus: string }

const actionResult = (action: ItadInboxAction, message: ItadInboxMessage): ActionResult => ({
  actionId: action.id,
  messageId: message.id,
  tenantId: action.tenantId,
  organizationId: action.organizationId,
  status: action.status,
  messageStatus: message.status,
})

function actionLog(actionKey: string, fallback: string) {
  return async ({ result: changed }: { result: ActionResult }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate(actionKey, fallback),
      resourceKind: ITAD_INBOX_ACTION_RESOURCE_KIND,
      resourceId: changed.actionId,
      parentResourceKind: ITAD_INBOX_MESSAGE_RESOURCE_KIND,
      parentResourceId: changed.messageId,
      tenantId: changed.tenantId,
      organizationId: changed.organizationId,
      snapshotAfter: { status: changed.status, messageStatus: changed.messageStatus },
    }
  }
}

async function loadAction(em: EntityManager, scope: JobScope, actionId: string): Promise<{ action: ItadInboxAction; message: ItadInboxMessage }> {
  const action = await findOneWithDecryption(em, ItadInboxAction, { id: actionId, ...scope }, undefined, scope)
  if (!action) {
    const { translate } = await resolveTranslations()
    throw notFound(translate('itad.inbox.errors.action_not_found', 'Action not found'))
  }
  const messageId = (action.message as unknown as { id: string }).id
  const message = await loadMessage(em, scope, messageId)
  return { action, message }
}

function lockAction(ctx: CommandRuntimeContext, action: ItadInboxAction): void {
  enforceCommandOptimisticLock({ resourceKind: ITAD_INBOX_ACTION_RESOURCE_KIND, resourceId: action.id, current: action.updatedAt, request: ctx.request ?? null })
}

async function requirePending(action: ItadInboxAction): Promise<void> {
  if (action.status !== 'pending') await inboxError(409, 'already_decided', 'This action was already decided')
}

/** Closes the message once every live action is decided (spec "Data Model", status `closed`). */
async function closeIfDecided(em: EntityManager, message: ItadInboxMessage): Promise<void> {
  const actions = await em.find(ItadInboxAction, { message: message.id } as never)
  if (isFullyDecided(actions.map((entry) => entry.status))) message.status = 'closed'
}

/** Edit: the action's fields only; a target key is refused, provenance becomes `operator`. */
const editActionCommand: CommandHandler<ItadInboxEditActionInput, ActionResult> = {
  id: 'itad.inbox.edit_action',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = itadInboxEditActionSchema.parse(rawInput)
    const { scope, em } = await resolveActor(ctx)
    const { action, message } = await loadAction(em, scope, input.actionId)
    lockAction(ctx, action)
    await requirePending(action)
    if (TARGET_KEYS.some((key) => key in input.payload)) {
      await inboxError(400, 'target_not_editable', 'The customer, job or exception changes only in the Match panel')
    }
    const fields = itadInboxActionFieldSchemas[action.type].parse(input.payload) as Record<string, unknown>
    const payload: Record<string, unknown> = { ...action.payload }
    const fieldSources: Record<string, FieldSource> = { ...action.fieldSources }
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue
      if (value === null || value === '') {
        delete payload[key]
        delete fieldSources[key]
      } else if (payload[key] !== value) {
        payload[key] = value
        fieldSources[key] = 'operator'
      }
    }
    action.payload = payload
    action.fieldSources = fieldSources
    action.missingFields = missingFieldsOf(action.type, action.target, payload)
    await em.flush()
    return actionResult(action, message)
  },
  buildLog: actionLog('itad.audit.inbox.editAction', 'Edit ITAD Inbox action'),
}

/** Reject: the action will not run; the reason is optional. */
const rejectActionCommand: CommandHandler<ItadInboxRejectActionInput, ActionResult> = {
  id: 'itad.inbox.reject_action',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = itadInboxRejectActionSchema.parse(rawInput)
    const { scope, actorUserId, em } = await resolveActor(ctx)
    const { action, message } = await loadAction(em, scope, input.actionId)
    lockAction(ctx, action)
    await requirePending(action)
    action.status = 'rejected'
    action.decidedByUserId = actorUserId
    action.decidedAt = new Date()
    action.rejectReason = input.reason?.trim() || null
    await em.flush()
    await closeIfDecided(em, message)
    await em.flush()
    return actionResult(action, message)
  },
  buildLog: actionLog('itad.audit.inbox.rejectAction', 'Reject ITAD Inbox action'),
}

/** After the domain command of an accepted action: its outcome on the action (executed or failed). */
const recordDecisionCommand: CommandHandler<ItadInboxRecordDecisionInput, ActionResult> = {
  id: 'itad.inbox.record_decision',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = itadInboxRecordDecisionSchema.parse(rawInput)
    const { scope, actorUserId, em } = await resolveActor(ctx)
    const { action, message } = await loadAction(em, scope, input.actionId)
    await requirePending(action)
    action.status = input.outcome
    action.decidedByUserId = actorUserId
    action.decidedAt = new Date()
    action.result = {
      ...(input.recordId ? { recordId: input.recordId } : {}),
      ...(input.commandId ? { commandId: input.commandId } : {}),
      ...(input.error ? { error: input.error } : {}),
    }
    await em.flush()
    await closeIfDecided(em, message)
    await em.flush()
    return actionResult(action, message)
  },
  buildLog: actionLog('itad.audit.inbox.acceptAction', 'Accept ITAD Inbox action'),
}

async function requireFeature(ctx: CommandRuntimeContext, userId: string, scope: JobScope, feature: string): Promise<void> {
  const rbac = ctx.container.resolve<RbacService>('rbacService')
  if (!(await rbac.userHasAllFeatures(userId, [feature], scope))) {
    await inboxError(403, 'forbidden', 'You are not allowed to make this change')
  }
}

/**
 * Match panel: the operator chooses the customer / job (and, per I3 action, the
 * exception). The undecided actions are superseded and rebuilt from the stored
 * extraction with the new target and its current version — no model call — keeping the
 * fields the operator edited. Only records the operator may read can be chosen.
 */
const selectMatchCommand: CommandHandler<ItadInboxSelectMatchInput, MessageResult> = {
  id: 'itad.inbox.select_match',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = itadInboxSelectMatchSchema.parse(rawInput)
    const { scope, actorUserId, em } = await resolveActor(ctx)
    const message = await loadMessage(em, scope, input.messageId)
    lockMessage(ctx, message)
    if (message.status === 'processing') return inboxError(409, 'still_processing', 'The message is still being processed')
    if (!message.extraction || !message.match) return inboxError(409, 'nothing_to_rebuild', 'The message has no interpretation to rebuild')

    let job: ItadJob | null = null
    const jobId = input.jobId === undefined ? message.match.jobId : input.jobId
    if (jobId) {
      await requireFeature(ctx, actorUserId, scope, 'itad.jobs.view')
      job = await em.findOne(ItadJob, { id: jobId, ...scope, deletedAt: null } as never)
      if (!job) {
        const { translate } = await resolveTranslations()
        throw notFound(translate('itad.jobs.errors.not_found', 'ITAD job not found'))
      }
    }
    let customerId = job ? job.customerId : input.customerId === undefined ? message.match.customerId : input.customerId
    if (!job && customerId) {
      await requireFeature(ctx, actorUserId, scope, 'itad.jobs.view')
      if (!(await isCompanyInScope(ctx.container.resolve<QueryEngine>('queryEngine'), scope, customerId))) {
        return inboxError(404, 'customer_not_found', 'Customer not found')
      }
    }
    customerId = customerId ?? null

    const context = job ? await jobContext(em, job) : null
    const levels: MatchLevels = {
      customer: { id: customerId, status: customerId ? 'high' : 'needs_review' },
      job: { id: job?.id ?? null, status: job ? 'high' : 'needs_review' },
      jobContext: context,
    }
    const live = (await findWithDecryption(em, ItadInboxAction, { message: message.id, status: { $ne: 'superseded' } } as never, { orderBy: { ordinal: 'asc' } }, scope))
    const undecided = live.filter((entry) => entry.status === 'pending')
    const decidedTypes = new Set(live.filter((entry) => entry.status !== 'pending').map((entry) => `${entry.type}:${JSON.stringify(entry.target)}`))
    if (input.actionTargets?.length) await requireFeature(ctx, actorUserId, scope, 'itad.exceptions.view')
    const chosenFor = new Map((input.actionTargets ?? []).map((entry) => [entry.actionId, entry.exceptionId]))
    const chosenExceptions = undecided.filter((entry) => entry.type === 'resolve_exception').map((entry) => chosenFor.get(entry.id) ?? null)
    const parts: EmailParts = { currentText: message.currentText, subject: message.subject, history: message.threadMessages.map((entry) => entry.body) }
    const rebuilt = rebuildActions(
      parts,
      message.extraction,
      levels,
      undecided.map((entry) => ({ type: entry.type, payload: entry.payload, fieldSources: entry.fieldSources })),
      chosenExceptions,
    ).filter((action) => !decidedTypes.has(`${action.type}:${JSON.stringify(action.target)}`))

    await em.transactional(async (tx) => {
      await tx.execute('select 1 from "itad_inbox_messages" where "id" = ? for update', [message.id])
      const maxOrdinal = live.reduce((max, entry) => (entry.generation === message.generation ? Math.max(max, entry.ordinal) : max), -1)
      await tx.nativeUpdate(ItadInboxAction, { id: { $in: undecided.map((entry) => entry.id) } } as never, { status: 'superseded' })
      const managed = await tx.findOneOrFail(ItadInboxMessage, { id: message.id, tenantId: message.tenantId })
      rebuilt.forEach((action, index) => {
        tx.persist(
          tx.create(ItadInboxAction, {
            tenantId: managed.tenantId,
            organizationId: managed.organizationId,
            message: managed,
            generation: managed.generation,
            ordinal: maxOrdinal + 1 + index,
            type: action.type,
            target: action.target,
            payload: action.payload,
            originalPayload: action.payload,
            fieldSources: action.fieldSources,
            matchStatus: action.matchStatus,
            missingFields: action.missingFields,
            targetVersion: action.targetVersion,
            status: 'pending',
          } as never),
        )
      })
      managed.match = {
        ...message.match!,
        customerId,
        customerStatus: levels.customer.status,
        jobId: job?.id ?? null,
        jobStatus: levels.job.status,
        overridden: true,
      }
      managed.jobId = job?.id ?? null
      await tx.flush()
      message.updatedAt = managed.updatedAt
      message.status = managed.status
    })
    return result(message)
  },
  buildLog: messageLog('itad.audit.inbox.selectMatch', 'Choose the match of an ITAD Inbox email'),
}

/** Close a message that needs no action (e.g. an email that fits no intent). */
const closeMessageCommand: CommandHandler<ItadInboxMessageRefInput, MessageResult> = {
  id: 'itad.inbox.close',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = itadInboxMessageRefSchema.parse(rawInput)
    const { scope, em } = await resolveActor(ctx)
    const message = await loadMessage(em, scope, input.messageId)
    lockMessage(ctx, message)
    if (message.status === 'processing') return inboxError(409, 'still_processing', 'The message is still being processed')
    const pending = await em.count(ItadInboxAction, { message: message.id, status: 'pending' } as never)
    if (pending > 0) return inboxError(409, 'pending_actions', 'Decide or reject the pending actions first')
    message.status = 'closed'
    await em.flush()
    return result(message)
  },
  buildLog: messageLog('itad.audit.inbox.close', 'Close ITAD Inbox email'),
}

registerCommand(importCommand)
registerCommand(reprocessCommand)
registerCommand(refreshDraftCommand)
registerCommand(editActionCommand)
registerCommand(rejectActionCommand)
registerCommand(recordDecisionCommand)
registerCommand(selectMatchCommand)
registerCommand(closeMessageCommand)

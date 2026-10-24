import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import { CrudHttpError, notFound } from '@open-mercato/shared/lib/crud/errors'
import { enforceCommandOptimisticLock } from '@open-mercato/shared/lib/crud/optimistic-lock-command'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { ItadInboxAction, ItadInboxMessage } from '../data/entities'
import {
  itadInboxImportSchema,
  itadInboxMessageRefSchema,
  type ItadInboxImportInput,
  type ItadInboxMessageRefInput,
} from '../data/validators'
import { isStalled, type InboxExtraction } from '../domain/inbox'
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

registerCommand(importCommand)
registerCommand(reprocessCommand)
registerCommand(refreshDraftCommand)

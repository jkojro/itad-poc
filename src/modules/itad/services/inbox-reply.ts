import { createElement } from 'react'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import { notFound } from '@open-mercato/shared/lib/crud/errors'
import { enforceCommandOptimisticLock } from '@open-mercato/shared/lib/crud/optimistic-lock-command'
import { isEmailDeliveryDisabled, resolveDefaultEmailFromAddress } from '@open-mercato/shared/lib/email/config'
import { sendEmail } from '@open-mercato/shared/lib/email/send'
import { getRegisteredEmailTransport } from '@open-mercato/shared/lib/email/transport'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { parseBooleanWithDefault } from '@open-mercato/shared/lib/boolean'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import type { RbacService } from '@open-mercato/core/modules/auth/services/rbacService'
import { NextResponse } from 'next/server'
import { ITAD_INBOX_MESSAGE_RESOURCE_KIND } from '../commands/inbox'
import { ItadInboxMessage } from '../data/entities'
import type { ItadInboxRecordReplyInput, ItadInboxSendReplyInput } from '../data/validators'
import { replySendState } from '../domain/inbox'
import type { ItadAiAuditContext } from '../ai-tools/_writes'
import { resolveTrustedRecordRoute, type ItadRouteContext } from '../lib/route-context'
import { readOrganizationInboxAddress } from '../module-integrations/inbox-ops'

const logger = createLogger('itad').child({ component: 'inbox-reply' })

/** The features a Send needs: the reply feature, and the job view the draft is built from. */
export const REPLY_FEATURES = ['itad.inbox.reply', 'itad.jobs.view'] as const

export type EmailDelivery = { available: true } | { available: false; reason: 'email_not_configured' | 'email_delivery_disabled' }

/**
 * Whether `sendEmail` can deliver. In test mode the framework captures every email to a file
 * and delivers nothing, so Send works without a provider; otherwise a sender address and a
 * configured transport (communication_channels) are needed. `OM_DISABLE_EMAIL_DELIVERY`
 * would drop the email silently, so it makes Send unavailable rather than falsely "sent".
 */
export function emailDelivery(): EmailDelivery {
  if (parseBooleanWithDefault(process.env.OM_TEST_MODE, false)) return { available: true }
  if (isEmailDeliveryDisabled()) return { available: false, reason: 'email_delivery_disabled' }
  if (!resolveDefaultEmailFromAddress()) return { available: false, reason: 'email_not_configured' }
  const transport = getRegisteredEmailTransport()
  if (!transport || transport.isConfigured?.() === false) return { available: false, reason: 'email_not_configured' }
  return { available: true }
}

async function fail(status: number, code: string, fallback: string): Promise<{ response: Response }> {
  const { translate } = await resolveTranslations()
  return { response: NextResponse.json({ error: translate(`itad.inbox.errors.${code}`, fallback), code }, { status }) }
}

/** The body as a minimal React element: the framework renders it to HTML and captures its text in tests. */
const replyElement = (body: string) => createElement('div', { style: { whiteSpace: 'pre-wrap', fontFamily: 'Arial, sans-serif', fontSize: '14px' } }, body)

export type SendReplyResult = { messageId: string; sentAt: string; toAddress: string }

/**
 * Phase 4 Send (spec "Phase 4 — Send the reply"): one reply from the app per inbound email,
 * always to the customer sender, Reply-To the organization's Inbox address. The message is
 * claimed atomically before sending so a double click sends one email; the email leaves
 * through the framework transport outside any transaction, then `itad.inbox.record_reply`
 * records it with the email audit context. A failed send releases the claim for a retry.
 */
export async function sendInboxReply(
  route: ItadRouteContext,
  request: Request,
  input: ItadInboxSendReplyInput & { messageId: string },
): Promise<SendReplyResult | { response: Response }> {
  const em = route.container.resolve<EntityManager>('em').fork()
  const tenantScope = { tenantId: route.tenantId }
  const message = await findOneWithDecryption(em, ItadInboxMessage, { id: input.messageId, tenantId: route.tenantId, deletedAt: null } as never, undefined, tenantScope)
  if (!message || (route.readableOrganizationIds !== null && !route.readableOrganizationIds.includes(message.organizationId))) {
    const { translate } = await resolveTranslations()
    throw notFound(translate('itad.inbox.errors.not_found', 'Message not found'))
  }
  const scope = { tenantId: message.tenantId, organizationId: message.organizationId }

  // The message as the operator saw it, the features in its organization, its reply state.
  enforceCommandOptimisticLock({ resourceKind: ITAD_INBOX_MESSAGE_RESOURCE_KIND, resourceId: message.id, current: message.updatedAt, request })
  const rbac = route.container.resolve<RbacService>('rbacService')
  if (!(await rbac.userHasAllFeatures(route.userId, [...REPLY_FEATURES], scope))) return fail(403, 'forbidden', 'You are not allowed to send replies')
  if (message.status === 'processing') return fail(409, 'still_processing', 'The email is still being processed')
  const state = replySendState(message.replySentAt ?? null, message.replySendClaimedAt ?? null, new Date())
  if (state === 'sent') return fail(409, 'reply_already_sent', 'A reply to this email was already sent from the app')
  if (state === 'sending') return fail(409, 'reply_in_progress', 'A reply to this email is being sent')
  if (state === 'unconfirmed' && !input.confirmPossibleDuplicate) {
    return fail(409, 'reply_may_have_been_sent', 'An earlier send did not finish; the email may already have been delivered')
  }
  const delivery = emailDelivery()
  if (!delivery.available) return fail(503, delivery.reason, 'Sending email is not configured')

  const replyTo = await readOrganizationInboxAddress(route.container.resolve<QueryEngine>('queryEngine'), scope)
  const toAddress = message.customerAddress

  // Atomic claim: still unsent and unchanged since the operator saw it.
  const claimed = await route.container
    .resolve<EntityManager>('em')
    .fork()
    .nativeUpdate(
      ItadInboxMessage,
      { id: message.id, ...scope, replySentAt: null, updatedAt: message.updatedAt } as never,
      { replySendClaimedAt: new Date(), updatedAt: new Date() } as never,
    )
  if (claimed !== 1) return fail(409, 'reply_in_progress', 'A reply to this email is being sent')

  try {
    await sendEmail({
      to: toAddress,
      subject: input.subject,
      text: input.body,
      react: replyElement(input.body),
      ...(replyTo ? { replyTo } : {}),
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
    })
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    // Configuration problems are not worth a retry: name them. The Resend adapter validates
    // the sender as a bare address, so `Name <email>` in EMAIL_FROM fails on `fromAddress`.
    const code = /fromAddress/.test(raw) ? 'email_sender_invalid' : /NOT_CONFIGURED/.test(raw) ? 'email_not_configured' : 'send_failed'
    logger.warn('Inbox reply not sent', { messageId: message.id, code, err })
    const { translate } = await resolveTranslations()
    const fallback: Record<string, string> = {
      email_sender_invalid: 'The sender address (EMAIL_FROM) must be a plain email address, e.g. operations@example.com',
      email_not_configured: 'Sending email is not configured',
      send_failed: 'The email could not be sent; try again',
    }
    const safe = translate(`itad.inbox.errors.${code}`, fallback[code])
    await route.container
      .resolve<EntityManager>('em')
      .fork()
      .nativeUpdate(ItadInboxMessage, { id: message.id, ...scope, replySentAt: null } as never, { replySendClaimedAt: null, replyError: { code, message: safe }, updatedAt: new Date() } as never)
    return { response: NextResponse.json({ error: safe, code }, { status: code === 'send_failed' ? 502 : 503 }) }
  }

  // Recorded as the operator in the message's organization, with the email audit context.
  const recordRoute = await resolveTrustedRecordRoute({
    userId: route.userId,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    isSuperAdmin: Boolean(route.ctx.auth?.isSuperAdmin),
    lockVersion: null,
  })
  const context: ItadAiAuditContext = {
    source: 'ai',
    channel: 'email',
    // A reply has no action row: the message itself is the decided item.
    actionId: message.id,
    toolName: 'inbox.send_reply',
    origin: { type: 'email', ...(message.messageId ? { messageId: message.messageId } : {}) },
    proposalId: message.id,
  }
  const recordInput: ItadInboxRecordReplyInput = { messageId: message.id, toAddress, replyTo, subject: input.subject, body: input.body }
  await route.container.resolve<CommandBus>('commandBus').execute('itad.inbox.record_reply', { input: recordInput, ctx: recordRoute.ctx, metadata: { context } })
  return { messageId: message.id, sentAt: new Date().toISOString(), toAddress }
}

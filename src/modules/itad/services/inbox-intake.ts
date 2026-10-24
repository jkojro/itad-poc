import type { EntityManager } from '@mikro-orm/postgresql'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { ItadInboxMessage } from '../data/entities'
import { INBOX_TEXT_MAX, type InboxMessageSource } from '../domain/inbox'
import { resolveCustomerSender } from '../domain/inbox-matching'
import { getInboxQueue } from '../lib/inbox-queue'
import { readInboxEmail, type InboxEmailReceivedPayload } from '../module-integrations/inbox-ops'
import { listOrganizationUsers } from '../module-integrations/users'

/**
 * Intake of ITAD Inbox Ops (spec "Snapshot", "Processing idempotency"): turns an
 * `inbox_ops` email or a manual import into ITAD's own message snapshot and enqueues its
 * processing. Receiving a message that already has a snapshot never just returns: while
 * it has no processing result, its current generation is enqueued again (the framework
 * has no transactional outbox, so this closes "snapshot saved, process died before
 * enqueue"). A duplicate job is harmless — the worker writes once per generation.
 */

const logger = createLogger('itad').child({ component: 'inbox-intake' })

export type Scope = { tenantId: string; organizationId: string }
export type Resolver = { resolve: <T = unknown>(name: string) => T }

export type NewInboxMessage = {
  source: InboxMessageSource
  inboxEmailId?: string | null
  messageId?: string | null
  inReplyTo?: string | null
  fromAddress: string
  fromName?: string | null
  customerAddress: string
  customerName?: string | null
  forwardedByUserId?: string | null
  subject: string
  currentText: string
  threadMessages?: Array<{ from: string | null; date: string | null; body: string; isForwarded?: boolean }>
  receivedAt: Date
  createdByUserId?: string | null
}

export async function enqueueProcessing(message: Pick<ItadInboxMessage, 'id' | 'tenantId' | 'organizationId' | 'generation'>): Promise<void> {
  await getInboxQueue().enqueue({
    messageId: message.id,
    tenantId: message.tenantId,
    organizationId: message.organizationId,
    generation: message.generation,
  })
}

export function createMessageEntity(em: EntityManager, scope: Scope, input: NewInboxMessage): ItadInboxMessage {
  return em.create(ItadInboxMessage, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    source: input.source,
    inboxEmailId: input.inboxEmailId ?? null,
    messageId: input.messageId ?? null,
    inReplyTo: input.inReplyTo ?? null,
    fromAddress: input.fromAddress.toLowerCase(),
    fromName: input.fromName ?? null,
    customerAddress: input.customerAddress.toLowerCase(),
    customerName: input.customerName ?? null,
    forwardedByUserId: input.forwardedByUserId ?? null,
    subject: input.subject.slice(0, 1000),
    currentText: input.currentText.slice(0, INBOX_TEXT_MAX),
    threadMessages: (input.threadMessages ?? []).map((message) => ({ ...message, body: message.body.slice(0, INBOX_TEXT_MAX) })),
    receivedAt: input.receivedAt,
    createdByUserId: input.createdByUserId ?? null,
    status: 'processing',
    generation: 1,
    processingStartedAt: new Date(),
    intents: [],
  } as never)
}

/** The organization user an address belongs to, if any (forwarded-sender rule). */
async function organizationUserIdByEmail(queryEngine: QueryEngine, scope: Scope, address: string): Promise<string | null> {
  const wanted = address.trim().toLowerCase()
  const users = await listOrganizationUsers(queryEngine, scope, { limit: 500 })
  return users.find((user) => user.email?.toLowerCase() === wanted)?.id ?? null
}

/**
 * `inbox_ops.email.received` → ITAD snapshot (idempotent on the `inbox_ops` email id) →
 * processing enqueued. Returns the message id, or null when the email cannot be read.
 */
export async function intakeInboxEmail(container: Resolver, payload: InboxEmailReceivedPayload): Promise<string | null> {
  const scope = { tenantId: payload.tenantId, organizationId: payload.organizationId }
  const em = container.resolve<EntityManager>('em').fork()
  const existing = await findOneWithDecryption(em, ItadInboxMessage, { tenantId: scope.tenantId, inboxEmailId: payload.emailId }, undefined, scope)
  if (existing) {
    if (existing.status === 'processing') await enqueueProcessing(existing)
    return existing.id
  }
  const queryEngine = container.resolve<QueryEngine>('queryEngine')
  const email = await readInboxEmail(queryEngine, scope, payload.emailId)
  if (!email) {
    logger.warn('Inbox email not readable; skipped', { emailId: payload.emailId })
    return null
  }
  const forwardedByUserId = await organizationUserIdByEmail(queryEngine, scope, email.fromAddress)
  const sender = resolveCustomerSender({
    envelope: { address: email.fromAddress, name: email.fromName },
    currentText: email.currentText,
    thread: email.thread,
    envelopeIsOrganizationUser: forwardedByUserId !== null,
  })
  const message = createMessageEntity(em, scope, {
    source: 'email',
    inboxEmailId: email.id,
    messageId: email.messageId,
    inReplyTo: email.inReplyTo,
    fromAddress: email.fromAddress,
    fromName: email.fromName,
    customerAddress: sender.customer.address,
    customerName: sender.customer.name,
    forwardedByUserId: sender.forwardedByOrganizationUser ? forwardedByUserId : null,
    subject: email.subject,
    currentText: sender.currentText,
    threadMessages: sender.history.map((entry) => ({ from: entry.from, date: null, body: entry.body, isForwarded: entry.isForwarded })),
    receivedAt: email.receivedAt,
  })
  try {
    await em.persist(message).flush()
  } catch (err) {
    // A concurrent delivery created it first (unique tenant + email id): keep the invariant.
    const raced = await findOneWithDecryption(em.fork(), ItadInboxMessage, { tenantId: scope.tenantId, inboxEmailId: payload.emailId }, undefined, scope)
    if (!raced) throw err
    if (raced.status === 'processing') await enqueueProcessing(raced)
    return raced.id
  }
  await enqueueProcessing(message)
  return message.id
}

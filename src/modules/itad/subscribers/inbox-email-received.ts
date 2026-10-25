import { createLogger } from '@open-mercato/shared/lib/logger'
import { INBOX_EMAIL_RECEIVED_EVENT, type InboxEmailReceivedPayload } from '../module-integrations/inbox-ops'
import { intakeInboxEmail, type Resolver } from '../services/inbox-intake'

const logger = createLogger('itad').child({ component: 'inbox-intake' })

/**
 * ITAD Inbox Ops intake (spec "Architecture"): an email received by `inbox_ops` becomes an
 * ITAD inbox message and its processing is enqueued. Persistent, so a crash or an error
 * before the snapshot and the enqueue finish redelivers the event; the intake is
 * idempotent and re-enqueues a snapshot that has no result yet. Runs only when the
 * optional `inbox_ops` module emits the event.
 */
export const metadata = {
  event: INBOX_EMAIL_RECEIVED_EVENT,
  persistent: true,
  id: 'itad:inbox-email-received',
}

type SubscriberContext = Resolver & { container?: Resolver }

const readId = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null)

export default async function handleInboxEmailReceived(payload: unknown, ctx: SubscriberContext): Promise<void> {
  const data = (payload ?? {}) as Partial<InboxEmailReceivedPayload>
  const emailId = readId(data.emailId)
  const tenantId = readId(data.tenantId)
  const organizationId = readId(data.organizationId)
  if (!emailId || !tenantId || !organizationId) return
  const container = ctx.container ?? { resolve: ctx.resolve }
  const messageId = await intakeInboxEmail(container, { emailId, tenantId, organizationId })
  if (!messageId) logger.warn('Inbox email skipped', { emailId })
}

import type { QueryEngine } from '@open-mercato/shared/lib/query/types'

/**
 * Reads emails received by the installed `inbox_ops` module (ITAD Inbox Ops, spec Q1
 * hybrid). The only place ITAD touches `inbox_ops` data: through the query engine by
 * entity id — never its ORM classes — so ITAD holds just the scalar email id. The engine
 * applies the tenant / organization guards and decrypts the encrypted columns (subject,
 * texts, sender, thread). The event id and these fields are a contract covered by
 * TC-ITAD-910.
 */
export const INBOX_EMAIL_ENTITY_ID = 'inbox_ops:inbox_email'
export const INBOX_EMAIL_RECEIVED_EVENT = 'inbox_ops.email.received'

export type InboxEmailReceivedPayload = {
  emailId: string
  tenantId: string
  organizationId: string
  forwardedByAddress?: string
  subject?: string
}

type ThreadMessageRow = {
  messageId?: string
  from?: { name?: string; email?: string }
  subject?: string
  date?: string
  body?: string
  isForwarded?: boolean
}

type InboxEmailRow = {
  id: string
  message_id?: string | null
  forwarded_by_address?: string | null
  forwarded_by_name?: string | null
  subject?: string | null
  in_reply_to?: string | null
  cleaned_text?: string | null
  raw_text?: string | null
  thread_messages?: ThreadMessageRow[] | string | null
  received_at?: string | Date | null
}

export type InboxEmailSnapshot = {
  id: string
  messageId: string | null
  inReplyTo: string | null
  fromAddress: string
  fromName: string | null
  subject: string
  currentText: string
  thread: Array<{ from: string | null; fromName: string | null; date: string | null; body: string; isForwarded: boolean }>
  receivedAt: Date
}

function parseThread(raw: InboxEmailRow['thread_messages']): ThreadMessageRow[] {
  if (!raw) return []
  if (Array.isArray(raw)) return raw
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as ThreadMessageRow[]) : []
  } catch {
    return []
  }
}

export async function readInboxEmail(
  queryEngine: QueryEngine,
  scope: { tenantId: string; organizationId: string },
  emailId: string,
): Promise<InboxEmailSnapshot | null> {
  const result = await queryEngine.query<InboxEmailRow>(INBOX_EMAIL_ENTITY_ID, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    fields: ['id', 'message_id', 'forwarded_by_address', 'forwarded_by_name', 'subject', 'in_reply_to', 'cleaned_text', 'raw_text', 'thread_messages', 'received_at'],
    filters: { id: emailId },
    page: { page: 1, pageSize: 1 },
  })
  const row = result.items[0]
  if (!row || !row.forwarded_by_address) return null
  return {
    id: row.id,
    messageId: row.message_id ?? null,
    inReplyTo: row.in_reply_to ?? null,
    fromAddress: row.forwarded_by_address,
    fromName: row.forwarded_by_name ?? null,
    subject: row.subject ?? '',
    currentText: row.cleaned_text ?? row.raw_text ?? '',
    thread: parseThread(row.thread_messages).map((message) => ({
      from: message.from?.email ?? null,
      fromName: message.from?.name ?? null,
      date: message.date ?? null,
      body: message.body ?? '',
      isForwarded: Boolean(message.isForwarded),
    })),
    receivedAt: row.received_at ? new Date(row.received_at) : new Date(),
  }
}

export const INBOX_SETTINGS_ENTITY_ID = 'inbox_ops:inbox_settings'

/**
 * The organization's active inbound address (phase 4 Reply-To), so a customer's answer to a
 * sent reply comes back into the Inbox. Null when `inbox_ops` has none for the organization.
 */
export async function readOrganizationInboxAddress(
  queryEngine: QueryEngine,
  scope: { tenantId: string; organizationId: string },
): Promise<string | null> {
  const result = await queryEngine.query<{ inbox_address?: string | null; is_active?: boolean | null }>(INBOX_SETTINGS_ENTITY_ID, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    fields: ['inbox_address', 'is_active'],
    filters: { is_active: true },
    page: { page: 1, pageSize: 1 },
  })
  const address = result.items[0]?.inbox_address
  return typeof address === 'string' && address.trim() ? address.trim() : null
}

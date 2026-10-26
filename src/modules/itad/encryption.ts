import type { ModuleEncryptionMap } from '@open-mercato/shared/modules/encryption'

/**
 * ITAD Inbox Ops (spec 2026-10-24-itad-inbox-ops): customer emails, their senders, the
 * model's reading of them, drafts and the customer text carried by actions (reasons,
 * locations) are tenant personal data. Columns used in lookups or unique indexes
 * (`inbox_email_id`, `message_id`, statuses, ids) stay plaintext.
 */
export const defaultEncryptionMaps: ModuleEncryptionMap[] = [
  {
    entityId: 'itad:itad_inbox_message',
    fields: [
      { field: 'from_address' },
      { field: 'from_name' },
      { field: 'customer_address' },
      { field: 'customer_name' },
      { field: 'subject' },
      { field: 'current_text' },
      { field: 'thread_messages' },
      { field: 'extraction' },
      { field: 'summary' },
      { field: 'draft_reply' },
      { field: 'reply_to_address' },
      { field: 'reply_subject' },
      { field: 'reply_body' },
    ],
  },
  {
    entityId: 'itad:itad_inbox_action',
    fields: [{ field: 'payload' }, { field: 'original_payload' }],
  },
]

export default defaultEncryptionMaps

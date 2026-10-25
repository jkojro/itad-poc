import { describe, expect, it } from '@jest/globals'
import { MetadataStorage } from '@mikro-orm/core'
import inboxOpsEvents from '@open-mercato/core/modules/inbox_ops/events'
import { InboxEmail } from '@open-mercato/core/modules/inbox_ops/data/entities'
import { INBOX_EMAIL_RECEIVED_EVENT } from '../inbox-ops'

/**
 * TC-ITAD-910, installed side (Inbox Ops spec Q1 hybrid): the `inbox_ops` event ITAD
 * subscribes to and the `InboxEmail` columns `readInboxEmail` selects exist in the
 * installed module. An upgrade that renames either fails here, before an email is lost.
 * The delivered payload and the mapped values are covered by the integration test.
 */
describe('inbox_ops contract (TC-ITAD-910)', () => {
  it('declares the received event ITAD subscribes to', () => {
    const ids = inboxOpsEvents.events.map((event: { id: string }) => event.id)
    expect(ids).toContain(INBOX_EMAIL_RECEIVED_EVENT)
  })

  it('InboxEmail has every column ITAD reads', () => {
    const meta = Object.values(MetadataStorage.getMetadata()).find((entry) => entry.class === InboxEmail)
    expect(meta).toBeDefined()
    // Before discovery the decorator metadata holds the explicit column in `fieldName`.
    const columns = Object.values(meta!.properties).map((property) => (property as { fieldName?: string }).fieldName ?? property.name)
    expect(columns).toEqual(
      expect.arrayContaining([
        'id',
        'message_id',
        'forwarded_by_address',
        'forwarded_by_name',
        'subject',
        'in_reply_to',
        'cleaned_text',
        'raw_text',
        'thread_messages',
        'received_at',
      ]),
    )
  })
})

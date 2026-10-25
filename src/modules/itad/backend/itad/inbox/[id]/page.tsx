import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { InboxMessageDetail } from '../../../../components/InboxMessageDetail'

export default function ItadInboxMessagePage({ params }: { params?: { id?: string } }) {
  const id = params?.id
  if (!id) return null
  return (
    <Page>
      <PageBody>
        <InboxMessageDetail messageId={id} />
      </PageBody>
    </Page>
  )
}

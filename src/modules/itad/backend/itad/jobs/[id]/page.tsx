import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { JobDetailForm } from '../../../../components/JobForm'

export default function ItadJobDetailPage({ params }: { params?: { id?: string } }) {
  const id = params?.id
  if (!id) return null

  return (
    <Page>
      <PageBody>
        <JobDetailForm id={id} />
      </PageBody>
    </Page>
  )
}

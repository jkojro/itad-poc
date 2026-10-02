import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { JobCreateForm } from '../../../../components/JobForm'

export default function CreateItadJobPage() {
  return (
    <Page>
      <PageBody>
        <JobCreateForm />
      </PageBody>
    </Page>
  )
}

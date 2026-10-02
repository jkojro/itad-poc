import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import JobsTable from '../../../components/JobsTable'

export default function ItadJobsPage() {
  return (
    <Page>
      <PageBody>
        <JobsTable />
      </PageBody>
    </Page>
  )
}

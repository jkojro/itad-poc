import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { AssetDetail } from '../../../../../../components/AssetDetail'

export default function ItadAssetDetailPage({ params }: { params?: { id?: string; assetId?: string } }) {
  const jobId = params?.id
  const assetId = params?.assetId
  if (!jobId || !assetId) return null

  return (
    <Page>
      <PageBody>
        <AssetDetail jobId={jobId} assetId={assetId} />
      </PageBody>
    </Page>
  )
}

"use client"

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import type { InjectionWidgetComponentProps } from '@open-mercato/shared/modules/widgets/injection'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import { RowActions } from '@open-mercato/ui/backend/RowActions'
import { Button } from '@open-mercato/ui/primitives/button'
import { Alert, AlertDescription } from '@open-mercato/ui/primitives/alert'
import { fetchCrudList } from '@open-mercato/ui/backend/utils/crud'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { buildJobColumns } from '../../../components/job-columns'
import type { ItadJobListItem } from '../../../components/types'
import { ITAD_JOB_ENTITY_ID } from '../../../lib/constants'

const API_PATH = 'itad/jobs'
const LIST_HREF = '/backend/itad/jobs'
const PAGE_SIZE = 20

type JobsResponse = {
  items: ItadJobListItem[]
  total: number
  totalPages: number
}

/** The host passes `companyId` (and `resourceId`) in the injection context. */
function readCompanyId(context: unknown): string | null {
  if (!context || typeof context !== 'object') return null
  const ctx = context as Record<string, unknown>
  if (typeof ctx.companyId === 'string' && ctx.companyId) return ctx.companyId
  return typeof ctx.resourceId === 'string' && ctx.resourceId ? ctx.resourceId : null
}

export default function CompanyJobsTabWidget({ context }: InjectionWidgetComponentProps) {
  const t = useT()
  const router = useRouter()
  const companyId = React.useMemo(() => readCompanyId(context), [context])
  const [page, setPage] = React.useState(1)
  const columns = React.useMemo(() => buildJobColumns(t, { includeCustomer: false }), [t])
  const createHref = companyId ? `${LIST_HREF}/create?customerId=${encodeURIComponent(companyId)}` : `${LIST_HREF}/create`

  const { data, isLoading, error } = useQuery<JobsResponse>({
    queryKey: ['itad-jobs', 'company', companyId, page],
    enabled: Boolean(companyId),
    queryFn: async () =>
      fetchCrudList<ItadJobListItem>(API_PATH, {
        customerId: companyId,
        page: String(page),
        pageSize: String(PAGE_SIZE),
        sortField: 'reference',
        sortDir: 'desc',
      }),
  })

  if (!companyId) return null

  if (error) {
    return (
      <Alert status="error">
        <AlertDescription>{t('itad.jobs.companyTab.error', 'Could not load ITAD jobs for this company')}</AlertDescription>
      </Alert>
    )
  }

  return (
    <DataTable<ItadJobListItem>
      title={t('itad.jobs.companyTab.title', 'ITAD jobs of this company')}
      actions={(
        <Button asChild>
          <Link href={createHref}>{t('itad.jobs.actions.create', 'New job')}</Link>
        </Button>
      )}
      columns={columns}
      data={data?.items ?? []}
      entityId={ITAD_JOB_ENTITY_ID}
      extensionTableId="itad.jobs.customer"
      emptyState={(
        <div className="flex flex-col items-center gap-3 py-8 text-center">
          <p className="text-sm text-muted-foreground">{t('itad.jobs.companyTab.empty', 'No ITAD jobs for this company')}</p>
          <Button asChild variant="outline">
            <Link href={createHref}>{t('itad.jobs.actions.create', 'New job')}</Link>
          </Button>
        </div>
      )}
      rowActions={(row) => (
        <RowActions
          items={[{ id: 'itad.jobs.open', label: t('itad.jobs.actions.open', 'Open'), href: `${LIST_HREF}/${row.id}` }]}
        />
      )}
      pagination={{
        page,
        pageSize: PAGE_SIZE,
        total: data?.total ?? 0,
        totalPages: data?.totalPages ?? 0,
        onPageChange: setPage,
      }}
      isLoading={isLoading}
      onRowClick={(row) => router.push(`${LIST_HREF}/${row.id}`)}
    />
  )
}

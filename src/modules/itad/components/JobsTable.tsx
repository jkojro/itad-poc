"use client"
import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { LegacyColumnDef as ColumnDef } from '@tanstack/react-table/legacy'
import type { SortingState } from '@tanstack/react-table'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import { RowActions } from '@open-mercato/ui/backend/RowActions'
import type { FilterValues } from '@open-mercato/ui/backend/FilterBar'
import type { FilterOption } from '@open-mercato/ui/backend/FilterOverlay'
import { Button } from '@open-mercato/ui/primitives/button'
import { StatusBadge } from '@open-mercato/ui/primitives/status-badge'
import { Alert, AlertDescription } from '@open-mercato/ui/primitives/alert'
import { fetchCrudList, deleteCrud } from '@open-mercato/ui/backend/utils/crud'
import { readApiResultOrThrow, withScopedApiRequestHeaders } from '@open-mercato/ui/backend/utils/apiCall'
import { buildOptimisticLockHeader } from '@open-mercato/ui/backend/utils/optimisticLock'
import { surfaceRecordConflict } from '@open-mercato/ui/backend/conflicts'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { useOrganizationScopeVersion } from '@open-mercato/shared/lib/frontend/useOrganizationScope'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import {
  ITAD_JOB_STATUSES,
  ITAD_JOB_STATUS_FALLBACK_LABELS,
  ITAD_JOB_STATUS_VARIANTS,
  itadJobStatusLabelKey,
} from './jobStatus'
import type { ItadJobListItem } from './types'
import { ITAD_JOB_ENTITY_ID } from '../lib/constants'

const API_PATH = 'itad/jobs'
const LIST_HREF = '/backend/itad/jobs'
const PAGE_SIZE = 50

type JobsResponse = {
  items: ItadJobListItem[]
  total: number
  page: number
  pageSize: number
  totalPages: number
  totalIsCapped?: boolean
}

type Translate = ReturnType<typeof useT>

function formatDateTime(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()
}

function buildColumns(t: Translate): ColumnDef<ItadJobListItem>[] {
  return [
    {
      id: 'reference',
      accessorKey: 'internalReference',
      header: t('itad.jobs.table.column.reference', 'Reference'),
      meta: { priority: 1 },
      cell: ({ row }) => (
        <span className="flex flex-col">
          <span className="font-medium">{row.original.internalReference}</span>
          {row.original.customerReference ? (
            <span className="text-xs text-muted-foreground">{row.original.customerReference}</span>
          ) : null}
        </span>
      ),
    },
    { accessorKey: 'name', header: t('itad.jobs.table.column.name', 'Name'), meta: { priority: 2 } },
    {
      accessorKey: 'customerName',
      header: t('itad.jobs.table.column.customer', 'Customer'),
      enableSorting: false,
      meta: { priority: 3 },
      cell: ({ row }) =>
        row.original.customerName ?? (
          <span className="text-muted-foreground">{t('itad.jobs.customer.deleted', 'Deleted customer')}</span>
        ),
    },
    {
      accessorKey: 'status',
      header: t('itad.jobs.table.column.status', 'Status'),
      meta: { priority: 1 },
      cell: ({ row }) => (
        <StatusBadge variant={ITAD_JOB_STATUS_VARIANTS[row.original.status] ?? 'neutral'} dot>
          {t(itadJobStatusLabelKey(row.original.status), ITAD_JOB_STATUS_FALLBACK_LABELS[row.original.status])}
        </StatusBadge>
      ),
    },
    {
      id: 'scheduledPickupAt',
      accessorKey: 'scheduledPickupAt',
      header: t('itad.jobs.table.column.scheduledPickupAt', 'Scheduled pickup'),
      meta: { priority: 4 },
      cell: ({ row }) => formatDateTime(row.original.scheduledPickupAt),
    },
    {
      id: 'updatedAt',
      accessorKey: 'updatedAt',
      header: t('itad.jobs.table.column.updatedAt', 'Updated'),
      meta: { priority: 5 },
      cell: ({ row }) => formatDateTime(row.original.updatedAt),
    },
  ]
}

async function loadCompanyOptions(query: string | undefined, errorMessage: string): Promise<FilterOption[]> {
  const params = new URLSearchParams({ pageSize: '20', sortField: 'name', sortDir: 'asc' })
  if (query && query.trim()) params.set('search', query.trim())
  const payload = await readApiResultOrThrow<{ items?: Array<{ id?: unknown; display_name?: unknown }> }>(
    `/api/customers/companies?${params.toString()}`,
    undefined,
    { errorMessage },
  )
  const items = Array.isArray(payload?.items) ? payload.items : []
  return items.flatMap((item) =>
    typeof item.id === 'string' && typeof item.display_name === 'string'
      ? [{ value: item.id, label: item.display_name }]
      : [],
  )
}

export default function JobsTable() {
  const t = useT()
  const router = useRouter()
  const queryClient = useQueryClient()
  const { confirm, ConfirmDialogElement } = useConfirmDialog()
  const scopeVersion = useOrganizationScopeVersion()
  const [search, setSearch] = React.useState('')
  const [filterValues, setFilterValues] = React.useState<FilterValues>({})
  const [sorting, setSorting] = React.useState<SortingState>([{ id: 'reference', desc: true }])
  const [page, setPage] = React.useState(1)

  const queryParams = React.useMemo(() => {
    const params: Record<string, string> = {
      page: String(page),
      pageSize: String(PAGE_SIZE),
      sortField: sorting[0]?.id || 'reference',
      sortDir: sorting[0]?.desc === false ? 'asc' : 'desc',
    }
    if (search.trim()) params.search = search.trim()
    const status = filterValues.status
    if (Array.isArray(status) && status.length > 0) params.status = status.map(String).join(',')
    else if (typeof status === 'string' && status) params.status = status
    if (typeof filterValues.customerId === 'string' && filterValues.customerId) params.customerId = filterValues.customerId
    return params
  }, [filterValues, page, search, sorting])

  const { data, isLoading, error } = useQuery<JobsResponse>({
    queryKey: ['itad-jobs', queryParams, scopeVersion],
    queryFn: async () => fetchCrudList<ItadJobListItem>(API_PATH, queryParams),
  })

  const columns = React.useMemo(() => buildColumns(t), [t])

  const statusOptions = React.useMemo<FilterOption[]>(
    () =>
      ITAD_JOB_STATUSES.map((status) => ({
        value: status,
        label: t(itadJobStatusLabelKey(status), ITAD_JOB_STATUS_FALLBACK_LABELS[status]),
      })),
    [t],
  )

  const companyLoadError = t('itad.jobs.table.error.customers', 'Could not load customers')
  const filters = React.useMemo(
    () => [
      { id: 'status', label: t('itad.jobs.table.filters.status', 'Status'), type: 'select' as const, multiple: true, options: statusOptions },
      {
        id: 'customerId',
        label: t('itad.jobs.table.filters.customer', 'Customer'),
        type: 'combobox' as const,
        loadOptions: (query?: string) => loadCompanyOptions(query, companyLoadError),
      },
    ],
    [companyLoadError, statusOptions, t],
  )

  const handleDelete = React.useCallback(
    async (row: ItadJobListItem) => {
      const confirmed = await confirm({
        title: t('itad.jobs.table.confirm.delete', 'Delete this draft job?'),
        variant: 'destructive',
      })
      if (!confirmed) return
      try {
        await withScopedApiRequestHeaders(buildOptimisticLockHeader(row.updatedAt), () => deleteCrud(API_PATH, row.id))
        flash(t('itad.jobs.flash.deleted', 'Job deleted'), 'success')
        await queryClient.invalidateQueries({ queryKey: ['itad-jobs'] })
      } catch (err) {
        if (surfaceRecordConflict(err, t)) {
          await queryClient.invalidateQueries({ queryKey: ['itad-jobs'] })
          return
        }
        const message = err instanceof Error && err.message ? err.message : t('itad.jobs.table.error.delete', 'Could not delete the job')
        flash(message, 'error')
      }
    },
    [confirm, queryClient, t],
  )

  if (error) {
    return (
      <Alert status="error">
        <AlertDescription>{t('itad.jobs.table.error.load', 'Could not load ITAD jobs')}</AlertDescription>
      </Alert>
    )
  }

  return (
    <>
      <DataTable<ItadJobListItem>
        title={t('itad.jobs.page.title', 'ITAD Jobs')}
        titleHeadingLevel={1}
        actions={(
          <Button asChild>
            <Link href={`${LIST_HREF}/create`}>{t('itad.jobs.actions.create', 'New job')}</Link>
          </Button>
        )}
        columns={columns}
        data={data?.items ?? []}
        searchValue={search}
        searchPlaceholder={t('itad.jobs.table.search', 'Search by reference or name')}
        onSearchChange={(value) => {
          setSearch(value)
          setPage(1)
        }}
        searchAlign="right"
        filters={filters}
        filterValues={filterValues}
        onFiltersApply={(values: FilterValues) => {
          setFilterValues(values)
          setPage(1)
        }}
        onFiltersClear={() => {
          setFilterValues({})
          setPage(1)
        }}
        entityId={ITAD_JOB_ENTITY_ID}
        extensionTableId="itad.jobs.list"
        sortable
        sorting={sorting}
        onSortingChange={(next: SortingState) => {
          setSorting(next)
          setPage(1)
        }}
        emptyState={(
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <p className="text-sm text-muted-foreground">{t('itad.jobs.table.empty', 'No ITAD jobs yet')}</p>
            <Button asChild variant="outline">
              <Link href={`${LIST_HREF}/create`}>{t('itad.jobs.actions.create', 'New job')}</Link>
            </Button>
          </div>
        )}
        rowActions={(row) => (
          <RowActions
            items={[
              { id: 'itad.jobs.open', label: t('itad.jobs.actions.open', 'Open'), href: `${LIST_HREF}/${row.id}` },
              ...(row.status === 'draft'
                ? [{
                    id: 'itad.jobs.delete',
                    label: t('itad.jobs.actions.delete', 'Delete'),
                    destructive: true,
                    onSelect: () => handleDelete(row),
                  }]
                : []),
            ]}
          />
        )}
        pagination={{
          page,
          pageSize: PAGE_SIZE,
          total: data?.total ?? 0,
          totalPages: data?.totalPages ?? 0,
          totalIsCapped: data?.totalIsCapped === true,
          onPageChange: setPage,
        }}
        isLoading={isLoading}
        onRowClick={(row) => router.push(`${LIST_HREF}/${row.id}`)}
      />
      {ConfirmDialogElement}
    </>
  )
}

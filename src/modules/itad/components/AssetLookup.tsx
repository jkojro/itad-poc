"use client"
import * as React from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import type { LegacyColumnDef as ColumnDef } from '@tanstack/react-table/legacy'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import { RowActions } from '@open-mercato/ui/backend/RowActions'
import { Alert, AlertDescription } from '@open-mercato/ui/primitives/alert'
import { StatusBadge } from '@open-mercato/ui/primitives/status-badge'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { useOrganizationScopeVersion } from '@open-mercato/shared/lib/frontend/useOrganizationScope'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { normalizeSerial } from '../domain/serial'
import type { ItadJobStatus } from '../domain/job-types'
import { ITAD_ASSET_ENTITY_ID } from '../lib/constants'
import { ITAD_JOB_STATUS_FALLBACK_LABELS, ITAD_JOB_STATUS_VARIANTS, itadJobStatusLabelKey } from './job-status'

type Translate = ReturnType<typeof useT>

const MIN_LENGTH = 3
const PAGE_SIZE = 25

type LookupRow = {
  id: string
  serial: string
  status: string
  exactMatch: boolean
  receivedAt: string
  jobId: string
  jobReference: string
  jobStatus: ItadJobStatus
  customerName: string | null
}

const receivingHref = (jobId: string) => `/backend/itad/jobs/${encodeURIComponent(jobId)}?tab=receiving`

function buildColumns(t: Translate): ColumnDef<LookupRow>[] {
  return [
    {
      id: 'serial',
      header: t('itad.manifest.field.serial', 'Serial number'),
      cell: ({ row }) => (
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono">{row.original.serial}</span>
          {row.original.exactMatch ? <StatusBadge variant="info">{t('itad.assets.lookup.exact', 'Exact match')}</StatusBadge> : null}
        </span>
      ),
    },
    {
      id: 'job',
      header: t('itad.assets.lookup.job', 'Job'),
      cell: ({ row }) => (
        <Link className="underline underline-offset-2" href={receivingHref(row.original.jobId)}>
          {row.original.jobReference}
        </Link>
      ),
    },
    {
      id: 'customer',
      header: t('itad.jobs.table.column.customer', 'Customer'),
      cell: ({ row }) => row.original.customerName ?? <span className="text-muted-foreground">{t('itad.jobs.customer.deleted', 'Deleted customer')}</span>,
    },
    {
      id: 'jobStatus',
      header: t('itad.jobs.table.column.status', 'Status'),
      cell: ({ row }) => (
        <StatusBadge variant={ITAD_JOB_STATUS_VARIANTS[row.original.jobStatus] ?? 'neutral'} dot>
          {t(itadJobStatusLabelKey(row.original.jobStatus), ITAD_JOB_STATUS_FALLBACK_LABELS[row.original.jobStatus])}
        </StatusBadge>
      ),
    },
    {
      id: 'receivedAt',
      header: t('itad.receiving.assets.receivedAt', 'Received'),
      cell: ({ row }) => new Date(row.original.receivedAt).toLocaleString(),
    },
  ]
}

/**
 * Serial lookup across the jobs the user can read (manifest spec REQ-107): exact or
 * prefix match, at least 3 characters; each result opens the job's Receiving tab.
 */
export default function AssetLookup() {
  const t = useT()
  const router = useRouter()
  const scopeVersion = useOrganizationScopeVersion()
  const [search, setSearch] = React.useState('')
  const [page, setPage] = React.useState(1)
  const columns = React.useMemo(() => buildColumns(t), [t])
  const serial = normalizeSerial(search)
  const enabled = serial.length >= MIN_LENGTH

  const { data, isLoading, error } = useQuery<{ items: LookupRow[]; total: number }>({
    queryKey: ['itad-asset-lookup', serial, page, scopeVersion],
    enabled,
    queryFn: async () => {
      const params = new URLSearchParams({ serial, page: String(page), pageSize: String(PAGE_SIZE) })
      return readApiResultOrThrow(`/api/itad/assets?${params.toString()}`, undefined, {
        errorMessage: t('itad.assets.lookup.error', 'Could not search the assets'),
      })
    },
  })

  if (error) {
    return <Alert status="error"><AlertDescription>{t('itad.assets.lookup.error', 'Could not search the assets')}</AlertDescription></Alert>
  }

  return (
    <DataTable<LookupRow>
      title={t('itad.assets.lookup.title', 'Find a device by serial number')}
      titleHeadingLevel={1}
      columns={columns}
      data={enabled ? data?.items ?? [] : []}
      searchValue={search}
      searchPlaceholder={t('itad.assets.lookup.search', 'Serial number or its beginning (at least 3 characters)')}
      onSearchChange={(value) => {
        setSearch(value)
        setPage(1)
      }}
      entityId={ITAD_ASSET_ENTITY_ID}
      extensionTableId="itad.assets.lookup"
      emptyState={(
        <p className="py-8 text-center text-sm text-muted-foreground">
          {enabled
            ? t('itad.assets.lookup.empty', 'No received device has a serial starting with this text.')
            : t('itad.assets.lookup.hint', 'Type at least 3 characters of a serial number. Search covers all jobs you can access.')}
        </p>
      )}
      rowActions={(row) => (
        <RowActions items={[{ id: 'itad.assets.lookup.open', label: t('itad.assets.lookup.open', 'Open receiving'), href: receivingHref(row.jobId) }]} />
      )}
      onRowClick={(row) => router.push(receivingHref(row.jobId))}
      pagination={{
        page,
        pageSize: PAGE_SIZE,
        total: enabled ? data?.total ?? 0 : 0,
        totalPages: Math.max(1, Math.ceil((enabled ? data?.total ?? 0 : 0) / PAGE_SIZE)),
        onPageChange: setPage,
      }}
      isLoading={enabled && isLoading}
    />
  )
}

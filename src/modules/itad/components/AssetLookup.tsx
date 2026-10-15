"use client"
import * as React from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import type { LegacyColumnDef as ColumnDef } from '@tanstack/react-table/legacy'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import { FilterBar } from '@open-mercato/ui/backend/FilterBar'
import { RowActions } from '@open-mercato/ui/backend/RowActions'
import { Alert, AlertDescription } from '@open-mercato/ui/primitives/alert'
import { StatusBadge } from '@open-mercato/ui/primitives/status-badge'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { useOrganizationScopeVersion } from '@open-mercato/shared/lib/frontend/useOrganizationScope'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { normalizeSerial } from '../domain/serial'
import type { ItadAssetStatus, ItadJobStatus } from '../domain/job-types'
import { ITAD_ASSET_ENTITY_ID } from '../lib/constants'
import { ASSET_STATUS_VARIANTS, assetStatusLabel } from './data-bearing-ui'
import { ITAD_JOB_STATUS_FALLBACK_LABELS, ITAD_JOB_STATUS_VARIANTS, itadJobStatusLabelKey } from './job-status'

type Translate = ReturnType<typeof useT>

const MIN_LENGTH = 3
const PAGE_SIZE = 25

type LookupRow = {
  id: string
  serial: string
  customerAssetTag: string | null
  manufacturer: string | null
  model: string | null
  status: ItadAssetStatus
  matchedOn: 'serial' | 'customerAssetTag'
  exactMatch: boolean
  receivedAt: string
  jobId: string
  jobReference: string
  jobName: string
  jobStatus: ItadJobStatus
  customerName: string | null
}

const receivingHref = (jobId: string) => `/backend/itad/jobs/${encodeURIComponent(jobId)}?tab=receiving`
const detailHref = (jobId: string, assetId: string) => `/backend/itad/jobs/${encodeURIComponent(jobId)}/assets/${encodeURIComponent(assetId)}`

function buildColumns(t: Translate): ColumnDef<LookupRow>[] {
  return [
    {
      id: 'serial',
      header: t('itad.manifest.field.serial', 'Serial number'),
      meta: { truncate: false },
      cell: ({ row }) => (
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono">{row.original.serial}</span>
          {row.original.exactMatch ? <StatusBadge variant="info">{t('itad.assets.lookup.exact', 'Exact match')}</StatusBadge> : null}
        </span>
      ),
    },
    {
      id: 'customerAssetTag',
      header: t('itad.assets.lookup.tag', 'Customer asset tag'),
      cell: ({ row }) =>
        row.original.customerAssetTag ? <span className="font-mono">{row.original.customerAssetTag}</span> : <span className="text-muted-foreground">—</span>,
    },
    {
      id: 'device',
      header: t('itad.assets.lookup.device', 'Manufacturer / model'),
      meta: { priority: 3 },
      cell: ({ row }) => [row.original.manufacturer, row.original.model].filter(Boolean).join(' ') || <span className="text-muted-foreground">—</span>,
    },
    {
      id: 'customer',
      header: t('itad.jobs.table.column.customer', 'Customer'),
      cell: ({ row }) => row.original.customerName ?? <span className="text-muted-foreground">{t('itad.jobs.customer.deleted', 'Deleted customer')}</span>,
    },
    {
      id: 'job',
      header: t('itad.assets.lookup.job', 'Job'),
      meta: { truncate: false },
      cell: ({ row }) => (
        // The row opens the device; this link opens the job, so it must not reach the row.
        <span className="block space-y-0.5">
          <Link className="underline underline-offset-2" href={receivingHref(row.original.jobId)} onClick={(event) => event.stopPropagation()}>
            {row.original.jobReference}
          </Link>
          <span className="block text-xs text-muted-foreground">{row.original.jobName}</span>
        </span>
      ),
    },
    {
      // Read live on every search; the platform's global search never shows a status.
      id: 'status',
      header: t('itad.assets.lookup.status', 'Device status'),
      meta: { truncate: false },
      cell: ({ row }) => (
        <span className="flex flex-wrap gap-1">
          <StatusBadge variant={ASSET_STATUS_VARIANTS[row.original.status] ?? 'neutral'} dot>
            {assetStatusLabel(t, row.original.status)}
          </StatusBadge>
          <StatusBadge variant={ITAD_JOB_STATUS_VARIANTS[row.original.jobStatus] ?? 'neutral'}>
            {t(itadJobStatusLabelKey(row.original.jobStatus), ITAD_JOB_STATUS_FALLBACK_LABELS[row.original.jobStatus])}
          </StatusBadge>
        </span>
      ),
    },
  ]
}

/**
 * Asset search across the jobs the user can read (manifest spec REQ-107; operations
 * dashboard spec "Asset search"): serial number or customer asset tag, exact or prefix,
 * at least 3 characters. Every match is listed with its customer, job and live status;
 * a row opens the device. The query lives in the URL (`?q=`), so the dashboard search box
 * and the global search can link here.
 */
export default function AssetLookup() {
  const t = useT()
  const router = useRouter()
  const searchParams = useSearchParams()
  const scopeVersion = useOrganizationScopeVersion()
  const [search, setSearch] = React.useState(() => searchParams?.get('q') ?? '')
  const [page, setPage] = React.useState(1)
  const columns = React.useMemo(() => buildColumns(t), [t])
  const serial = normalizeSerial(search)
  const enabled = serial.length >= MIN_LENGTH

  const { data, isLoading, error } = useQuery<{ items: LookupRow[]; total: number }>({
    queryKey: ['itad-asset-lookup', serial, page, scopeVersion],
    enabled,
    queryFn: async () => {
      const params = new URLSearchParams({ q: serial, page: String(page), pageSize: String(PAGE_SIZE) })
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
      title={t('itad.assets.lookup.titleSearch', 'Find a device by serial number or customer asset tag')}
      titleHeadingLevel={1}
      columns={columns}
      data={enabled ? data?.items ?? [] : []}
      // The search lives in the toolbar, not in DataTable's own search, so the page keeps
      // its own states: a hint below 3 characters and "No asset found for …" (spec §19).
      toolbar={(
        <FilterBar
          searchValue={search}
          searchPlaceholder={t('itad.assets.lookup.searchAny', 'Serial number or customer asset tag (at least 3 characters)')}
          onSearchChange={(value) => {
            setSearch(value)
            setPage(1)
            const params = new URLSearchParams(searchParams?.toString() ?? '')
            if (value.trim()) params.set('q', value.trim())
            else params.delete('q')
            const query = params.toString()
            router.replace(query ? `?${query}` : '?', { scroll: false })
          }}
        />
      )}
      entityId={ITAD_ASSET_ENTITY_ID}
      extensionTableId="itad.assets.lookup"
      emptyState={(
        <p className="py-8 text-center text-sm text-muted-foreground">
          {enabled
            ? t('itad.assets.lookup.noResult', 'No asset found for "{query}".', { query: search.trim() })
            : t('itad.assets.lookup.hintAny', 'Type at least 3 characters of a serial number or customer asset tag. Search covers all jobs you can access.')}
        </p>
      )}
      rowActions={(row) => (
        <RowActions
          items={[
            { id: 'itad.assets.details', label: t('itad.assetDetail.open', 'Details'), href: detailHref(row.jobId, row.id) },
            { id: 'itad.assets.lookup.open', label: t('itad.assets.lookup.open', 'Open receiving'), href: receivingHref(row.jobId) },
          ]}
        />
      )}
      onRowClick={(row) => router.push(detailHref(row.jobId, row.id))}
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

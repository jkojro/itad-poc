"use client"
import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import type { LegacyColumnDef as ColumnDef } from '@tanstack/react-table/legacy'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import { FilterBar, type FilterValues } from '@open-mercato/ui/backend/FilterBar'
import { SectionHeader } from '@open-mercato/ui/backend/SectionHeader'
import { Alert, AlertDescription } from '@open-mercato/ui/primitives/alert'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Spinner } from '@open-mercato/ui/primitives/spinner'
import { StatusBadge } from '@open-mercato/ui/primitives/status-badge'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import {
  ACTIVE_JOB_STATUSES,
  type AttentionSeverity,
  type AttentionSignalKey,
  type JobOverviewCounters,
  type JobOverviewGroup,
  type JobSeverity,
} from '../domain/job-overview'
import type { ItadJobStatus } from '../domain/job-types'
import { ITAD_JOB_STATUS_FALLBACK_LABELS, ITAD_JOB_STATUS_VARIANTS, itadJobStatusLabelKey } from './job-status'
import { ATTENTION_VARIANTS, attentionSignalLabel } from './JobOverviewPanel'
import { AskAssistantButton } from './AskAssistantButton'
import { operationsDashboardContext } from '../lib/ai-page-context'

type Translate = ReturnType<typeof useT>

type OperationsJob = {
  id: string
  internalReference: string
  name: string
  status: ItadJobStatus
  statusBeforeHold: ItadJobStatus | null
  customer: { id: string; name: string | null }
  scheduledPickupAt: string | null
  counters: JobOverviewCounters
  signals: Array<{ key: AttentionSignalKey; severity: AttentionSeverity; count: number; href: string }>
  severity: JobSeverity
  group: JobOverviewGroup
}

type OperationsResponse = {
  items: OperationsJob[]
  customers: Array<{ id: string; name: string | null }>
  truncated: boolean
}

const SECTIONS: Array<{ id: string; groups: JobOverviewGroup[]; titleKey: string; title: string }> = [
  { id: 'attention', groups: ['attention_red', 'attention_orange'], titleKey: 'itad.operations.group.attention', title: 'Needs attention' },
  { id: 'in_progress', groups: ['in_progress'], titleKey: 'itad.operations.group.inProgress', title: 'In progress' },
  { id: 'upcoming', groups: ['upcoming'], titleKey: 'itad.operations.group.upcoming', title: 'Upcoming' },
  { id: 'draft', groups: ['draft'], titleKey: 'itad.operations.group.drafts', title: 'Drafts' },
]

const FLAG_FILTERS = ['openExceptions', 'missing', 'failed', 'missingCertificates'] as const

const jobHref = (id: string, query?: string) => `/backend/itad/jobs/${encodeURIComponent(id)}${query ? `?${query}` : ''}`

function formatDate(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString(undefined, { dateStyle: 'medium' })
}

function statusLabel(t: Translate, status: ItadJobStatus): string {
  return t(itadJobStatusLabelKey(status), ITAD_JOB_STATUS_FALLBACK_LABELS[status])
}

function buildColumns(t: Translate): ColumnDef<OperationsJob>[] {
  return [
    {
      id: 'job',
      header: t('itad.operations.column.job', 'Job'),
      meta: { truncate: false },
      cell: ({ row }) => (
        <Link href={jobHref(row.original.id)} className="block space-y-0.5 underline-offset-2 hover:underline">
          <span className="block font-medium">
            {row.original.customer.name ?? t('itad.operations.unknownCustomer', 'Unknown customer')} · {row.original.internalReference}
          </span>
          <span className="block text-xs text-muted-foreground">{row.original.name}</span>
        </Link>
      ),
    },
    {
      id: 'status',
      header: t('itad.operations.column.status', 'Status'),
      meta: { truncate: false },
      cell: ({ row }) => {
        const job = row.original
        const shown = job.status === 'on_hold' && job.statusBeforeHold ? job.statusBeforeHold : job.status
        return (
          <div className="flex flex-wrap gap-1">
            <StatusBadge variant={ITAD_JOB_STATUS_VARIANTS[shown]} dot>{statusLabel(t, shown)}</StatusBadge>
            {job.status === 'on_hold' ? <StatusBadge variant="warning">{statusLabel(t, 'on_hold')}</StatusBadge> : null}
          </div>
        )
      },
    },
    {
      id: 'pickup',
      header: t('itad.operations.column.pickup', 'Pickup'),
      meta: { priority: 4 },
      cell: ({ row }) => formatDate(row.original.scheduledPickupAt),
    },
    {
      id: 'receiving',
      header: t('itad.operations.column.receiving', 'Receiving'),
      meta: { priority: 3, truncate: false },
      cell: ({ row }) => {
        const { counters, status, statusBeforeHold } = row.original
        if (counters.expected === 0 && counters.totalIntake === 0) return '—'
        const receiving = (status === 'on_hold' ? statusBeforeHold : status) === 'receiving'
        return (
          <div className="space-y-0.5">
            <span className="block">
              {counters.received} / {counters.expected}
              {counters.unexpected > 0 ? (
                <span className="text-muted-foreground"> {t('itad.operations.plusUnexpected', '+{count} unexpected', { count: counters.unexpected })}</span>
              ) : null}
            </span>
            {receiving && counters.missing > 0 ? (
              <span className="block text-xs text-muted-foreground">
                {t('itad.operations.notYetReceived', '{count} not yet received', { count: counters.missing })}
              </span>
            ) : null}
          </div>
        )
      },
    },
    {
      id: 'sanitization',
      header: t('itad.operations.column.sanitization', 'Sanitization'),
      meta: { priority: 3, truncate: false },
      cell: ({ row }) => {
        const { counters } = row.original
        if (counters.sanitizationScope === 0) return '—'
        return (
          <div className="space-y-0.5">
            <span className="block">{counters.sanitized} / {counters.sanitizationScope}</span>
            {counters.awaitingWipe > 0 ? (
              <span className="block text-xs text-muted-foreground">
                {t('itad.operations.awaitingWipe', '{count} awaiting wipe', { count: counters.awaitingWipe })}
              </span>
            ) : null}
          </div>
        )
      },
    },
    {
      id: 'attention',
      header: t('itad.operations.column.attention', 'Needs attention'),
      meta: { truncate: false },
      cell: ({ row }) =>
        row.original.signals.length === 0 ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {row.original.signals.map((signal) => (
              <Link
                key={signal.key}
                href={signal.href}
                className="rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <StatusBadge variant={ATTENTION_VARIANTS[signal.severity]} dot>
                  {attentionSignalLabel(t, signal.key, signal.count)}
                </StatusBadge>
              </Link>
            ))}
          </div>
        ),
    },
    {
      id: 'exceptions',
      header: t('itad.operations.column.exceptions', 'Open exceptions'),
      meta: { priority: 4 },
      cell: ({ row }) =>
        row.original.counters.openExceptions > 0 ? (
          <Link className="underline underline-offset-2" href={jobHref(row.original.id, 'tab=exceptions')}>
            {row.original.counters.openExceptions}
          </Link>
        ) : (
          <span className="text-muted-foreground">0</span>
        ),
    },
  ]
}

function toQuery(values: FilterValues): string {
  const params = new URLSearchParams()
  if (typeof values.customerId === 'string' && values.customerId) params.set('customerId', values.customerId)
  const statuses = Array.isArray(values.status) ? values.status : typeof values.status === 'string' ? [values.status] : []
  for (const status of statuses) if (typeof status === 'string' && status) params.append('status', status)
  for (const key of FLAG_FILTERS) if (values[key] === true || values[key] === 'true') params.set(key, 'true')
  return params.toString()
}

/** Search box: hands the serial or tag to the ITAD Assets page (spec "Asset search"). */
function AssetSearchBox() {
  const t = useT()
  const router = useRouter()
  const [value, setValue] = React.useState('')
  const label = t('itad.operations.search.label', 'Search assets by serial or customer asset tag')
  return (
    <form
      role="search"
      className="flex w-full max-w-md gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        const query = value.trim()
        if (query) router.push(`/backend/itad/assets?q=${encodeURIComponent(query)}`)
      }}
    >
      <Input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={t('itad.operations.search.placeholder', 'Serial number or customer asset tag')}
        aria-label={label}
      />
      <Button type="submit" variant="outline">{t('itad.operations.search.submit', 'Search')}</Button>
    </form>
  )
}

/**
 * Operations Dashboard (operations dashboard spec Q1, Q2, REQ-711, REQ-721): every active
 * job, grouped and sorted by need for action, with progress, attention chips that link to
 * where each problem is solved, and filters. Numbers are read live on every load.
 */
export function OperationsDashboard() {
  const t = useT()
  const [filterValues, setFilterValues] = React.useState<FilterValues>({})
  const query = toQuery(filterValues)
  const data = useQuery<OperationsResponse>({
    queryKey: ['itad-operations', query],
    queryFn: async () => readApiResultOrThrow(`/api/itad/operations${query ? `?${query}` : ''}`),
  })
  const columns = React.useMemo(() => buildColumns(t), [t])
  const customers = data.data?.customers
  const filters = React.useMemo(
    () => [
      {
        id: 'customerId',
        label: t('itad.operations.filter.customer', 'Customer'),
        type: 'select' as const,
        options: (customers ?? []).map((customer) => ({ value: customer.id, label: customer.name ?? t('itad.operations.unknownCustomer', 'Unknown customer') })),
      },
      {
        id: 'status',
        label: t('itad.operations.filter.status', 'Status'),
        type: 'select' as const,
        multiple: true,
        options: ACTIVE_JOB_STATUSES.map((status) => ({ value: status, label: statusLabel(t, status) })),
      },
      { id: 'openExceptions', label: t('itad.operations.filter.openExceptions', 'With open exceptions'), type: 'checkbox' as const },
      { id: 'missing', label: t('itad.operations.filter.missing', 'With missing devices'), type: 'checkbox' as const },
      { id: 'failed', label: t('itad.operations.filter.failed', 'With failed sanitization'), type: 'checkbox' as const },
      { id: 'missingCertificates', label: t('itad.operations.filter.missingCertificates', 'With missing certificates'), type: 'checkbox' as const },
    ],
    [t, customers],
  )
  const items = data.data?.items ?? []
  const filtered = query.length > 0

  return (
    <div className="space-y-6" data-testid="itad-operations">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">{t('itad.operations.title', 'Operations')}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <AskAssistantButton pageContext={operationsDashboardContext()} pageLabel={t('itad.ai.page.operations', 'Operations dashboard')} />
          <AssetSearchBox />
        </div>
      </div>
      <FilterBar
        filters={filters}
        values={filterValues}
        onApply={(values) => setFilterValues(values)}
        onClear={() => setFilterValues({})}
      />
      {data.isLoading ? (
        <Spinner className="h-6 w-6" />
      ) : data.error ? (
        <Alert status="error">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            {t('itad.operations.loadError', 'Could not load the active jobs')}
            <Button type="button" size="sm" variant="outline" onClick={() => void data.refetch()}>
              {t('itad.operations.retry', 'Retry')}
            </Button>
          </AlertDescription>
        </Alert>
      ) : items.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          {filtered ? t('itad.operations.emptyFiltered', 'No active jobs match the filters.') : t('itad.operations.empty', 'No active jobs.')}
        </p>
      ) : (
        <>
          {data.data?.truncated ? (
            <Alert status="information">
              <AlertDescription>{t('itad.operations.truncated', 'Showing the first 500 active jobs. Narrow the filters to see the rest.')}</AlertDescription>
            </Alert>
          ) : null}
          {SECTIONS.map((section) => {
            const rows = items.filter((item) => section.groups.includes(item.group))
            const title = `${t(section.titleKey, section.title)} (${rows.length})`
            return (
              <section key={section.id} aria-label={t(section.titleKey, section.title)} className="space-y-2" data-testid={`itad-operations-${section.id}`}>
                {rows.length === 0 ? (
                  <>
                    <SectionHeader title={title} />
                    <p className="text-sm text-muted-foreground">{t('itad.operations.groupEmpty', 'Nothing here.')}</p>
                  </>
                ) : (
                  <DataTable<OperationsJob>
                    title={title}
                    columns={columns}
                    data={rows}
                    extensionTableId={`itad.operations.${section.id}`}
                    emptyState={<p className="py-4 text-center text-sm text-muted-foreground">{t('itad.operations.groupEmpty', 'Nothing here.')}</p>}
                  />
                )}
              </section>
            )
          })}
        </>
      )}
    </div>
  )
}

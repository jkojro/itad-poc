"use client"
import * as React from 'react'
import { useRouter } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { LegacyColumnDef as ColumnDef } from '@tanstack/react-table/legacy'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import type { FilterValues } from '@open-mercato/ui/backend/FilterBar'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { Alert, AlertDescription } from '@open-mercato/ui/primitives/alert'
import { FormField } from '@open-mercato/ui/primitives/form-field'
import { Spinner } from '@open-mercato/ui/primitives/spinner'
import { StatusBadge } from '@open-mercato/ui/primitives/status-badge'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@open-mercato/ui/primitives/dialog'
import { apiCall, readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useOrganizationScopeVersion } from '@open-mercato/shared/lib/frontend/useOrganizationScope'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { INBOX_INTENTS, INBOX_MESSAGE_STATUSES, type InboxIntent, type InboxMessageStatus, type MatchStatus } from '../domain/inbox'
import {
  INTENT_LABELS,
  MATCH_STATUS_LABELS,
  MATCH_STATUS_VARIANTS,
  MESSAGE_STATUS_LABELS,
  MESSAGE_STATUS_VARIANTS,
  isHidden,
  type Hidden,
} from './inbox-ui'
import { useGrantedFeatures } from './use-granted-features'

/** ITAD Inbox list (spec "UI/UX"): customer emails with intents, match and status. */

export type InboxRow = {
  id: string
  receivedAt: string
  source: 'email' | 'manual'
  customerAddress: string
  customerName: string | null
  subject: string
  intents: InboxIntent[]
  status: InboxMessageStatus
  stalled: boolean
  matchStatus: MatchStatus | null
  pendingActions: number
  job: { id: string; reference: string } | Hidden | null
  updatedAt: string
}

type InboxResponse = { items: InboxRow[]; total: number; page: number; pageSize: number }

const PAGE_SIZE = 25
const DETAIL_HREF = '/backend/itad/inbox'

export function MessageStatusBadge({ status, stalled }: { status: InboxMessageStatus; stalled: boolean }) {
  const t = useT()
  if (stalled) return <StatusBadge variant="error" dot>{t('itad.inbox.status.stalled', 'Stalled')}</StatusBadge>
  return (
    <StatusBadge variant={MESSAGE_STATUS_VARIANTS[status]} dot>
      {t(`itad.inbox.status.${status}`, MESSAGE_STATUS_LABELS[status])}
    </StatusBadge>
  )
}

export function MatchStatusBadge({ status }: { status: MatchStatus | null }) {
  const t = useT()
  if (!status) return <span className="text-muted-foreground">—</span>
  return (
    <StatusBadge variant={MATCH_STATUS_VARIANTS[status]}>
      {t(`itad.inbox.match.${status}`, MATCH_STATUS_LABELS[status])}
    </StatusBadge>
  )
}

function InboundAddress() {
  const t = useT()
  // Only administrators may read the inbox_ops settings; others simply do not see the address.
  const { data } = useQuery<string | null>({
    queryKey: ['itad-inbox-address'],
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const call = await apiCall<{ settings?: { inboxAddress?: string } | null }>('/api/inbox_ops/settings')
      return call.ok ? call.result?.settings?.inboxAddress ?? null : null
    },
  })
  if (!data) return null
  return (
    <p className="text-sm text-muted-foreground" data-testid="itad-inbox-address">
      {t('itad.inbox.address', 'Customers can forward emails to')}{' '}
      <code className="rounded bg-muted px-1 py-0.5 text-foreground">{data}</code>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="ml-1"
        onClick={() => {
          void navigator.clipboard?.writeText(data)
          flash(t('itad.inbox.copied', 'Copied'), 'success')
        }}
      >
        {t('itad.inbox.copy', 'Copy')}
      </Button>
    </p>
  )
}

type InboxStats = { days: number; messages: number; failedProcessing: number; actions: { proposed: number; executed: number; rejected: number; failed: number; pending: number; editedBeforeDecision: number } }

/** PDF §5 observability: what the Inbox did in the last 30 days, including operator corrections. */
function InboxStatsLine() {
  const t = useT()
  const { data } = useQuery<InboxStats | null>({
    queryKey: ['itad-inbox-stats'],
    staleTime: 60_000,
    queryFn: async () => {
      const call = await apiCall<InboxStats>('/api/itad/inbox/stats')
      return call.ok ? call.result ?? null : null
    },
  })
  if (!data || data.messages === 0) return null
  return (
    <p className="text-xs text-muted-foreground" data-testid="itad-inbox-stats">
      {t(
        'itad.inbox.stats',
        'Last {days} days: {messages} emails · {proposed} actions proposed · {executed} accepted · {rejected} rejected · {edited} corrected before the decision · {failed} failed processing',
        {
          days: data.days,
          messages: data.messages,
          proposed: data.actions.proposed,
          executed: data.actions.executed,
          rejected: data.actions.rejected,
          edited: data.actions.editedBeforeDecision,
          failed: data.failedProcessing,
        },
      )}
    </p>
  )
}

function ImportDialog({ open, onClose, onImported }: { open: boolean; onClose: () => void; onImported: (id: string) => void }) {
  const t = useT()
  const [fromAddress, setFromAddress] = React.useState('')
  const [fromName, setFromName] = React.useState('')
  const [subject, setSubject] = React.useState('')
  const [bodyText, setBodyText] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) return
    setFromAddress('')
    setFromName('')
    setSubject('')
    setBodyText('')
    setError(null)
  }, [open])

  const submit = async () => {
    setSubmitting(true)
    setError(null)
    const call = await apiCall<{ id?: string; error?: string }>('/api/itad/inbox/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fromAddress: fromAddress.trim(), fromName: fromName.trim() || null, subject: subject.trim(), bodyText: bodyText.trim() }),
    })
    setSubmitting(false)
    if (call.ok && call.result?.id) {
      onImported(call.result.id)
      return
    }
    setError(typeof call.result?.error === 'string' ? call.result.error : t('itad.inbox.import.error', 'Could not add the message'))
  }

  const valid = /.+@.+\..+/.test(fromAddress.trim()) && subject.trim().length > 0 && bodyText.trim().length > 0
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !submitting) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('itad.inbox.import.title', 'Add a customer email')}</DialogTitle>
          <DialogDescription>
            {t('itad.inbox.import.description', 'Paste an email the customer sent. It is processed like a forwarded one: matched, interpreted and proposed for your review.')}
          </DialogDescription>
        </DialogHeader>
        <FormField label={t('itad.inbox.import.fromAddress', 'Customer email address')}>
          <Input type="email" value={fromAddress} onChange={(event) => setFromAddress(event.target.value)} autoFocus />
        </FormField>
        <FormField label={t('itad.inbox.import.fromName', 'Customer name (optional)')}>
          <Input value={fromName} onChange={(event) => setFromName(event.target.value)} />
        </FormField>
        <FormField label={t('itad.inbox.import.subject', 'Subject')}>
          <Input value={subject} onChange={(event) => setSubject(event.target.value)} />
        </FormField>
        <FormField label={t('itad.inbox.import.body', 'Message')}>
          <Textarea rows={8} value={bodyText} onChange={(event) => setBodyText(event.target.value)} />
        </FormField>
        {error ? (
          <Alert status="error"><AlertDescription>{error}</AlertDescription></Alert>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
            {t('itad.sanitization.actions.cancel', 'Cancel')}
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={submitting || !valid}>
            {submitting ? <Spinner className="mr-2 h-4 w-4" /> : null}
            {t('itad.inbox.import.submit', 'Add message')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default function InboxTable() {
  const t = useT()
  const router = useRouter()
  const queryClient = useQueryClient()
  const scopeVersion = useOrganizationScopeVersion()
  const { granted } = useGrantedFeatures(['itad.inbox.manage'])
  const [filterValues, setFilterValues] = React.useState<FilterValues>({})
  const [page, setPage] = React.useState(1)
  const [importOpen, setImportOpen] = React.useState(false)

  const params = React.useMemo(() => {
    const query = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) })
    if (typeof filterValues.status === 'string' && filterValues.status) query.set('status', filterValues.status)
    if (typeof filterValues.intent === 'string' && filterValues.intent) query.set('intent', filterValues.intent)
    return query.toString()
  }, [filterValues, page])

  const { data, isLoading, error } = useQuery<InboxResponse>({
    queryKey: ['itad-inbox', params, scopeVersion],
    queryFn: async () => readApiResultOrThrow<InboxResponse>(`/api/itad/inbox/messages?${params}`),
    // Messages being processed change on their own; poll while any is.
    refetchInterval: (query) => ((query.state.data?.items ?? []).some((row) => row.status === 'processing' && !row.stalled) ? 3000 : false),
  })

  const columns = React.useMemo<ColumnDef<InboxRow>[]>(
    () => [
      {
        id: 'receivedAt',
        header: t('itad.inbox.columns.received', 'Received'),
        cell: ({ row }) => new Date(row.original.receivedAt).toLocaleString(),
      },
      {
        id: 'customer',
        header: t('itad.inbox.columns.customer', 'From'),
        cell: ({ row }) => (
          <div className="min-w-0">
            <div className="truncate">{row.original.customerName ?? row.original.customerAddress}</div>
            {row.original.customerName ? <div className="truncate text-xs text-muted-foreground">{row.original.customerAddress}</div> : null}
          </div>
        ),
      },
      { id: 'subject', header: t('itad.inbox.columns.subject', 'Subject'), cell: ({ row }) => <span className="line-clamp-1">{row.original.subject}</span> },
      {
        id: 'intents',
        header: t('itad.inbox.columns.intents', 'Intent'),
        cell: ({ row }) => {
          const [first, ...rest] = row.original.intents
          if (!first) return <span className="text-muted-foreground">{row.original.status === 'processing' ? '…' : t('itad.inbox.intent.other', 'Other')}</span>
          return (
            <span>
              {t(`itad.inbox.intent.${first}`, INTENT_LABELS[first])}
              {rest.length ? <span className="text-muted-foreground"> +{rest.length}</span> : null}
            </span>
          )
        },
      },
      {
        id: 'job',
        header: t('itad.inbox.columns.job', 'Job'),
        cell: ({ row }) => {
          const job = row.original.job
          if (!job) return <span className="text-muted-foreground">—</span>
          if (isHidden(job)) return <span className="text-muted-foreground">{t('itad.inbox.hidden', 'No access')}</span>
          return job.reference
        },
      },
      { id: 'match', header: t('itad.inbox.columns.match', 'Match'), cell: ({ row }) => <MatchStatusBadge status={row.original.matchStatus} /> },
      { id: 'status', header: t('itad.inbox.columns.status', 'Status'), cell: ({ row }) => <MessageStatusBadge status={row.original.status} stalled={row.original.stalled} /> },
      { id: 'pending', header: t('itad.inbox.columns.pending', 'To decide'), cell: ({ row }) => row.original.pendingActions || '—' },
    ],
    [t],
  )

  const filters = React.useMemo(
    () => [
      {
        id: 'status',
        label: t('itad.inbox.columns.status', 'Status'),
        type: 'select' as const,
        options: INBOX_MESSAGE_STATUSES.map((status) => ({ value: status, label: t(`itad.inbox.status.${status}`, MESSAGE_STATUS_LABELS[status]) })),
      },
      {
        id: 'intent',
        label: t('itad.inbox.columns.intents', 'Intent'),
        type: 'select' as const,
        options: INBOX_INTENTS.map((intent) => ({ value: intent, label: t(`itad.inbox.intent.${intent}`, INTENT_LABELS[intent]) })),
      },
    ],
    [t],
  )

  if (error) {
    return (
      <Alert status="error">
        <AlertDescription>{t('itad.inbox.errors.load', 'Could not load the Inbox')}</AlertDescription>
      </Alert>
    )
  }

  const canManage = granted.has('itad.inbox.manage')
  const total = data?.total ?? 0
  return (
    <div className="space-y-3">
      <InboundAddress />
      <InboxStatsLine />
      <DataTable<InboxRow>
        title={t('itad.inbox.title', 'Inbox')}
        titleHeadingLevel={1}
        actions={canManage ? <Button onClick={() => setImportOpen(true)} data-testid="itad-inbox-add">{t('itad.inbox.import.open', 'Add message')}</Button> : undefined}
        columns={columns}
        data={data?.items ?? []}
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
        extensionTableId="itad.inbox.list"
        emptyState={(
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <p className="text-sm text-muted-foreground">{t('itad.inbox.empty', 'No customer emails yet.')}</p>
            <p className="text-xs text-muted-foreground">
              {t('itad.inbox.emptyHint', 'Forward customer emails to the inbound address, or add one manually.')}
            </p>
          </div>
        )}
        pagination={{ page, pageSize: PAGE_SIZE, total, totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)), onPageChange: setPage }}
        isLoading={isLoading}
        onRowClick={(row) => router.push(`${DETAIL_HREF}/${row.id}`)}
      />
      <ImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={(id) => {
          setImportOpen(false)
          flash(t('itad.inbox.import.done', 'Message added; it is being processed'), 'success')
          void queryClient.invalidateQueries({ queryKey: ['itad-inbox'] })
          router.push(`${DETAIL_HREF}/${id}`)
        }}
      />
    </div>
  )
}

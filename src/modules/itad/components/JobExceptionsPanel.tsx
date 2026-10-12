"use client"
import * as React from 'react'
import Link from 'next/link'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { LegacyColumnDef as ColumnDef } from '@tanstack/react-table/legacy'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import { RowActions } from '@open-mercato/ui/backend/RowActions'
import { SectionHeader } from '@open-mercato/ui/backend/SectionHeader'
import type { FilterValues } from '@open-mercato/ui/backend/FilterBar'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { Alert, AlertDescription } from '@open-mercato/ui/primitives/alert'
import { FormField } from '@open-mercato/ui/primitives/form-field'
import { Spinner } from '@open-mercato/ui/primitives/spinner'
import { StatusBadge } from '@open-mercato/ui/primitives/status-badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@open-mercato/ui/primitives/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@open-mercato/ui/primitives/dialog'
import { apiCall, readApiResultOrThrow, withScopedApiRequestHeaders } from '@open-mercato/ui/backend/utils/apiCall'
import { buildOptimisticLockHeader } from '@open-mercato/ui/backend/utils/optimisticLock'
import { surfaceRecordConflict } from '@open-mercato/ui/backend/conflicts'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { ITAD_EXCEPTION_TYPES, manualOutcomes, type ItadExceptionOutcome } from '../domain/exceptions'
import { RECEIVING_NOTE_MAX, RECEIVING_NOTE_MIN } from '../domain/receiving-rules'
import {
  EXCEPTION_STATUS_VARIANTS,
  exceptionEventLabel,
  exceptionOutcomeLabel,
  exceptionStatusLabel,
  exceptionTypeLabel,
} from './exception-ui'
import type { Assignee, ExceptionDetail, ExceptionList, ExceptionRow } from './exception-types'
import { ReasonDialog } from './ReasonDialog'
import type { ItadJobListItem } from './types'

type Translate = ReturnType<typeof useT>

const PAGE_SIZE = 50

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()
}

function errorMessage(result: unknown, fallback: string): string {
  const message = (result as { error?: unknown } | null)?.error
  return typeof message === 'string' && message ? message : fallback
}

function contextText(t: Translate, row: ExceptionRow): string {
  switch (row.type) {
    case 'missing_from_delivery':
      return t('itad.exceptions.context.missing', 'Expected in the manifest, not received')
    case 'unexpected_asset':
      return t('itad.exceptions.context.unexpected', 'Received, not in the manifest')
    case 'duplicate_serial':
      return row.context.flaggedDifferentDevice
        ? t('itad.exceptions.context.differentDevice', 'Scanned again; flagged as a different device')
        : t('itad.exceptions.context.duplicate', 'Scanned again')
    case 'sanitization_failed':
      return row.context.runTool
        ? t('itad.exceptions.context.failedRun', 'Run failed ({tool})', { tool: row.context.runTool })
        : t('itad.exceptions.context.failed', 'Run failed')
  }
}

function buildColumns(t: Translate, jobId: string): ColumnDef<ExceptionRow>[] {
  return [
    { id: 'type', header: t('itad.exceptions.columns.type', 'Type'), meta: { truncate: false }, cell: ({ row }) => exceptionTypeLabel(t, row.original.type) },
    {
      id: 'status',
      header: t('itad.exceptions.columns.status', 'Status'),
      meta: { truncate: false },
      cell: ({ row }) => (
        <StatusBadge variant={EXCEPTION_STATUS_VARIANTS[row.original.status]} dot>
          {exceptionStatusLabel(t, row.original.status)}
        </StatusBadge>
      ),
    },
    {
      id: 'serial',
      header: t('itad.manifest.field.serial', 'Serial number'),
      // A missing device has no asset yet (E4-062): no detail link.
      cell: ({ row }) =>
        row.original.assetId ? (
          <Link className="font-mono underline underline-offset-2" href={`/backend/itad/jobs/${encodeURIComponent(jobId)}/assets/${encodeURIComponent(row.original.assetId)}`}>
            {row.original.serial}
          </Link>
        ) : (
          <span className="font-mono">{row.original.serial}</span>
        ),
    },
    { id: 'context', header: t('itad.exceptions.columns.context', 'Context'), meta: { truncate: false }, cell: ({ row }) => contextText(t, row.original) },
    {
      id: 'assignedTo',
      header: t('itad.exceptions.columns.assignedTo', 'Assigned to'),
      cell: ({ row }) =>
        row.original.assignedTo
          ? row.original.assignedTo.name ?? t('itad.jobs.history.unknownUser', 'unknown user')
          : <span className="text-muted-foreground">{t('itad.exceptions.unassigned', 'Unassigned')}</span>,
    },
    { id: 'createdAt', header: t('itad.exceptions.columns.createdAt', 'Created'), cell: ({ row }) => formatDateTime(row.original.createdAt) },
    {
      id: 'resolution',
      header: t('itad.exceptions.columns.resolution', 'Resolution'),
      meta: { truncate: false },
      cell: ({ row }) =>
        row.original.resolutionOutcome ? (
          <div className="space-y-1">
            <div>{exceptionOutcomeLabel(t, row.original.resolutionOutcome)}</div>
            {row.original.resolutionReason ? <div className="text-xs text-muted-foreground">{row.original.resolutionReason}</div> : null}
            <div className="text-xs text-muted-foreground">
              {formatDateTime(row.original.resolvedAt)} · {row.original.resolvedBy?.name ?? t('itad.jobs.history.unknownUser', 'unknown user')}
            </div>
          </div>
        ) : (
          '—'
        ),
    },
  ]
}

/** Assign, reassign or unassign an OPEN exception; the assignee is any active user of the organization. */
function AssignDialog({ jobId, exception, onClose, onDone }: { jobId: string; exception: ExceptionRow | null; onClose: () => void; onDone: () => void }) {
  const t = useT()
  const [search, setSearch] = React.useState('')
  const [selected, setSelected] = React.useState<string>('')
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  React.useEffect(() => {
    setSearch('')
    setSelected(exception?.assignedTo?.id ?? '')
    setSubmitting(false)
    setError(null)
  }, [exception])
  const users = useQuery<{ items: Assignee[] }>({
    queryKey: ['itad-exception-assignees', search.trim()],
    enabled: exception !== null,
    queryFn: async () => readApiResultOrThrow(`/api/itad/exceptions/assignees?search=${encodeURIComponent(search.trim())}`),
  })

  const submit = async (assignedToUserId: string | null) => {
    if (!exception) return
    setSubmitting(true)
    setError(null)
    const call = await withScopedApiRequestHeaders(buildOptimisticLockHeader(exception.updatedAt), () =>
      apiCall(`/api/itad/jobs/${encodeURIComponent(jobId)}/exceptions/${encodeURIComponent(exception.id)}/assign`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ assignedToUserId }),
      }),
    )
    if (call.ok) {
      flash(
        assignedToUserId
          ? t('itad.exceptions.flash.assigned', 'Exception assigned')
          : t('itad.exceptions.flash.unassigned', 'Exception unassigned'),
        'success',
      )
      onDone()
      onClose()
      return
    }
    if (call.status === 409 && surfaceRecordConflict({ status: call.status, body: call.result }, t)) {
      onDone()
      onClose()
      return
    }
    setSubmitting(false)
    setError(errorMessage(call.result, t('itad.exceptions.errors.generic', 'Could not save')))
  }

  return (
    <Dialog open={exception !== null} onOpenChange={(open) => { if (!open && !submitting) onClose() }}>
      <DialogContent>
        {exception ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('itad.exceptions.assign.title', 'Assign: {serial}', { serial: exception.serial })}</DialogTitle>
              <DialogDescription>{t('itad.exceptions.assign.description', 'The assignee is responsible for the exception; assigning does not resolve it.')}</DialogDescription>
            </DialogHeader>
            <FormField label={t('itad.exceptions.assign.search', 'Search people')}>
              <Input value={search} onChange={(event) => setSearch(event.target.value)} />
            </FormField>
            <FormField label={t('itad.exceptions.columns.assignedTo', 'Assigned to')}>
              <Select value={selected || undefined} onValueChange={setSelected}>
                <SelectTrigger aria-label={t('itad.exceptions.columns.assignedTo', 'Assigned to')}>
                  <SelectValue placeholder={t('itad.exceptions.assign.choose', 'Choose a person')} />
                </SelectTrigger>
                <SelectContent>
                  {(users.data?.items ?? []).map((user) => (
                    <SelectItem key={user.id} value={user.id}>
                      {user.name ? `${user.name}${user.email ? ` (${user.email})` : ''}` : user.email ?? user.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            {error ? (
              <Alert status="error"><AlertDescription>{error}</AlertDescription></Alert>
            ) : null}
            <DialogFooter>
              {exception.assignedTo ? (
                <Button type="button" variant="outline" onClick={() => void submit(null)} disabled={submitting}>
                  {t('itad.exceptions.actions.unassign', 'Unassign')}
                </Button>
              ) : null}
              <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
                {t('itad.sanitization.actions.cancel', 'Cancel')}
              </Button>
              <Button type="button" onClick={() => void submit(selected)} disabled={submitting || !selected || selected === exception.assignedTo?.id}>
                {submitting ? <Spinner className="mr-2 h-4 w-4" /> : null}
                {t('itad.exceptions.actions.assign', 'Assign')}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

/** Manager resolution of MISSING / UNEXPECTED: an outcome allowed for the type and a reason. */
function ResolveDialog({ jobId, exception, onClose, onDone }: { jobId: string; exception: ExceptionRow | null; onClose: () => void; onDone: () => void }) {
  const t = useT()
  const outcomes = exception ? manualOutcomes(exception.type) : []
  const [outcome, setOutcome] = React.useState<ItadExceptionOutcome | ''>('')
  const [reason, setReason] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const reasonId = React.useId()
  React.useEffect(() => {
    setOutcome(exception && manualOutcomes(exception.type).length === 1 ? manualOutcomes(exception.type)[0] : '')
    setReason('')
    setSubmitting(false)
    setError(null)
  }, [exception])
  const trimmed = reason.trim()
  const canSubmit = !submitting && outcome !== '' && trimmed.length >= RECEIVING_NOTE_MIN && trimmed.length <= RECEIVING_NOTE_MAX

  const submit = async () => {
    if (!exception || !canSubmit) return
    setSubmitting(true)
    setError(null)
    const call = await withScopedApiRequestHeaders(buildOptimisticLockHeader(exception.updatedAt), () =>
      apiCall(`/api/itad/jobs/${encodeURIComponent(jobId)}/exceptions/${encodeURIComponent(exception.id)}/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ outcome, reason: trimmed }),
      }),
    )
    if (call.ok) {
      flash(t('itad.exceptions.flash.resolved', 'Exception {serial} resolved', { serial: exception.serial }), 'success')
      onDone()
      onClose()
      return
    }
    if (call.status === 409 && surfaceRecordConflict({ status: call.status, body: call.result }, t)) {
      onDone()
      onClose()
      return
    }
    setSubmitting(false)
    setError(errorMessage(call.result, t('itad.exceptions.errors.generic', 'Could not save')))
  }

  return (
    <Dialog open={exception !== null} onOpenChange={(open) => { if (!open && !submitting) onClose() }}>
      <DialogContent
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            void submit()
          }
        }}
      >
        {exception ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('itad.exceptions.resolve.title', 'Resolve: {serial}', { serial: exception.serial })}</DialogTitle>
              <DialogDescription>
                {t('itad.exceptions.resolve.description', 'Records the outcome; manifest and device data are not changed.')}
              </DialogDescription>
            </DialogHeader>
            <FormField label={t('itad.exceptions.resolve.outcome', 'Outcome')} required>
              <Select value={outcome || undefined} onValueChange={(value) => setOutcome(value as ItadExceptionOutcome)}>
                <SelectTrigger aria-label={t('itad.exceptions.resolve.outcome', 'Outcome')}>
                  <SelectValue placeholder={t('itad.exceptions.resolve.chooseOutcome', 'Choose an outcome')} />
                </SelectTrigger>
                <SelectContent>
                  {outcomes.map((value) => (
                    <SelectItem key={value} value={value}>{exceptionOutcomeLabel(t, value)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField
              id={reasonId}
              label={t('itad.sanitization.reason.label', 'Reason')}
              description={t('itad.sanitization.reason.hint', '3–1000 characters. Avoid personal data.')}
              required
            >
              <Textarea id={reasonId} value={reason} maxLength={RECEIVING_NOTE_MAX} onChange={(event) => setReason(event.target.value)} />
            </FormField>
            {error ? (
              <Alert status="error"><AlertDescription>{error}</AlertDescription></Alert>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
                {t('itad.sanitization.actions.cancel', 'Cancel')}
              </Button>
              <Button type="button" onClick={() => void submit()} disabled={!canSubmit}>
                {submitting ? <Spinner className="mr-2 h-4 w-4" /> : null}
                {t('itad.exceptions.actions.resolve', 'Resolve')}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

/** Creation, assignments and resolution of one exception. */
function HistoryDialog({ jobId, exception, onClose }: { jobId: string; exception: ExceptionRow | null; onClose: () => void }) {
  const t = useT()
  const detail = useQuery<ExceptionDetail>({
    queryKey: ['itad-exception', jobId, exception?.id],
    enabled: exception !== null,
    queryFn: async () => readApiResultOrThrow(`/api/itad/jobs/${encodeURIComponent(jobId)}/exceptions/${encodeURIComponent(exception!.id)}`),
  })
  const unknownUser = t('itad.jobs.history.unknownUser', 'unknown user')
  return (
    <Dialog open={exception !== null} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent>
        {exception ? (
          <>
            <DialogHeader>
              <DialogTitle>
                {t('itad.exceptions.history.title', 'History: {type} {serial}', { type: exceptionTypeLabel(t, exception.type), serial: exception.serial })}
              </DialogTitle>
            </DialogHeader>
            {detail.isLoading ? (
              <div className="flex justify-center py-6"><Spinner className="h-5 w-5" /></div>
            ) : detail.error || !detail.data ? (
              <Alert status="error"><AlertDescription>{t('itad.sanitization.history.error', 'Could not load the history')}</AlertDescription></Alert>
            ) : (
              <ol className="space-y-2 text-sm">
                {detail.data.events.map((event) => (
                  <li key={event.id} className="rounded-md border p-2">
                    <div className="font-medium">
                      {exceptionEventLabel(t, event.kind)}
                      {event.kind === 'assigned' && event.assignedTo ? `: ${event.assignedTo.name ?? unknownUser}` : ''}
                      {event.kind === 'resolved' && event.outcome ? `: ${exceptionOutcomeLabel(t, event.outcome)}` : ''}
                    </div>
                    <p className="text-muted-foreground">
                      {formatDateTime(event.createdAt)} · {event.actor ? event.actor.name ?? unknownUser : t('itad.sanitization.history.system', 'system')}
                    </p>
                    {event.reason ? <p>{event.reason}</p> : null}
                  </li>
                ))}
              </ol>
            )}
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

type ReasonAction = { kind: 'setAside' | 'retry'; exception: ExceptionRow }

/**
 * Exceptions tab of a job (exceptions spec E4-060, E4-061): OPEN first by default, filters
 * by status, type and assignee, and per-type actions. Duplicates and failed sanitization
 * are resolved by their domain actions, offered here directly (E4-021).
 */
export function JobExceptionsPanel({
  job,
  canManage,
  canReceive,
  canManageSanitization,
}: {
  job: ItadJobListItem
  canManage: boolean
  canReceive: boolean
  canManageSanitization: boolean
}) {
  const t = useT()
  const queryClient = useQueryClient()
  const { confirm, ConfirmDialogElement } = useConfirmDialog()
  const [page, setPage] = React.useState(1)
  const [filterValues, setFilterValues] = React.useState<FilterValues>({ status: 'open' })
  const [assignTarget, setAssignTarget] = React.useState<ExceptionRow | null>(null)
  const [resolveTarget, setResolveTarget] = React.useState<ExceptionRow | null>(null)
  const [historyTarget, setHistoryTarget] = React.useState<ExceptionRow | null>(null)
  const [reasonAction, setReasonAction] = React.useState<ReasonAction | null>(null)
  const status = typeof filterValues.status === 'string' ? filterValues.status : ''
  const type = typeof filterValues.type === 'string' ? filterValues.type : ''
  const assignedTo = typeof filterValues.assignedTo === 'string' ? filterValues.assignedTo : ''
  const base = `/api/itad/jobs/${encodeURIComponent(job.id)}`
  const columns = React.useMemo(() => buildColumns(t, job.id), [job.id, t])

  const list = useQuery<ExceptionList>({
    queryKey: ['itad-exceptions', job.id, page, status, type, assignedTo],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) })
      if (status) params.set('status', status)
      if (type) params.set('type', type)
      if (assignedTo) params.set('assignedTo', assignedTo)
      return readApiResultOrThrow(`${base}/exceptions?${params.toString()}`, undefined, {
        errorMessage: t('itad.exceptions.loadError', 'Could not load the exceptions'),
      })
    },
  })
  const refresh = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['itad-exceptions', job.id] })
    void queryClient.invalidateQueries({ queryKey: ['itad-exception', job.id] })
    void queryClient.invalidateQueries({ queryKey: ['itad-assets', job.id] })
    void queryClient.invalidateQueries({ queryKey: ['itad-scans', job.id] })
    void queryClient.invalidateQueries({ queryKey: ['itad-sanitization', job.id] })
  }, [job.id, queryClient])

  const filters = React.useMemo(
    () => [
      {
        id: 'status',
        label: t('itad.exceptions.columns.status', 'Status'),
        type: 'select' as const,
        options: (['open', 'resolved'] as const).map((value) => ({ value, label: exceptionStatusLabel(t, value) })),
      },
      {
        id: 'type',
        label: t('itad.exceptions.columns.type', 'Type'),
        type: 'select' as const,
        options: ITAD_EXCEPTION_TYPES.map((value) => ({ value, label: exceptionTypeLabel(t, value) })),
      },
      {
        id: 'assignedTo',
        label: t('itad.exceptions.columns.assignedTo', 'Assigned to'),
        type: 'select' as const,
        options: [
          { value: 'me', label: t('itad.exceptions.filter.me', 'Me') },
          { value: 'unassigned', label: t('itad.exceptions.unassigned', 'Unassigned') },
        ],
      },
    ],
    [t],
  )

  const sameDevice = async (row: ExceptionRow) => {
    if (!row.intakeScanId) return
    const confirmed = await confirm({
      title: t('itad.exceptions.sameDevice.title', 'Same device: {serial}?', { serial: row.serial }),
      description: t('itad.exceptions.sameDevice.description', 'The repeated scan was the same physical device. The exception is resolved.'),
    })
    if (!confirmed) return
    const call = await apiCall(`${base}/scans/${encodeURIComponent(row.intakeScanId)}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: null }),
    })
    if (call.ok) flash(t('itad.exceptions.flash.resolved', 'Exception {serial} resolved', { serial: row.serial }), 'success')
    else flash(errorMessage(call.result, t('itad.exceptions.errors.generic', 'Could not save')), 'error')
    refresh()
  }

  const submitReason = async (action: ReasonAction, reason: string): Promise<string | null> => {
    const { exception } = action
    let call
    if (action.kind === 'setAside') {
      call = await apiCall(`${base}/scans/${encodeURIComponent(exception.intakeScanId ?? '')}/set-aside`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason }),
      })
    } else {
      // The retry is a sanitization action: it checks the device version.
      const asset = await apiCall<{ items: Array<{ updatedAt: string }> }>(`${base}/assets?id=${encodeURIComponent(exception.assetId ?? '')}&pageSize=1`)
      const updatedAt = asset.ok ? asset.result?.items?.[0]?.updatedAt ?? null : null
      call = await withScopedApiRequestHeaders(buildOptimisticLockHeader(updatedAt), () =>
        apiCall(`${base}/assets/${encodeURIComponent(exception.assetId ?? '')}/sanitization/retry`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reason }),
        }),
      )
    }
    if (!call.ok) {
      if (call.status === 409 && surfaceRecordConflict({ status: call.status, body: call.result }, t)) {
        refresh()
        return null
      }
      return errorMessage(call.result, t('itad.exceptions.errors.generic', 'Could not save'))
    }
    flash(t('itad.exceptions.flash.resolved', 'Exception {serial} resolved', { serial: exception.serial }), 'success')
    refresh()
    return null
  }

  const counts = list.data?.openCounts
  const receiving = job.status === 'receiving'
  const processing = job.status === 'processing'

  return (
    <section className="space-y-4 rounded-lg border bg-card p-4" aria-label={t('itad.exceptions.title', 'Exceptions')}>
      <SectionHeader title={t('itad.exceptions.title', 'Exceptions')} />
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4" aria-live="polite">
        {ITAD_EXCEPTION_TYPES.map((value) => (
          <div key={value}>
            <dt className="text-muted-foreground">{exceptionTypeLabel(t, value)}</dt>
            <dd className="text-lg font-medium">{counts ? counts[value] : '—'}</dd>
          </div>
        ))}
      </dl>
      {list.error ? (
        <Alert status="error"><AlertDescription>{t('itad.exceptions.loadError', 'Could not load the exceptions')}</AlertDescription></Alert>
      ) : (
        <DataTable<ExceptionRow>
          title={t('itad.exceptions.tableTitle', 'Exceptions of this job')}
          columns={columns}
          data={list.data?.items ?? []}
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
          extensionTableId="itad.exceptions.job"
          emptyState={(
            <p className="py-8 text-center text-sm text-muted-foreground">
              {status === 'open' && !type && !assignedTo
                ? t('itad.exceptions.emptyOpen', 'No open exceptions.')
                : t('itad.exceptions.empty', 'No exceptions match the filters.')}
            </p>
          )}
          rowActions={(row) => {
            const open = row.status === 'open'
            const items = [
              ...(open && canManage
                ? [{ id: 'itad.exceptions.assign', label: t('itad.exceptions.actions.assignShort', 'Assign'), onSelect: () => setAssignTarget(row) }]
                : []),
              ...(open && canManage && manualOutcomes(row.type).length > 0
                ? [{ id: 'itad.exceptions.resolve', label: t('itad.exceptions.actions.resolve', 'Resolve'), onSelect: () => setResolveTarget(row) }]
                : []),
              ...(open && row.type === 'duplicate_serial' && receiving && canReceive
                ? [{ id: 'itad.exceptions.sameDevice', label: t('itad.receiving.duplicates.sameDevice', 'Same device'), onSelect: () => void sameDevice(row) }]
                : []),
              ...(open && row.type === 'duplicate_serial' && row.context.flaggedDifferentDevice && receiving && canManage
                ? [{ id: 'itad.exceptions.setAside', label: t('itad.exceptions.actions.setAside', 'Set aside 2nd device'), onSelect: () => setReasonAction({ kind: 'setAside', exception: row }) }]
                : []),
              ...(open && row.type === 'sanitization_failed' && processing && canManage && canManageSanitization
                ? [{ id: 'itad.exceptions.retry', label: t('itad.sanitization.actions.retry', 'Approve retry'), onSelect: () => setReasonAction({ kind: 'retry', exception: row }) }]
                : []),
              { id: 'itad.exceptions.history', label: t('itad.sanitization.actions.history', 'History'), onSelect: () => setHistoryTarget(row) },
            ]
            return <RowActions items={items} />
          }}
          pagination={{
            page,
            pageSize: PAGE_SIZE,
            total: list.data?.total ?? 0,
            totalPages: Math.max(1, Math.ceil((list.data?.total ?? 0) / PAGE_SIZE)),
            onPageChange: setPage,
          }}
          isLoading={list.isLoading}
        />
      )}

      <AssignDialog jobId={job.id} exception={assignTarget} onClose={() => setAssignTarget(null)} onDone={refresh} />
      <ResolveDialog jobId={job.id} exception={resolveTarget} onClose={() => setResolveTarget(null)} onDone={refresh} />
      <HistoryDialog jobId={job.id} exception={historyTarget} onClose={() => setHistoryTarget(null)} />
      <ReasonDialog
        open={reasonAction !== null}
        title={
          reasonAction?.kind === 'setAside'
            ? t('itad.exceptions.setAside.title', 'Set aside the second device {serial}?', { serial: reasonAction.exception.serial })
            : t('itad.sanitization.retry.title', 'Approve a retry for {serial}?', { serial: reasonAction?.exception.serial ?? '' })
        }
        description={
          reasonAction?.kind === 'setAside'
            ? t('itad.exceptions.setAside.description', 'The second physical unit with this serial gets no asset; the duplicate and its exception are closed.')
            : t('itad.sanitization.retry.description', 'The failed run stays in the history; the device can be sanitized again.')
        }
        submitLabel={
          reasonAction?.kind === 'setAside'
            ? t('itad.exceptions.actions.setAsideFull', 'Set aside')
            : t('itad.sanitization.actions.retry', 'Approve retry')
        }
        onSubmit={(reason) => (reasonAction ? submitReason(reasonAction, reason) : Promise.resolve(null))}
        onClose={() => setReasonAction(null)}
      />
      {ConfirmDialogElement}
    </section>
  )
}

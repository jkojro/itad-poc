"use client"
import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { LegacyColumnDef as ColumnDef } from '@tanstack/react-table/legacy'
import { DataTable, type BulkAction, type BulkActionExecuteResult } from '@open-mercato/ui/backend/DataTable'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { RowActions } from '@open-mercato/ui/backend/RowActions'
import { SectionHeader } from '@open-mercato/ui/backend/SectionHeader'
import { CrudForm, type CrudField } from '@open-mercato/ui/backend/CrudForm'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Alert, AlertDescription } from '@open-mercato/ui/primitives/alert'
import { FormField } from '@open-mercato/ui/primitives/form-field'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { Spinner } from '@open-mercato/ui/primitives/spinner'
import { StatusBadge, type StatusBadgeVariant } from '@open-mercato/ui/primitives/status-badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@open-mercato/ui/primitives/dialog'
import { apiCall, apiCallOrThrow, readApiResultOrThrow, withScopedApiRequestHeaders } from '@open-mercato/ui/backend/utils/apiCall'
import { buildOptimisticLockHeader } from '@open-mercato/ui/backend/utils/optimisticLock'
import { surfaceRecordConflict } from '@open-mercato/ui/backend/conflicts'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { isReceivingActive, RECEIVING_NOTE_MIN } from '../domain/receiving-rules'
import { ITAD_ASSET_ENTITY_ID } from '../lib/constants'
import { SourceDataDialog } from './JobManifestPanel'
import { ASSET_STATUS_VARIANTS, assetStatusLabel, dataBearingLabel, dataBearingSourceLabel } from './data-bearing-ui'
import type { ManifestItemRow } from './manifest-types'
import type { AssetRow, ScanListItem, ScanOutcome, ScanResponse } from './receiving-types'
import type { ItadJobListItem } from './types'
import type { FilterValues } from '@open-mercato/ui/backend/FilterBar'
import { ReconciliationBadge, reconciliationLabel, useInvalidateReconciliation, useReconciliation } from './reconciliation-ui'

type Translate = ReturnType<typeof useT>

const PAGE_SIZE = 50
const RECENT_SCANS = 10

const OUTCOME_VARIANTS: Record<ScanOutcome, StatusBadgeVariant> = {
  MATCHED: 'success',
  UNEXPECTED: 'warning',
  DUPLICATE: 'error',
}

const OUTCOME_FALLBACK_LABELS: Record<ScanOutcome, string> = {
  MATCHED: 'Matched',
  UNEXPECTED: 'Unexpected',
  DUPLICATE: 'Duplicate',
}

function outcomeLabel(t: Translate, outcome: ScanOutcome): string {
  return t(`itad.receiving.result.${outcome.toLowerCase()}`, OUTCOME_FALLBACK_LABELS[outcome])
}

function formatDateTime(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()
}


type RecentScan = { key: string; serial: string; outcome: ScanOutcome | null; detail: string; error?: string }

/**
 * Scan input for keyboard-wedge scanners and typing: Enter submits, the field clears and
 * keeps focus, and scans are sent one at a time in order so responses can't reorder.
 */
function ScanForm({ jobId, onScanned }: { jobId: string; onScanned: () => void }) {
  const t = useT()
  const inputRef = React.useRef<HTMLInputElement>(null)
  const queueRef = React.useRef<string[]>([])
  const runningRef = React.useRef(false)
  const [value, setValue] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [recent, setRecent] = React.useState<RecentScan[]>([])

  React.useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const describe = React.useCallback(
    (response: ScanResponse) => {
      const device = [response.asset.manufacturer, response.asset.model].filter(Boolean).join(' ')
      if (response.result === 'DUPLICATE') return t('itad.receiving.scan.duplicateDetail', 'Already received — resolve it below')
      if (response.result === 'UNEXPECTED') return t('itad.receiving.scan.unexpectedDetail', 'Not in the manifest')
      return device || t('itad.receiving.scan.matchedDetail', 'In the manifest')
    },
    [t],
  )

  const drain = React.useCallback(async () => {
    if (runningRef.current) return
    runningRef.current = true
    setBusy(true)
    while (queueRef.current.length > 0) {
      const serial = queueRef.current.shift()!
      const key = `${Date.now()}-${Math.random()}`
      const call = await apiCall<ScanResponse & { error?: string }>(`/api/itad/jobs/${encodeURIComponent(jobId)}/scans`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ serial }),
      })
      const entry: RecentScan =
        call.ok && call.result
          ? { key, serial: call.result.asset.serial, outcome: call.result.result, detail: describe(call.result) }
          : {
              key,
              serial,
              outcome: null,
              detail: '',
              error:
                typeof call.result?.error === 'string' && call.result.error
                  ? call.result.error
                  : t('itad.receiving.scan.error', 'The scan was not recorded'),
            }
      setRecent((current) => [entry, ...current].slice(0, RECENT_SCANS))
      if (call.ok) onScanned()
    }
    runningRef.current = false
    setBusy(false)
    inputRef.current?.focus()
  }, [describe, jobId, onScanned, t])

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    const serial = value.trim()
    if (!serial) return
    queueRef.current.push(serial)
    setValue('')
    inputRef.current?.focus()
    void drain()
  }

  const latest = recent[0]

  return (
    <div className="space-y-3">
      <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <FormField
          className="flex-1"
          label={t('itad.receiving.scan.label', 'Scan or type a serial number')}
          description={t('itad.receiving.scan.hint', 'Press Enter after each serial. A barcode scanner works as a keyboard.')}
        >
          <Input
            ref={inputRef}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            maxLength={500}
          />
        </FormField>
        <Button type="submit" disabled={!value.trim()}>
          {busy ? <Spinner className="mr-2 h-4 w-4" /> : null}
          {t('itad.receiving.scan.submit', 'Register')}
        </Button>
      </form>
      <div aria-live="polite" role="status" className="min-h-6">
        {latest ? (
          latest.outcome ? (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-mono font-medium">{latest.serial}</span>
              <StatusBadge variant={OUTCOME_VARIANTS[latest.outcome]} dot>{outcomeLabel(t, latest.outcome)}</StatusBadge>
              <span className="text-muted-foreground">{latest.detail}</span>
            </div>
          ) : (
            <Alert status="error"><AlertDescription>{latest.serial}: {latest.error}</AlertDescription></Alert>
          )
        ) : null}
      </div>
      {recent.length > 1 ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            {t('itad.receiving.scan.recent', 'Last {count} scans in this session', { count: recent.length })}
          </summary>
          <ul className="mt-2 space-y-1">
            {recent.map((entry) => (
              <li key={entry.key} className="flex flex-wrap items-center gap-2">
                <span className="font-mono">{entry.serial}</span>
                <span className="text-muted-foreground">
                  {entry.outcome ? outcomeLabel(t, entry.outcome) : entry.error}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  )
}

/** Note dialog shared by "same device" (optional note) and "different device" (required note). */
function DuplicateActionDialog({
  jobId,
  scan,
  action,
  onClose,
  onDone,
}: {
  jobId: string
  scan: ScanListItem | null
  action: 'resolve' | 'flag'
  onClose: () => void
  onDone: () => void
}) {
  const t = useT()
  const [note, setNote] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  React.useEffect(() => {
    setNote('')
    setSubmitting(false)
    setError(null)
  }, [scan, action])

  const trimmed = note.trim()
  const required = action === 'flag'
  const canSubmit = !submitting && (required ? trimmed.length >= RECEIVING_NOTE_MIN : trimmed.length === 0 || trimmed.length >= RECEIVING_NOTE_MIN)

  const submit = async () => {
    if (!scan || !canSubmit) return
    setSubmitting(true)
    setError(null)
    const path = action === 'resolve' ? 'resolve' : 'flag-different-device'
    const call = await apiCall<{ error?: string }>(
      `/api/itad/jobs/${encodeURIComponent(jobId)}/scans/${encodeURIComponent(scan.id)}/${path}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note: trimmed || null }) },
    )
    if (call.ok) {
      flash(
        action === 'resolve'
          ? t('itad.receiving.duplicates.flash.resolved', 'Duplicate of {serial} resolved as the same device', { serial: scan.asset.serial })
          : t('itad.receiving.duplicates.flash.flagged', '{serial} flagged as a different device', { serial: scan.asset.serial }),
        'success',
      )
      onDone()
      onClose()
      return
    }
    setSubmitting(false)
    setError(typeof call.result?.error === 'string' && call.result.error ? call.result.error : t('itad.receiving.duplicates.error', 'Could not save'))
  }

  return (
    <Dialog open={scan !== null} onOpenChange={(open) => { if (!open && !submitting) onClose() }}>
      <DialogContent
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            void submit()
          }
        }}
      >
        {scan ? (
          <>
            <DialogHeader>
              <DialogTitle>
                {action === 'resolve'
                  ? t('itad.receiving.duplicates.resolveTitle', 'Same device: {serial}', { serial: scan.asset.serial })
                  : t('itad.receiving.duplicates.flagTitle', 'Different device: {serial}', { serial: scan.asset.serial })}
              </DialogTitle>
              <DialogDescription>
                {action === 'resolve'
                  ? t('itad.receiving.duplicates.resolveDescription', 'The same device was scanned again. The duplicate is closed.')
                  : t('itad.receiving.duplicates.flagDescription', 'Another physical device carries this serial. It stays open and blocks finishing receiving until it is handled as an exception.')}
              </DialogDescription>
            </DialogHeader>
            <FormField
              label={t('itad.receiving.duplicates.note', 'Note')}
              required={required}
              description={
                required
                  ? t('itad.receiving.duplicates.flagNoteHint', 'Where is the device? 3–1000 characters.')
                  : t('itad.receiving.duplicates.resolveNoteHint', 'Optional, 3–1000 characters.')
              }
            >
              <Textarea value={note} maxLength={1000} autoFocus onChange={(event) => setNote(event.target.value)} />
            </FormField>
            {error ? <Alert status="error"><AlertDescription>{error}</AlertDescription></Alert> : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
                {t('itad.manifest.import.cancel', 'Cancel')}
              </Button>
              <Button type="button" onClick={() => void submit()} disabled={!canSubmit}>
                {submitting ? <Spinner className="mr-2 h-4 w-4" /> : null}
                {t('itad.receiving.duplicates.confirm', 'Confirm')}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

type AssetFormValues = {
  customerAssetTag: string
  manufacturer: string
  model: string
  dataBearing: 'unknown' | 'yes' | 'no'
  updatedAt: string
}

/** Asset details editor; `CrudForm` sends the expected version and surfaces conflicts. */
function EditAssetDialog({ jobId, asset, onClose, onSaved }: { jobId: string; asset: AssetRow | null; onClose: () => void; onSaved: () => void }) {
  const t = useT()
  const fields = React.useMemo<CrudField[]>(
    () => [
      { id: 'customerAssetTag', label: t('itad.manifest.field.customerAssetTag', 'Customer asset tag'), type: 'text' },
      { id: 'manufacturer', label: t('itad.manifest.field.manufacturer', 'Manufacturer'), type: 'text' },
      { id: 'model', label: t('itad.manifest.field.model', 'Model'), type: 'text' },
      {
        id: 'dataBearing',
        label: t('itad.receiving.dataBearing.label', 'Carries data'),
        type: 'select',
        // Once decided, the value can switch between Yes and No but not go back to undetermined.
        options: [
          ...(asset?.dataBearing == null
            ? [{ value: 'unknown', label: t('itad.receiving.dataBearing.unknown', 'Not determined') }]
            : []),
          { value: 'yes', label: t('itad.receiving.dataBearing.yes', 'Yes') },
          { value: 'no', label: t('itad.receiving.dataBearing.no', 'No') },
        ],
        description: t(
          'itad.receiving.dataBearing.hint',
          'Yes sends the device to sanitization; No keeps it on the normal path.',
        ),
      },
    ],
    [asset?.dataBearing, t],
  )
  return (
    <Dialog open={asset !== null} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent size="lg">
        {asset ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('itad.receiving.edit.title', 'Asset {serial}', { serial: asset.serial })}</DialogTitle>
              <DialogDescription>{t('itad.receiving.edit.description', 'The serial number cannot be changed; remove the asset and scan again instead.')}</DialogDescription>
            </DialogHeader>
            <CrudForm<AssetFormValues>
              embedded
              entityId={ITAD_ASSET_ENTITY_ID}
              fields={fields}
              initialValues={{
                customerAssetTag: asset.customerAssetTag ?? '',
                manufacturer: asset.manufacturer ?? '',
                model: asset.model ?? '',
                dataBearing: asset.dataBearing === true ? 'yes' : asset.dataBearing === false ? 'no' : 'unknown',
                updatedAt: asset.updatedAt,
              }}
              submitLabel={t('itad.receiving.edit.submit', 'Save')}
              onSubmit={async (values) => {
                const text = (value: string | undefined) => (value && value.trim() ? value.trim() : null)
                await apiCallOrThrow(
                  `/api/itad/jobs/${encodeURIComponent(jobId)}/assets/${encodeURIComponent(asset.id)}`,
                  {
                    method: 'PUT',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                      customerAssetTag: text(values.customerAssetTag),
                      manufacturer: text(values.manufacturer),
                      model: text(values.model),
                      dataBearing: values.dataBearing === 'yes' ? true : values.dataBearing === 'no' ? false : null,
                    }),
                  },
                  { errorMessage: t('itad.receiving.edit.error', 'Could not save the asset') },
                )
                flash(t('itad.receiving.edit.flash', 'Asset {serial} saved', { serial: asset.serial }), 'success')
                onSaved()
                onClose()
              }}
            />
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

/** Voids a wrongly scanned asset; the reason is required and the expected version is sent. */
function RemoveAssetDialog({ jobId, asset, onClose, onRemoved }: { jobId: string; asset: AssetRow | null; onClose: () => void; onRemoved: () => void }) {
  const t = useT()
  const [reason, setReason] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  React.useEffect(() => {
    setReason('')
    setSubmitting(false)
    setError(null)
  }, [asset])
  const canSubmit = !submitting && reason.trim().length >= RECEIVING_NOTE_MIN

  const submit = async () => {
    if (!asset || !canSubmit) return
    setSubmitting(true)
    setError(null)
    const call = await withScopedApiRequestHeaders(buildOptimisticLockHeader(asset.updatedAt), () =>
      apiCall<{ error?: string; code?: string }>(
        `/api/itad/jobs/${encodeURIComponent(jobId)}/assets/${encodeURIComponent(asset.id)}`,
        { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: reason.trim() }) },
      ),
    )
    if (call.ok) {
      flash(t('itad.receiving.remove.flash', 'Removed {serial}; scan it again if it is really here', { serial: asset.serial }), 'success')
      onRemoved()
      onClose()
      return
    }
    if (call.status === 409 && surfaceRecordConflict({ status: call.status, body: call.result }, t)) {
      onRemoved()
      onClose()
      return
    }
    setSubmitting(false)
    setError(typeof call.result?.error === 'string' && call.result.error ? call.result.error : t('itad.receiving.remove.error', 'Could not remove the asset'))
  }

  return (
    <Dialog open={asset !== null} onOpenChange={(open) => { if (!open && !submitting) onClose() }}>
      <DialogContent
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            void submit()
          }
        }}
      >
        {asset ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('itad.receiving.remove.title', 'Remove scan of {serial}', { serial: asset.serial })}</DialogTitle>
              <DialogDescription>{t('itad.receiving.remove.description', 'Use this for a wrong scan. The scan log is kept.')}</DialogDescription>
            </DialogHeader>
            <FormField label={t('itad.manifest.remove.reason', 'Reason')} required description={t('itad.manifest.remove.reasonHint', '3–1000 characters, stored in the job history.')}>
              <Textarea value={reason} maxLength={1000} autoFocus onChange={(event) => setReason(event.target.value)} />
            </FormField>
            {error ? <Alert status="error"><AlertDescription>{error}</AlertDescription></Alert> : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
                {t('itad.manifest.import.cancel', 'Cancel')}
              </Button>
              <Button type="button" variant="destructive" onClick={() => void submit()} disabled={!canSubmit}>
                {submitting ? <Spinner className="mr-2 h-4 w-4" /> : null}
                {t('itad.manifest.remove.submit', 'Remove')}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function buildAssetColumns(t: Translate): ColumnDef<AssetRow>[] {
  return [
    {
      id: 'serial',
      accessorKey: 'serial',
      header: t('itad.manifest.field.serial', 'Serial number'),
      cell: ({ row }) => <span className="font-mono">{row.original.serial}</span>,
    },
    { id: 'customerAssetTag', accessorKey: 'customerAssetTag', header: t('itad.manifest.field.customerAssetTag', 'Customer asset tag'), cell: ({ row }) => row.original.customerAssetTag ?? '—' },
    { id: 'manufacturer', accessorKey: 'manufacturer', header: t('itad.manifest.field.manufacturer', 'Manufacturer'), cell: ({ row }) => row.original.manufacturer ?? '—' },
    { id: 'model', accessorKey: 'model', header: t('itad.manifest.field.model', 'Model'), cell: ({ row }) => row.original.model ?? '—' },
    {
      id: 'reconciliation',
      header: t('itad.reconciliation.column', 'Reconciliation'),
      cell: ({ row }) => <ReconciliationBadge t={t} state={row.original.reconciliation} />,
    },
    {
      id: 'dataBearing',
      header: t('itad.receiving.dataBearing.label', 'Carries data'),
      cell: ({ row }) => (
        <span>
          {dataBearingLabel(t, row.original.dataBearing)}
          {row.original.dataBearingSource ? (
            <>
              {' '}
              <span className="text-xs text-muted-foreground">({dataBearingSourceLabel(t, row.original.dataBearingSource)})</span>
            </>
          ) : null}
        </span>
      ),
    },
    {
      id: 'status',
      header: t('itad.assets.status.column', 'Status'),
      cell: ({ row }) => (
        <StatusBadge variant={ASSET_STATUS_VARIANTS[row.original.status]} dot>
          {assetStatusLabel(t, row.original.status)}
        </StatusBadge>
      ),
    },
    {
      id: 'receivedAt',
      header: t('itad.receiving.assets.receivedAt', 'Received'),
      cell: ({ row }) => (
        <span className="text-muted-foreground">
          {formatDateTime(row.original.receivedAt)} · {row.original.receivedBy.name ?? t('itad.jobs.history.unknownUser', 'unknown user')}
        </span>
      ),
    },
  ]
}

/** Receiving tab of a job (manifest spec "Receiving tab"): scan loop, counters, duplicates, assets. */
export function JobReceivingPanel({
  job,
  canReceive,
  canManage,
  canViewManifest,
}: {
  job: ItadJobListItem
  canReceive: boolean
  canManage: boolean
  canViewManifest: boolean
}) {
  const t = useT()
  const queryClient = useQueryClient()
  const [search, setSearch] = React.useState('')
  const [page, setPage] = React.useState(1)
  const [duplicateAction, setDuplicateAction] = React.useState<{ scan: ScanListItem; action: 'resolve' | 'flag' } | null>(null)
  const [editAsset, setEditAsset] = React.useState<AssetRow | null>(null)
  const [removeAsset, setRemoveAsset] = React.useState<AssetRow | null>(null)
  const [sourceItem, setSourceItem] = React.useState<ManifestItemRow | null>(null)
  const [filterValues, setFilterValues] = React.useState<FilterValues>({})
  const reconciliationFilter = typeof filterValues.reconciliation === 'string' ? filterValues.reconciliation : ''
  const dataBearingFilter = typeof filterValues.dataBearing === 'string' ? filterValues.dataBearing : ''
  const { confirm, ConfirmDialogElement } = useConfirmDialog()
  const reconciliation = useReconciliation(job.id)
  const invalidateReconciliation = useInvalidateReconciliation(job.id)
  const columns = React.useMemo(() => buildAssetColumns(t), [t])
  const base = `/api/itad/jobs/${encodeURIComponent(job.id)}`
  const active = isReceivingActive(job)

  const assetsQuery = useQuery<{ items: AssetRow[]; total: number }>({
    queryKey: ['itad-assets', job.id, page, search, reconciliationFilter, dataBearingFilter],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) })
      if (search.trim()) params.set('search', search.trim())
      if (reconciliationFilter) params.set('reconciliation', reconciliationFilter)
      if (dataBearingFilter) params.set('dataBearing', dataBearingFilter)
      return readApiResultOrThrow(`${base}/assets?${params.toString()}`, undefined, {
        errorMessage: t('itad.receiving.assets.error', 'Could not load the received assets'),
      })
    },
  })
  const duplicatesQuery = useQuery<{ items: ScanListItem[]; total: number }>({
    queryKey: ['itad-scans', job.id, 'pending'],
    queryFn: async () =>
      readApiResultOrThrow(`${base}/scans?pending=true&pageSize=100`, undefined, {
        errorMessage: t('itad.receiving.duplicates.loadError', 'Could not load pending duplicates'),
      }),
  })

  const refresh = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['itad-assets', job.id] })
    void queryClient.invalidateQueries({ queryKey: ['itad-scans', job.id] })
    invalidateReconciliation()
  }, [invalidateReconciliation, job.id, queryClient])

  const filters = React.useMemo(
    () => [
      {
        id: 'reconciliation',
        label: t('itad.reconciliation.column', 'Reconciliation'),
        type: 'select' as const,
        options: (['matched', 'unexpected'] as const).map((state) => ({ value: state, label: reconciliationLabel(t, state) })),
      },
      {
        id: 'dataBearing',
        label: t('itad.receiving.dataBearing.label', 'Carries data'),
        type: 'select' as const,
        options: [
          { value: 'unknown', label: dataBearingLabel(t, null) },
          { value: 'true', label: dataBearingLabel(t, true) },
          { value: 'false', label: dataBearingLabel(t, false) },
        ],
      },
    ],
    [t],
  )

  /** Bulk classification (sanitization spec REQ-304): all-or-nothing, confirmed with the count. */
  const classifySelected = React.useCallback(
    async (rows: AssetRow[], dataBearing: boolean): Promise<BulkActionExecuteResult | false> => {
      const confirmed = await confirm({
        title: dataBearing
          ? t('itad.receiving.classify.confirmYes', 'Mark {count} devices as carrying data?', { count: rows.length })
          : t('itad.receiving.classify.confirmNo', 'Mark {count} devices as not carrying data?', { count: rows.length }),
        description: dataBearing
          ? t('itad.receiving.classify.confirmYesHint', 'They will require sanitization before the job can be closed.')
          : t('itad.receiving.classify.confirmNoHint', 'They stay on the normal path without sanitization.'),
      })
      if (!confirmed) return false
      const call = await apiCall<{ changedAssetIds: string[]; error?: string; assetIds?: string[] }>(`${base}/assets/classify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ assetIds: rows.map((row) => row.id), dataBearing }),
      })
      refresh()
      if (!call.ok) {
        const blocking = new Set(call.result?.assetIds ?? [])
        const serials = rows.filter((row) => blocking.has(row.id)).map((row) => row.serial)
        const reason = call.result?.error ?? t('itad.receiving.classify.error', 'Could not classify the selected devices')
        return { ok: false, message: serials.length ? `${reason}: ${serials.join(', ')}` : reason }
      }
      return {
        ok: true,
        affectedCount: call.result?.changedAssetIds.length ?? 0,
        message: t('itad.receiving.classify.done', '{count} devices classified', { count: call.result?.changedAssetIds.length ?? 0 }),
      }
    },
    [base, confirm, refresh, t],
  )
  const bulkActions = React.useMemo<BulkAction<AssetRow>[]>(
    () =>
      active && canReceive
        ? [
            { id: 'itad.assets.classify.yes', label: t('itad.receiving.classify.markYes', 'Mark as carrying data'), onExecute: (rows) => classifySelected(rows, true) },
            { id: 'itad.assets.classify.no', label: t('itad.receiving.classify.markNo', 'Mark as not carrying data'), onExecute: (rows) => classifySelected(rows, false) },
          ]
        : [],
    [active, canReceive, classifySelected, t],
  )
  const counts = reconciliation.data

  const openSourceData = async (asset: AssetRow) => {
    if (!asset.manifestItemId) return
    const call = await apiCall<{ items: ManifestItemRow[] }>(`${base}/manifest/items?id=${encodeURIComponent(asset.manifestItemId)}&pageSize=1`)
    const item = call.ok ? call.result?.items?.[0] : undefined
    if (item) setSourceItem(item)
    else flash(t('itad.receiving.sourceData.error', 'Could not load the source data'), 'error')
  }

  const pending = duplicatesQuery.data?.items ?? []

  return (
    <section className="space-y-4 rounded-lg border bg-card p-4" aria-label={t('itad.receiving.title', 'Receiving')}>
      <SectionHeader title={t('itad.receiving.title', 'Receiving')} />
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4 lg:grid-cols-7" aria-live="polite">
        {[
          ['expected', t('itad.receiving.counters.expected', 'Expected (manifest)'), counts?.expectedAssetCount],
          ['received', t('itad.receiving.counters.received', 'Received'), counts?.receivedAssetCount],
          ['matched', reconciliationLabel(t, 'matched'), counts?.matched],
          ['missing', reconciliationLabel(t, 'missing'), counts?.missing],
          ['unexpected', reconciliationLabel(t, 'unexpected'), counts?.unexpected],
          [
            'duplicates',
            t('itad.receiving.counters.pendingDuplicates', 'Duplicates to resolve'),
            counts ? counts.pendingDuplicates + counts.differentDeviceUnresolved : undefined,
          ],
          ['dataBearingUndecided', t('itad.receiving.counters.dataBearingUndecided', 'Carries data: not determined'), counts?.dataBearingUndecided],
        ].map(([id, label, value]) => (
          <div key={String(id)}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="text-lg font-medium">{value ?? '—'}</dd>
          </div>
        ))}
      </dl>

      {active ? (
        canReceive ? <ScanForm jobId={job.id} onScanned={refresh} /> : null
      ) : (
        <Alert status="information">
          <AlertDescription>{t('itad.receiving.notActive', 'Scanning is possible only while the job is in receiving.')}</AlertDescription>
        </Alert>
      )}

      {pending.length > 0 ? (
        <section className="space-y-2" aria-label={t('itad.receiving.duplicates.title', 'Duplicates to resolve')}>
          <h3 className="text-sm font-medium">{t('itad.receiving.duplicates.title', 'Duplicates to resolve')}</h3>
          <ul className="space-y-2">
            {pending.map((scan) => (
              <li key={scan.id} className="flex flex-col gap-2 rounded-md border p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono font-medium">{scan.asset.serial}</span>
                    {scan.flaggedDifferentDeviceAt ? (
                      <StatusBadge variant="warning">{t('itad.receiving.duplicates.waiting', 'Waiting for exception handling')}</StatusBadge>
                    ) : null}
                    {scan.asset.deleted ? (
                      <StatusBadge variant="neutral">{t('itad.receiving.duplicates.assetRemoved', 'Asset removed')}</StatusBadge>
                    ) : null}
                  </div>
                  <p className="text-muted-foreground">
                    {formatDateTime(scan.scannedAt)} · {scan.scannedBy?.name ?? t('itad.jobs.history.unknownUser', 'unknown user')}
                  </p>
                  {scan.flaggedDifferentDeviceNote ? <p>{scan.flaggedDifferentDeviceNote}</p> : null}
                </div>
                {active && canReceive ? (
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => setDuplicateAction({ scan, action: 'resolve' })}>
                      {t('itad.receiving.duplicates.sameDevice', 'Same device')}
                    </Button>
                    {!scan.flaggedDifferentDeviceAt ? (
                      <Button type="button" variant="outline" size="sm" onClick={() => setDuplicateAction({ scan, action: 'flag' })}>
                        {t('itad.receiving.duplicates.differentDevice', 'Different device')}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {assetsQuery.error ? (
        <Alert status="error"><AlertDescription>{t('itad.receiving.assets.error', 'Could not load the received assets')}</AlertDescription></Alert>
      ) : (
        <DataTable<AssetRow>
          title={t('itad.receiving.assets.title', 'Received devices')}
          columns={columns}
          data={assetsQuery.data?.items ?? []}
          searchValue={search}
          searchPlaceholder={t('itad.receiving.assets.search', 'Search serial, tag or model')}
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
          entityId={ITAD_ASSET_ENTITY_ID}
          extensionTableId="itad.assets.job"
          bulkActions={bulkActions}
          emptyState={(
            <p className="py-8 text-center text-sm text-muted-foreground">
              {search.trim() || reconciliationFilter || dataBearingFilter
                ? t('itad.receiving.assets.noMatches', 'No received devices match the search.')
                : t('itad.receiving.assets.empty', 'No devices received yet.')}
            </p>
          )}
          rowActions={(row) => {
            const items = [
              ...(canViewManifest && row.manifestItemId
                ? [{ id: 'itad.assets.sourceData', label: t('itad.manifest.actions.sourceData', 'Source data'), onSelect: () => void openSourceData(row) }]
                : []),
              ...(active && canReceive
                ? [{ id: 'itad.assets.edit', label: t('itad.receiving.actions.edit', 'Edit details'), onSelect: () => setEditAsset(row) }]
                : []),
              ...(active && canManage
                ? [{ id: 'itad.assets.remove', label: t('itad.receiving.actions.remove', 'Remove scan'), destructive: true, onSelect: () => setRemoveAsset(row) }]
                : []),
            ]
            return items.length ? <RowActions items={items} /> : null
          }}
          pagination={{
            page,
            pageSize: PAGE_SIZE,
            total: assetsQuery.data?.total ?? 0,
            totalPages: Math.max(1, Math.ceil((assetsQuery.data?.total ?? 0) / PAGE_SIZE)),
            onPageChange: setPage,
          }}
          isLoading={assetsQuery.isLoading}
        />
      )}

      <DuplicateActionDialog
        jobId={job.id}
        scan={duplicateAction?.scan ?? null}
        action={duplicateAction?.action ?? 'resolve'}
        onClose={() => setDuplicateAction(null)}
        onDone={refresh}
      />
      <EditAssetDialog jobId={job.id} asset={editAsset} onClose={() => setEditAsset(null)} onSaved={refresh} />
      <RemoveAssetDialog jobId={job.id} asset={removeAsset} onClose={() => setRemoveAsset(null)} onRemoved={refresh} />
      <SourceDataDialog item={sourceItem} onClose={() => setSourceItem(null)} />
      {ConfirmDialogElement}
    </section>
  )
}

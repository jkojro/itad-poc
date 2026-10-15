"use client"
import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { LegacyColumnDef as ColumnDef } from '@tanstack/react-table/legacy'
import { DataTable, type BulkAction } from '@open-mercato/ui/backend/DataTable'
import { RowActions } from '@open-mercato/ui/backend/RowActions'
import { SectionHeader } from '@open-mercato/ui/backend/SectionHeader'
import type { FilterValues } from '@open-mercato/ui/backend/FilterBar'
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
import { ITAD_ASSET_ENTITY_ID } from '../lib/constants'
import {
  ITAD_SANITIZATION_METHODS,
  ITAD_VERIFICATION_METHODS,
  type ItadSanitizationMethod,
  type ItadVerificationMethod,
} from '../domain/sanitization-state-machine'
import type { ItadAssetStatus } from '../domain/job-types'
import { ASSET_STATUS_VARIANTS, assetStatusLabel } from './data-bearing-ui'
import { ReasonDialog } from './ReasonDialog'
import {
  RUN_RESULT_VARIANTS,
  abortReasonLabel,
  historyActionLabel,
  historyStatusLabel,
  methodLabel,
  runResultLabel,
  verificationLabel,
} from './sanitization-ui'
import type { AssetSanitization, SanitizationList, SanitizationRow, ToolSuggestion } from './sanitization-types'
import type { ItadJobListItem } from './types'

type Translate = ReturnType<typeof useT>

const PAGE_SIZE = 50
const SANITIZATION_STATUSES: ItadAssetStatus[] = ['sanitization_required', 'sanitization_in_progress', 'sanitized', 'review_required']

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()
}

function errorMessage(result: unknown, fallback: string): string {
  const message = (result as { error?: unknown } | null)?.error
  return typeof message === 'string' && message ? message : fallback
}

function buildColumns(t: Translate): ColumnDef<SanitizationRow>[] {
  return [
    {
      id: 'serial',
      header: t('itad.manifest.field.serial', 'Serial number'),
      cell: ({ row }) => <span className="font-mono">{row.original.serial}</span>,
    },
    {
      id: 'model',
      header: t('itad.manifest.field.model', 'Model'),
      cell: ({ row }) => [row.original.manufacturer, row.original.model].filter(Boolean).join(' ') || '—',
    },
    {
      id: 'status',
      header: t('itad.assets.status.column', 'Status'),
      meta: { truncate: false },
      cell: ({ row }) => (
        <StatusBadge variant={ASSET_STATUS_VARIANTS[row.original.status]} dot>
          {assetStatusLabel(t, row.original.status)}
        </StatusBadge>
      ),
    },
    {
      id: 'lastRun',
      header: t('itad.sanitization.columns.lastRun', 'Last run'),
      // Two lines of method, tool, time and operator: wrap instead of the default truncation.
      meta: { truncate: false },
      cell: ({ row }) => {
        const run = row.original.lastRun
        if (!run) return <span className="text-muted-foreground">{t('itad.sanitization.noRuns', 'No runs yet')}</span>
        return (
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge variant={RUN_RESULT_VARIANTS[run.result ?? 'OPEN']}>{runResultLabel(t, run.result)}</StatusBadge>
              <span>{methodLabel(t, run.method)}</span>
            </div>
            <div className="text-xs text-muted-foreground">
              {run.tool} {run.toolVersion} · {formatDateTime(run.finishedAt ?? run.startedAt)} ·{' '}
              {run.operator.name ?? t('itad.jobs.history.unknownUser', 'unknown user')}
            </div>
          </div>
        )
      },
    },
    { id: 'runsCount', header: t('itad.sanitization.columns.runs', 'Runs'), cell: ({ row }) => row.original.runsCount },
  ]
}

/** Title for one device ("…: SN123") or a selection ("… 12 devices"). */
function targetLabel(t: Translate, assets: SanitizationRow[]): string {
  return assets.length === 1 ? assets[0].serial : t('itad.sanitization.bulk.devices', '{count} devices', { count: assets.length })
}

/** Error text of a failed call; lists the serials a bulk request was blocked by. */
function failureMessage(t: Translate, result: unknown, assets: SanitizationRow[]): string {
  const message = errorMessage(result, t('itad.sanitization.errors.generic', 'Could not save'))
  const blocking = (result as { blockingAssetIds?: unknown } | null)?.blockingAssetIds
  if (!Array.isArray(blocking) || blocking.length === 0) return message
  const ids = new Set(blocking.map(String))
  const serials = assets.filter((asset) => ids.has(asset.id)).map((asset) => asset.serial)
  return serials.length ? `${message}: ${serials.join(', ')}` : message
}

/**
 * Starts a run for one device (with its version check) or one run per selected device
 * (bulk, all-or-nothing): NIST method, optional detail, tool and version with
 * suggestions from earlier runs.
 */
function StartRunDialog({ jobId, assets, onClose, onDone }: { jobId: string; assets: SanitizationRow[] | null; onClose: () => void; onDone: () => void }) {
  const t = useT()
  const [method, setMethod] = React.useState<ItadSanitizationMethod>('purge')
  const [methodDetail, setMethodDetail] = React.useState('')
  const [tool, setTool] = React.useState('')
  const [toolVersion, setToolVersion] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const suggestionsId = React.useId()
  const open = assets !== null && assets.length > 0
  const tools = useQuery<{ items: ToolSuggestion[] }>({
    queryKey: ['itad-sanitization-tools'],
    enabled: open,
    queryFn: async () => readApiResultOrThrow('/api/itad/sanitization/tools'),
  })
  React.useEffect(() => {
    if (!assets) return
    setMethod('purge')
    setMethodDetail('')
    setTool('')
    setToolVersion('')
    setSubmitting(false)
    setError(null)
  }, [assets])
  // Prefill the most used tool once suggestions arrive, unless the operator already typed one.
  const recent = tools.data?.items?.[0]
  React.useEffect(() => {
    if (!assets || !recent) return
    setTool((current) => current || recent.tool)
    setToolVersion((current) => current || recent.toolVersion)
  }, [assets, recent])
  const versions = (tools.data?.items ?? []).filter((item) => item.tool === tool.trim()).map((item) => item.toolVersion)
  const canSubmit = !submitting && tool.trim().length > 0 && toolVersion.trim().length > 0

  const submit = async () => {
    if (!assets || !open || !canSubmit) return
    setSubmitting(true)
    setError(null)
    const fields = { method, methodDetail: methodDetail.trim() || null, tool: tool.trim(), toolVersion: toolVersion.trim() }
    const base = `/api/itad/jobs/${encodeURIComponent(jobId)}`
    const call =
      assets.length === 1
        ? await withScopedApiRequestHeaders(buildOptimisticLockHeader(assets[0].updatedAt), () =>
            apiCall(`${base}/assets/${encodeURIComponent(assets[0].id)}/sanitization/runs`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(fields),
            }),
          )
        : await apiCall(`${base}/sanitization/bulk-start`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...fields, assetIds: assets.map((asset) => asset.id) }),
          })
    if (call.ok) {
      flash(t('itad.sanitization.flash.started', 'Sanitization of {serial} started', { serial: targetLabel(t, assets) }), 'success')
      onDone()
      onClose()
      return
    }
    if (assets.length === 1 && call.status === 409 && surfaceRecordConflict({ status: call.status, body: call.result }, t)) {
      onDone()
      onClose()
      return
    }
    setSubmitting(false)
    setError(failureMessage(t, call.result, assets))
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !submitting) onClose() }}>
      <DialogContent
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            void submit()
          }
        }}
      >
        {assets && open ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('itad.sanitization.start.title', 'Start sanitization: {serial}', { serial: targetLabel(t, assets) })}</DialogTitle>
              <DialogDescription>
                {assets.length === 1
                  ? t('itad.sanitization.start.description', 'Record how the device is being wiped.')
                  : t('itad.sanitization.start.bulkDescription', 'One run is started for each selected device, with the same method and tool. If any device cannot start, none does.')}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <FormField label={t('itad.sanitization.fields.method', 'Method')} required>
                <Select value={method} onValueChange={(value) => setMethod(value as ItadSanitizationMethod)}>
                  <SelectTrigger aria-label={t('itad.sanitization.fields.method', 'Method')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ITAD_SANITIZATION_METHODS.map((value) => (
                      <SelectItem key={value} value={value}>{methodLabel(t, value)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
              <FormField
                label={t('itad.sanitization.fields.methodDetail', 'Method detail')}
                description={t('itad.sanitization.fields.methodDetailHint', 'Optional, e.g. "3-pass overwrite" or "crypto erase".')}
              >
                <Input value={methodDetail} maxLength={500} onChange={(event) => setMethodDetail(event.target.value)} />
              </FormField>
              <FormField label={t('itad.sanitization.fields.tool', 'Tool')} required>
                <Input value={tool} maxLength={200} list={`${suggestionsId}-tools`} onChange={(event) => setTool(event.target.value)} />
              </FormField>
              <FormField label={t('itad.sanitization.fields.toolVersion', 'Tool version')} required>
                <Input
                  value={toolVersion}
                  maxLength={100}
                  list={`${suggestionsId}-versions`}
                  onChange={(event) => setToolVersion(event.target.value)}
                />
              </FormField>
              <datalist id={`${suggestionsId}-tools`}>
                {[...new Set((tools.data?.items ?? []).map((item) => item.tool))].map((value) => (
                  <option key={value} value={value} />
                ))}
              </datalist>
              <datalist id={`${suggestionsId}-versions`}>
                {versions.map((value) => (
                  <option key={value} value={value} />
                ))}
              </datalist>
            </div>
            {error ? (
              <Alert status="error"><AlertDescription>{error}</AlertDescription></Alert>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
                {t('itad.sanitization.actions.cancel', 'Cancel')}
              </Button>
              <Button type="button" onClick={() => void submit()} disabled={!canSubmit}>
                {submitting ? <Spinner className="mr-2 h-4 w-4" /> : null}
                {t('itad.sanitization.actions.start', 'Start run')}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

/**
 * Records PASS or FAIL for the open run of one device or of every selected device (bulk,
 * all-or-nothing); FAIL needs notes. An optional evidence file is uploaded after the
 * results are saved and linked to all those runs — a failed upload never undoes them.
 */
function ResultDialog({ jobId, assets, onClose, onDone }: { jobId: string; assets: SanitizationRow[] | null; onClose: () => void; onDone: () => void }) {
  const t = useT()
  const [result, setResult] = React.useState<'PASS' | 'FAIL'>('PASS')
  const [verificationMethod, setVerificationMethod] = React.useState<ItadVerificationMethod>('full_verification')
  const [notes, setNotes] = React.useState('')
  const [mediaText, setMediaText] = React.useState('')
  const [file, setFile] = React.useState<File | null>(null)
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  React.useEffect(() => {
    setResult('PASS')
    setVerificationMethod('full_verification')
    setNotes('')
    setMediaText('')
    setFile(null)
    setSubmitting(false)
    setError(null)
  }, [assets])
  const open = assets !== null && assets.length > 0
  const openRunIds = (assets ?? []).flatMap((asset) => (asset.lastRun && !asset.lastRun.result ? [asset.lastRun.id] : []))
  const canSubmit = !submitting && open && (result === 'PASS' || notes.trim().length > 0)

  const submit = async () => {
    if (!assets || !open || !canSubmit) return
    setSubmitting(true)
    setError(null)
    const base = `/api/itad/jobs/${encodeURIComponent(jobId)}/sanitization`
    const fields = { result, verificationMethod, verificationNotes: notes.trim() || null }
    const single = assets.length === 1
    if (single && openRunIds.length !== 1) {
      setSubmitting(false)
      setError(t('itad.sanitization.errors.asset_transition_not_allowed', 'This action is not possible in the current status of the device'))
      return
    }
    const call = single
      ? await apiCall(`${base}/runs/${encodeURIComponent(openRunIds[0])}/result`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // Media identifiers belong to one device's run; bulk results never carry them.
          body: JSON.stringify({ ...fields, mediaIdentifiers: mediaText.split('\n').map((line) => line.trim()).filter(Boolean) }),
        })
      : await apiCall<{ runs?: Array<{ runId: string }> }>(`${base}/bulk-result`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...fields, assetIds: assets.map((asset) => asset.id) }),
        })
    if (!call.ok) {
      setSubmitting(false)
      setError(failureMessage(t, call.result, assets))
      return
    }
    const label = targetLabel(t, assets)
    flash(
      result === 'PASS'
        ? t('itad.sanitization.flash.passed', '{serial} sanitized', { serial: label })
        : t('itad.sanitization.flash.failed', 'Sanitization of {serial} failed; it needs review', { serial: label }),
      result === 'PASS' ? 'success' : 'warning',
    )
    const runIds = single ? openRunIds : ((call.result as { runs?: Array<{ runId: string }> } | null)?.runs ?? []).map((run) => run.runId)
    if (file && runIds.length > 0) {
      const form = new FormData()
      form.append('file', file)
      for (const runId of runIds) form.append('runIds', runId)
      const upload = await apiCall(`${base}/evidence`, { method: 'POST', body: form })
      if (!upload.ok) flash(errorMessage(upload.result, t('itad.sanitization.evidence.error', 'The result was saved, but the evidence file could not be attached')), 'error')
    }
    onDone()
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !submitting) onClose() }}>
      <DialogContent
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            void submit()
          }
        }}
      >
        {assets && open ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('itad.sanitization.result.title', 'Sanitization result: {serial}', { serial: targetLabel(t, assets) })}</DialogTitle>
              <DialogDescription>
                {assets.length === 1
                  ? t('itad.sanitization.result.description', 'The run is closed with this result and cannot be changed later.')
                  : t('itad.sanitization.result.bulkDescription', 'The open run of each selected device is closed with this result. If any device has no open run, nothing is saved.')}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <FormField label={t('itad.sanitization.fields.result', 'Result')} required>
                <Select value={result} onValueChange={(value) => setResult(value as 'PASS' | 'FAIL')}>
                  <SelectTrigger aria-label={t('itad.sanitization.fields.result', 'Result')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PASS">{runResultLabel(t, 'PASS')}</SelectItem>
                    <SelectItem value="FAIL">{runResultLabel(t, 'FAIL')}</SelectItem>
                  </SelectContent>
                </Select>
              </FormField>
              <FormField label={t('itad.sanitization.fields.verificationMethod', 'Verification')} required>
                <Select value={verificationMethod} onValueChange={(value) => setVerificationMethod(value as ItadVerificationMethod)}>
                  <SelectTrigger aria-label={t('itad.sanitization.fields.verificationMethod', 'Verification')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ITAD_VERIFICATION_METHODS.map((value) => (
                      <SelectItem key={value} value={value}>{verificationLabel(t, value)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
              <FormField
                label={t('itad.sanitization.fields.verificationNotes', 'Verification notes')}
                required={result === 'FAIL'}
                description={
                  result === 'FAIL'
                    ? t('itad.sanitization.fields.verificationNotesFail', 'Required for a failed run: what failed. Avoid personal data.')
                    : t('itad.sanitization.fields.verificationNotesHint', 'Optional. Avoid personal data.')
                }
              >
                <Textarea value={notes} maxLength={2000} onChange={(event) => setNotes(event.target.value)} />
              </FormField>
              {assets && assets.length === 1 ? (
                <FormField
                  label={t('itad.sanitization.fields.mediaIdentifiers', 'Media identifiers')}
                  description={t(
                    'itad.sanitization.fields.mediaIdentifiersHint',
                    'Optional. One per line, e.g. the serial of each drive (at most 10). Shown on the certificate.',
                  )}
                >
                  <Textarea value={mediaText} rows={3} onChange={(event) => setMediaText(event.target.value)} />
                </FormField>
              ) : null}
              <FormField
                label={t('itad.sanitization.fields.evidence', 'Evidence file')}
                description={t('itad.sanitization.fields.evidenceHint', 'Optional, e.g. the tool report (at most 10 MB).')}
              >
                <Input type="file" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
              </FormField>
            </div>
            {error ? (
              <Alert status="error"><AlertDescription>{error}</AlertDescription></Alert>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
                {t('itad.sanitization.actions.cancel', 'Cancel')}
              </Button>
              <Button type="button" onClick={() => void submit()} disabled={!canSubmit}>
                {submitting ? <Spinner className="mr-2 h-4 w-4" /> : null}
                {t('itad.sanitization.actions.saveResult', 'Save result')}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

/** Uploads one evidence file and links it to the latest run of every selected device. */
function EvidenceDialog({ jobId, assets, onClose, onDone }: { jobId: string; assets: SanitizationRow[] | null; onClose: () => void; onDone: () => void }) {
  const t = useT()
  const [file, setFile] = React.useState<File | null>(null)
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  React.useEffect(() => {
    setFile(null)
    setSubmitting(false)
    setError(null)
  }, [assets])
  const open = assets !== null && assets.length > 0
  const runIds = (assets ?? []).flatMap((asset) => (asset.lastRun ? [asset.lastRun.id] : []))
  const withoutRun = (assets ?? []).filter((asset) => !asset.lastRun).map((asset) => asset.serial)
  const canSubmit = !submitting && file !== null && runIds.length > 0

  const submit = async () => {
    if (!file || !canSubmit) return
    setSubmitting(true)
    setError(null)
    const form = new FormData()
    form.append('file', file)
    for (const runId of runIds) form.append('runIds', runId)
    const call = await apiCall(`/api/itad/jobs/${encodeURIComponent(jobId)}/sanitization/evidence`, { method: 'POST', body: form })
    if (!call.ok) {
      setSubmitting(false)
      setError(errorMessage(call.result, t('itad.sanitization.errors.generic', 'Could not save')))
      return
    }
    flash(t('itad.sanitization.evidence.done', 'Evidence attached to {count} runs', { count: runIds.length }), 'success')
    onDone()
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !submitting) onClose() }}>
      <DialogContent>
        {assets && open ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('itad.sanitization.evidence.title', 'Attach evidence: {serial}', { serial: targetLabel(t, assets) })}</DialogTitle>
              <DialogDescription>
                {t('itad.sanitization.evidence.description', 'The file is stored once and linked to the latest run of each selected device.')}
              </DialogDescription>
            </DialogHeader>
            <FormField label={t('itad.sanitization.fields.evidence', 'Evidence file')} required description={t('itad.sanitization.evidence.fileHint', 'E.g. the tool report for the batch (at most 10 MB).')}>
              <Input type="file" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
            </FormField>
            {withoutRun.length > 0 ? (
              <Alert status="warning">
                <AlertDescription>
                  {t('itad.sanitization.evidence.skipped', 'Devices without a run are skipped: {serials}', { serials: withoutRun.join(', ') })}
                </AlertDescription>
              </Alert>
            ) : null}
            {error ? (
              <Alert status="error"><AlertDescription>{error}</AlertDescription></Alert>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
                {t('itad.sanitization.actions.cancel', 'Cancel')}
              </Button>
              <Button type="button" onClick={() => void submit()} disabled={!canSubmit}>
                {submitting ? <Spinner className="mr-2 h-4 w-4" /> : null}
                {t('itad.sanitization.actions.attach', 'Attach')}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

/** Runs (with evidence) and the status history of one asset. */
function HistoryDialog({ jobId, asset, onClose }: { jobId: string; asset: SanitizationRow | null; onClose: () => void }) {
  const t = useT()
  const query = useQuery<AssetSanitization>({
    queryKey: ['itad-asset-sanitization', jobId, asset?.id],
    enabled: asset !== null,
    queryFn: async () =>
      readApiResultOrThrow(`/api/itad/jobs/${encodeURIComponent(jobId)}/assets/${encodeURIComponent(asset!.id)}/sanitization`),
  })
  const unknownUser = t('itad.jobs.history.unknownUser', 'unknown user')
  const systemUser = t('itad.sanitization.history.system', 'system')
  const data = query.data

  return (
    <Dialog open={asset !== null} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent size="lg">
        {asset ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('itad.sanitization.history.title', 'Sanitization history: {serial}', { serial: asset.serial })}</DialogTitle>
            </DialogHeader>
            {query.isLoading ? (
              <div className="flex justify-center py-6"><Spinner className="h-5 w-5" /></div>
            ) : query.error || !data ? (
              <Alert status="error"><AlertDescription>{t('itad.sanitization.history.error', 'Could not load the history')}</AlertDescription></Alert>
            ) : (
              <div className="max-h-96 space-y-6 overflow-y-auto">
                <section aria-label={t('itad.sanitization.history.runs', 'Runs')} className="space-y-3">
                  <h3 className="text-sm font-medium">{t('itad.sanitization.history.runs', 'Runs')}</h3>
                  {data.runs.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t('itad.sanitization.noRuns', 'No runs yet')}</p>
                  ) : (
                    <ul className="space-y-3">
                      {data.runs.map((run) => (
                        <li key={run.id} className="space-y-2 rounded-md border p-3 text-sm">
                          <div className="flex flex-wrap items-center gap-2">
                            <StatusBadge variant={RUN_RESULT_VARIANTS[run.result ?? 'OPEN']}>{runResultLabel(t, run.result)}</StatusBadge>
                            <span className="font-medium">{methodLabel(t, run.method)}</span>
                            {run.methodDetail ? <span className="text-muted-foreground">{run.methodDetail}</span> : null}
                          </div>
                          <dl className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
                            <dt className="text-muted-foreground">{t('itad.sanitization.fields.tool', 'Tool')}</dt>
                            <dd>{run.tool} {run.toolVersion}</dd>
                            <dt className="text-muted-foreground">{t('itad.sanitization.history.started', 'Started')}</dt>
                            <dd>{formatDateTime(run.startedAt)} · {run.operator?.name ?? unknownUser}</dd>
                            {run.finishedAt ? (
                              <>
                                <dt className="text-muted-foreground">{t('itad.sanitization.history.finished', 'Finished')}</dt>
                                <dd>{formatDateTime(run.finishedAt)} · {run.finishedBy?.name ?? unknownUser}</dd>
                              </>
                            ) : null}
                            {run.verificationMethod ? (
                              <>
                                <dt className="text-muted-foreground">{t('itad.sanitization.fields.verificationMethod', 'Verification')}</dt>
                                <dd>{verificationLabel(t, run.verificationMethod)}</dd>
                              </>
                            ) : null}
                            {run.verificationNotes ? (
                              <>
                                <dt className="text-muted-foreground">{t('itad.sanitization.fields.verificationNotes', 'Verification notes')}</dt>
                                <dd className="whitespace-pre-wrap">{run.verificationNotes}</dd>
                              </>
                            ) : null}
                            {run.abortReason ? (
                              <>
                                <dt className="text-muted-foreground">{t('itad.sanitization.history.abortReason', 'Abort reason')}</dt>
                                <dd>{abortReasonLabel(t, run.abortReason)}</dd>
                              </>
                            ) : null}
                          </dl>
                          {run.evidence.length > 0 ? (
                            <ul className="space-y-1">
                              {run.evidence.map((entry) => (
                                <li key={entry.attachmentId}>
                                  <a
                                    className="text-primary underline-offset-2 hover:underline"
                                    href={`/api/itad/jobs/${encodeURIComponent(jobId)}/sanitization/evidence/${encodeURIComponent(entry.attachmentId)}/file`}
                                    download={entry.fileName}
                                  >
                                    {entry.fileName}
                                  </a>
                                </li>
                              ))}
                            </ul>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
                <section aria-label={t('itad.sanitization.history.statuses', 'Status history')} className="space-y-2">
                  <h3 className="text-sm font-medium">{t('itad.sanitization.history.statuses', 'Status history')}</h3>
                  <ol className="space-y-2 text-sm">
                    {data.history.map((entry) => (
                      <li key={entry.id} className="rounded-md border p-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{historyActionLabel(t, entry.action)}</span>
                          <span className="text-muted-foreground">
                            {entry.fromStatus ? `${historyStatusLabel(t, entry.fromStatus)} → ` : ''}
                            {historyStatusLabel(t, entry.toStatus)}
                          </span>
                        </div>
                        <p className="text-muted-foreground">
                          {formatDateTime(entry.createdAt)} · {entry.actor ? entry.actor.name ?? unknownUser : systemUser}
                        </p>
                        {entry.reason ? <p>{abortReasonLabel(t, entry.reason)}</p> : null}
                      </li>
                    ))}
                  </ol>
                </section>
              </div>
            )}
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

type ReasonAction = { kind: 'abort' | 'retry' | 'notDataBearing'; asset: SanitizationRow }

/** Sanitization tab of a job (sanitization spec "Sanitization tab"): row actions and bulk actions on the selection. */
export function JobSanitizationPanel({
  job,
  canExecute,
  canManage,
  canResolveExceptions = false,
}: {
  job: ItadJobListItem
  canExecute: boolean
  canManage: boolean
  /** The retry also resolves the SANITIZATION_FAILED exception (exceptions spec Q6). */
  canResolveExceptions?: boolean
}) {
  const t = useT()
  const queryClient = useQueryClient()
  const [search, setSearch] = React.useState('')
  const [page, setPage] = React.useState(1)
  const [filterValues, setFilterValues] = React.useState<FilterValues>({})
  const [startAssets, setStartAssets] = React.useState<SanitizationRow[] | null>(null)
  const [resultAssets, setResultAssets] = React.useState<SanitizationRow[] | null>(null)
  const [evidenceAssets, setEvidenceAssets] = React.useState<SanitizationRow[] | null>(null)
  const [historyAsset, setHistoryAsset] = React.useState<SanitizationRow | null>(null)
  const [reasonAction, setReasonAction] = React.useState<ReasonAction | null>(null)
  const statusFilter = typeof filterValues.status === 'string' ? filterValues.status : ''
  const base = `/api/itad/jobs/${encodeURIComponent(job.id)}`
  const processing = job.status === 'processing'
  const reclassifiable = job.status === 'processing' || job.status === 'closeout_review'
  const columns = React.useMemo(() => buildColumns(t), [t])

  const list = useQuery<SanitizationList>({
    queryKey: ['itad-sanitization', job.id, page, search, statusFilter],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) })
      if (search.trim()) params.set('search', search.trim())
      if (statusFilter) params.set('status', statusFilter)
      return readApiResultOrThrow(`${base}/sanitization?${params.toString()}`, undefined, {
        errorMessage: t('itad.sanitization.loadError', 'Could not load the data-bearing devices'),
      })
    },
  })
  // Bumping the selection scope clears the table selection after an action succeeded.
  const [selectionVersion, setSelectionVersion] = React.useState(0)
  const refresh = React.useCallback(() => {
    setSelectionVersion((value) => value + 1)
    void queryClient.invalidateQueries({ queryKey: ['itad-sanitization', job.id] })
    void queryClient.invalidateQueries({ queryKey: ['itad-asset-sanitization', job.id] })
    void queryClient.invalidateQueries({ queryKey: ['itad-assets', job.id] })
    void queryClient.invalidateQueries({ queryKey: ['itad-sanitization-tools'] })
  }, [job.id, queryClient])

  const filters = React.useMemo(
    () => [
      {
        id: 'status',
        label: t('itad.assets.status.column', 'Status'),
        type: 'select' as const,
        options: SANITIZATION_STATUSES.map((status) => ({ value: status, label: assetStatusLabel(t, status) })),
      },
    ],
    [t],
  )

  const submitReason = async (action: ReasonAction, reason: string): Promise<string | null> => {
    const { asset } = action
    let call
    if (action.kind === 'abort') {
      if (!asset.lastRun) return t('itad.sanitization.errors.generic', 'Could not save')
      call = await apiCall(`${base}/sanitization/runs/${encodeURIComponent(asset.lastRun.id)}/abort`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason }),
      })
    } else if (action.kind === 'retry') {
      call = await withScopedApiRequestHeaders(buildOptimisticLockHeader(asset.updatedAt), () =>
        apiCall(`${base}/assets/${encodeURIComponent(asset.id)}/sanitization/retry`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reason }),
        }),
      )
    } else {
      call = await apiCall(`${base}/assets/classify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ assetIds: [asset.id], dataBearing: false, reason }),
      })
    }
    if (!call.ok) {
      if (call.status === 409 && surfaceRecordConflict({ status: call.status, body: call.result }, t)) {
        refresh()
        return null
      }
      return errorMessage(call.result, t('itad.sanitization.errors.generic', 'Could not save'))
    }
    const messages = {
      abort: t('itad.sanitization.flash.aborted', 'Run for {serial} aborted', { serial: asset.serial }),
      retry: t('itad.sanitization.flash.retry', 'Retry approved for {serial}', { serial: asset.serial }),
      notDataBearing: t('itad.sanitization.flash.notDataBearing', '{serial} marked as not carrying data', { serial: asset.serial }),
    }
    flash(messages[action.kind], 'success')
    refresh()
    return null
  }

  const counts = list.data?.counts
  // Bulk actions (Q9) open the same dialogs for the selection; the selection is kept until they finish.
  const bulkActions = React.useMemo<BulkAction<SanitizationRow>[]>(
    () =>
      processing && canExecute
        ? [
            { id: 'itad.sanitization.bulkStart', label: t('itad.sanitization.actions.start', 'Start run'), onExecute: (rows) => { setStartAssets(rows); return false } },
            { id: 'itad.sanitization.bulkResult', label: t('itad.sanitization.actions.recordResult', 'Record result'), onExecute: (rows) => { setResultAssets(rows); return false } },
            { id: 'itad.sanitization.bulkEvidence', label: t('itad.sanitization.actions.attachEvidence', 'Attach evidence'), onExecute: (rows) => { setEvidenceAssets(rows); return false } },
          ]
        : [],
    [canExecute, processing, t],
  )

  return (
    <section className="space-y-4 rounded-lg border bg-card p-4" aria-label={t('itad.sanitization.title', 'Sanitization')}>
      <SectionHeader title={t('itad.sanitization.title', 'Sanitization')} />
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4" aria-live="polite">
        {(
          [
            ['required', assetStatusLabel(t, 'sanitization_required'), counts?.required],
            ['inProgress', assetStatusLabel(t, 'sanitization_in_progress'), counts?.inProgress],
            ['sanitized', assetStatusLabel(t, 'sanitized'), counts?.sanitized],
            ['review', assetStatusLabel(t, 'review_required'), counts?.reviewRequired],
          ] as const
        ).map(([id, label, value]) => (
          <div key={id}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="text-lg font-medium">{value ?? '—'}</dd>
          </div>
        ))}
      </dl>
      {!processing ? (
        <Alert status="information">
          <AlertDescription>{t('itad.sanitization.notProcessing', 'Sanitization runs are possible while the job is in processing.')}</AlertDescription>
        </Alert>
      ) : null}

      {list.error ? (
        <Alert status="error"><AlertDescription>{t('itad.sanitization.loadError', 'Could not load the data-bearing devices')}</AlertDescription></Alert>
      ) : (
        <DataTable<SanitizationRow>
          title={t('itad.sanitization.tableTitle', 'Data-bearing devices')}
          columns={columns}
          data={list.data?.items ?? []}
          searchValue={search}
          searchPlaceholder={t('itad.sanitization.search', 'Search serial or model')}
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
          extensionTableId="itad.assets.sanitization"
          bulkActions={bulkActions}
          selectionScopeKey={`itad-sanitization-${selectionVersion}`}
          emptyState={(
            <p className="py-8 text-center text-sm text-muted-foreground">
              {search.trim() || statusFilter
                ? t('itad.sanitization.noMatches', 'No data-bearing devices match the search.')
                : t('itad.sanitization.empty', 'No device of this job carries data.')}
            </p>
          )}
          rowActions={(row) => {
            const open = row.status === 'sanitization_in_progress'
            const items = [
              ...(processing && canExecute && row.status === 'sanitization_required'
                ? [{ id: 'itad.sanitization.start', label: t('itad.sanitization.actions.start', 'Start run'), onSelect: () => setStartAssets([row]) }]
                : []),
              ...(processing && canExecute && open
                ? [
                    { id: 'itad.sanitization.result', label: t('itad.sanitization.actions.recordResult', 'Record result'), onSelect: () => setResultAssets([row]) },
                    {
                      id: 'itad.sanitization.abort',
                      label: t('itad.sanitization.actions.abort', 'Abort run'),
                      destructive: true,
                      onSelect: () => setReasonAction({ kind: 'abort', asset: row }),
                    },
                  ]
                : []),
              ...(processing && canManage && canResolveExceptions && row.status === 'review_required'
                ? [{ id: 'itad.sanitization.retry', label: t('itad.sanitization.actions.retry', 'Approve retry'), onSelect: () => setReasonAction({ kind: 'retry', asset: row }) }]
                : []),
              ...(reclassifiable && canManage && !open
                ? [
                    {
                      id: 'itad.sanitization.notDataBearing',
                      // Short label: the row actions menu has a fixed width.
                      label: t('itad.sanitization.actions.notDataBearingShort', 'No data on device'),
                      onSelect: () => setReasonAction({ kind: 'notDataBearing', asset: row }),
                    },
                  ]
                : []),
              { id: 'itad.sanitization.history', label: t('itad.sanitization.actions.history', 'History'), onSelect: () => setHistoryAsset(row) },
              {
                id: 'itad.assets.details',
                label: t('itad.assetDetail.open', 'Details'),
                href: `/backend/itad/jobs/${encodeURIComponent(job.id)}/assets/${encodeURIComponent(row.id)}`,
              },
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

      <StartRunDialog jobId={job.id} assets={startAssets} onClose={() => setStartAssets(null)} onDone={refresh} />
      <ResultDialog jobId={job.id} assets={resultAssets} onClose={() => setResultAssets(null)} onDone={refresh} />
      <EvidenceDialog jobId={job.id} assets={evidenceAssets} onClose={() => setEvidenceAssets(null)} onDone={refresh} />
      <HistoryDialog jobId={job.id} asset={historyAsset} onClose={() => setHistoryAsset(null)} />
      <ReasonDialog
        open={reasonAction !== null}
        title={
          reasonAction?.kind === 'abort'
            ? t('itad.sanitization.abort.title', 'Abort the run for {serial}?', { serial: reasonAction.asset.serial })
            : reasonAction?.kind === 'retry'
              ? t('itad.sanitization.retry.title', 'Approve a retry for {serial}?', { serial: reasonAction.asset.serial })
              : t('itad.sanitization.notDataBearing.title', 'Mark {serial} as not carrying data?', { serial: reasonAction?.asset.serial ?? '' })
        }
        description={
          reasonAction?.kind === 'abort'
            ? t('itad.sanitization.abort.description', 'The run stays in the history as aborted; the device waits for a new run.')
            : reasonAction?.kind === 'retry'
              ? t('itad.sanitization.retry.description', 'The failed run stays in the history; the device can be sanitized again.')
              : t('itad.sanitization.notDataBearing.description', 'The device leaves sanitization; its runs stay in the history.')
        }
        submitLabel={
          reasonAction?.kind === 'abort'
            ? t('itad.sanitization.actions.abort', 'Abort run')
            : reasonAction?.kind === 'retry'
              ? t('itad.sanitization.actions.retry', 'Approve retry')
              : t('itad.sanitization.actions.notDataBearing', 'Mark as not carrying data')
        }
        destructive={reasonAction?.kind === 'abort'}
        onSubmit={(reason) => (reasonAction ? submitReason(reasonAction, reason) : Promise.resolve(null))}
        onClose={() => setReasonAction(null)}
      />
    </section>
  )
}

"use client"
import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { SectionHeader } from '@open-mercato/ui/backend/SectionHeader'
import { Alert, AlertDescription } from '@open-mercato/ui/primitives/alert'
import { Button } from '@open-mercato/ui/primitives/button'
import { FormField } from '@open-mercato/ui/primitives/form-field'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { Spinner } from '@open-mercato/ui/primitives/spinner'
import { StatusBadge, type StatusMap } from '@open-mercato/ui/primitives/status-badge'
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
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'
import {
  CERTIFICATE_LOCALES,
  CERTIFICATE_REASON_MIN,
  type CertificateDifference,
  type CertificateLocale,
  type CertificateSourceField,
  type CertificateStatus,
  type EligibilityDetail,
} from '../domain/certificates'
import type { ItadJobStatus } from '../domain/job-types'
import type { CertificateListItem, ReissuePreview } from '../services/certificate-reader'
import { methodLabel } from './sanitization-ui'

type Translate = ReturnType<typeof useT>

type AssetCertificates = {
  items: CertificateListItem[]
  currentCertificateId: string | null
  jobStatus: ItadJobStatus
  issue: { allowed: boolean; code?: string; detail?: EligibilityDetail | null }
  reissue: { allowed: boolean; detail: EligibilityDetail | null }
  void: { allowed: boolean }
}

const STATUS_VARIANTS: StatusMap<CertificateStatus> = { issued: 'success', superseded: 'neutral', void: 'error' }
const STATUS_LABELS: Record<CertificateStatus, string> = { issued: 'Issued', superseded: 'Superseded', void: 'Void' }
const LOCALE_LABELS: Record<CertificateLocale, string> = { pl: 'Polski', en: 'English' }
const DETAIL_LABELS: Record<EligibilityDetail, string> = {
  not_data_bearing: 'The device is not marked as carrying data.',
  not_sanitized: 'The device is not sanitized yet.',
  asset_voided: 'The device was removed from the job.',
  no_pass_run: 'There is no completed sanitization run with the result PASS.',
  job_status: 'Certificates cannot be issued in the current job status.',
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
}

function statusLabel(t: Translate, status: CertificateStatus) {
  return t(`itad.certificates.status.${status}`, STATUS_LABELS[status])
}

const FIELD_LABELS: Record<CertificateSourceField, [string, string]> = {
  customerName: ['itad.certificates.pdf.customer', 'Customer'],
  jobReference: ['itad.certificates.pdf.job', 'ITAD job'],
  customerReference: ['itad.certificates.pdf.customerReference', 'Customer reference'],
  jobName: ['itad.certificates.pdf.jobName', 'Job name'],
  assetSerial: ['itad.certificates.pdf.serial', 'Serial number'],
  customerAssetTag: ['itad.certificates.pdf.assetTag', 'Customer asset tag'],
  manufacturer: ['itad.certificates.fields.manufacturer', 'Manufacturer'],
  model: ['itad.certificates.fields.model', 'Model'],
  mediaIdentifiers: ['itad.certificates.pdf.mediaIdentifiers', 'Media identifiers'],
  method: ['itad.certificates.pdf.method', 'Method'],
  methodDetail: ['itad.certificates.pdf.methodDetail', 'Method detail'],
  tool: ['itad.certificates.pdf.tool', 'Tool'],
  toolVersion: ['itad.certificates.fields.toolVersion', 'Tool version'],
  result: ['itad.certificates.pdf.result', 'Result'],
  verificationMethod: ['itad.certificates.pdf.verification', 'Verification'],
  startedAt: ['itad.certificates.pdf.startedAt', 'Started'],
  completedAt: ['itad.certificates.pdf.completedAt', 'Completed'],
  startedBy: ['itad.certificates.pdf.startedBy', 'Sanitization started by'],
  resultRecordedBy: ['itad.certificates.pdf.resultRecordedBy', 'Result recorded by'],
  sourceRunId: ['itad.certificates.fields.sourceRun', 'Source sanitization run'],
}

function fieldLabel(t: Translate, field: CertificateSourceField): string {
  const [key, fallback] = FIELD_LABELS[field]
  return t(key, fallback)
}

function formatSourceValue(field: CertificateSourceField, value: CertificateDifference['from']): string {
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—'
  if (!value) return '—'
  if (field === 'startedAt' || field === 'completedAt') return formatDateTime(value)
  if (field === 'sourceRunId') return value.slice(0, 8)
  return value
}

function errorCode(body: unknown): string | null {
  const code = (body as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : null
}

function errorMessage(t: Translate, body: unknown, fallback?: string): string {
  const record = (body ?? {}) as { error?: unknown; fields?: unknown }
  const base =
    typeof record.error === 'string' && record.error
      ? record.error
      : fallback ?? t('itad.certificates.errors.issueFailed', 'Could not issue the certificate')
  return Array.isArray(record.fields) && record.fields.length
    ? `${base} (${record.fields.map(String).join(', ')})`
    : base
}

function IssueDialog({
  jobId,
  assetId,
  serial,
  open,
  onClose,
  onIssued,
}: {
  jobId: string
  assetId: string
  serial: string
  open: boolean
  onClose: () => void
  onIssued: () => void
}) {
  const t = useT()
  const uiLocale = useLocale()
  const [locale, setLocale] = React.useState<CertificateLocale>('en')
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  React.useEffect(() => {
    if (!open) return
    setLocale(uiLocale === 'pl' ? 'pl' : 'en')
    setSubmitting(false)
    setError(null)
  }, [open, uiLocale])

  const submit = async () => {
    if (submitting) return
    setSubmitting(true)
    setError(null)
    const call = await apiCall<{ certificateNumber?: string }>(
      `/api/itad/jobs/${encodeURIComponent(jobId)}/assets/${encodeURIComponent(assetId)}/certificates`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ locale }) },
    )
    setSubmitting(false)
    if (!call.ok) {
      setError(errorMessage(t, call.result))
      return
    }
    flash(
      t('itad.certificates.flash.issued', 'Certificate {number} issued', { number: call.result?.certificateNumber ?? '' }),
      'success',
    )
    onIssued()
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !submitting) onClose() }}>
      <DialogContent onKeyDown={submitOnModEnter(() => void submit())}>
        <DialogHeader>
          <DialogTitle>{t('itad.certificates.issue.title', 'Issue certificate for {serial}', { serial })}</DialogTitle>
          <DialogDescription>
            {t(
              'itad.certificates.issue.description',
              'The certificate is a customer document based on the latest PASS sanitization run. Its content is frozen when issued; corrections need a reissue.',
            )}
          </DialogDescription>
        </DialogHeader>
        <FormField label={t('itad.certificates.fields.locale', 'Certificate language')}>
          <Select value={locale} onValueChange={(value) => setLocale(value as CertificateLocale)}>
            <SelectTrigger aria-label={t('itad.certificates.fields.locale', 'Certificate language')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CERTIFICATE_LOCALES.map((value) => (
                <SelectItem key={value} value={value}>{LOCALE_LABELS[value]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        {error ? <Alert status="error"><AlertDescription>{error}</AlertDescription></Alert> : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
            {t('itad.certificates.actions.cancel', 'Cancel')}
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={submitting}>
            {submitting ? <Spinner className="mr-2 h-4 w-4" /> : null}
            {t('itad.certificates.actions.issue', 'Issue certificate')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function submitOnModEnter(submit: () => void) {
  return (event: React.KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      submit()
    }
  }
}

function ReasonField({ value, onChange, invalid }: { value: string; onChange: (value: string) => void; invalid: boolean }) {
  const t = useT()
  return (
    <FormField
      label={t('itad.certificates.fields.reason', 'Reason')}
      required
      error={invalid ? t('itad.certificates.errors.reason_required', 'Enter a reason of at least 3 characters') : undefined}
    >
      <Textarea value={value} rows={3} maxLength={1000} onChange={(event) => onChange(event.target.value)} />
    </FormField>
  )
}

/**
 * Reissue (certificates spec "Reissue", Q7): the preview shows exactly what the new
 * certificate will carry and what changes; a reason and the language are required. A
 * stale preview (409 `certificate_preview_stale`) reloads it so the user confirms again.
 */
function ReissueDialog({
  jobId,
  certificate,
  onClose,
  onDone,
}: {
  jobId: string
  certificate: CertificateListItem | null
  onClose: () => void
  onDone: () => void
}) {
  const t = useT()
  const [reason, setReason] = React.useState('')
  const [locale, setLocale] = React.useState<CertificateLocale>('en')
  const [submitting, setSubmitting] = React.useState(false)
  const [touched, setTouched] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const open = certificate !== null
  const base = `/api/itad/jobs/${encodeURIComponent(jobId)}/certificates/${encodeURIComponent(certificate?.id ?? '')}`
  const preview = useQuery<ReissuePreview>({
    queryKey: ['itad-certificate-reissue-preview', certificate?.id],
    queryFn: async () => readApiResultOrThrow(`${base}/reissue-preview`),
    enabled: open,
    staleTime: 0,
    gcTime: 0,
  })
  React.useEffect(() => {
    if (!certificate) return
    setReason('')
    setLocale(certificate.locale)
    setSubmitting(false)
    setTouched(false)
    setError(null)
  }, [certificate])

  const reasonInvalid = reason.trim().length < CERTIFICATE_REASON_MIN
  const submit = async () => {
    if (!certificate || submitting || !preview.data) return
    setTouched(true)
    if (reasonInvalid) return
    setSubmitting(true)
    setError(null)
    const call = await withScopedApiRequestHeaders(buildOptimisticLockHeader(certificate.updatedAt), () =>
      apiCall<{ certificateNumber?: string }>(`${base}/reissue`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim(), locale, previewHash: preview.data.previewHash }),
      }),
    )
    if (call.ok) {
      flash(
        t('itad.certificates.flash.reissued', 'Certificate {number} issued; {previous} superseded', {
          number: call.result?.certificateNumber ?? '',
          previous: certificate.certificateNumber,
        }),
        'success',
      )
      onDone()
      return
    }
    setSubmitting(false)
    if (errorCode(call.result) === 'itad.certificates.errors.certificate_preview_stale') {
      setError(t('itad.certificates.errors.certificate_preview_stale', 'The certificate data changed after the preview. Review the new preview and confirm again'))
      void preview.refetch()
      return
    }
    if (call.status === 409 && surfaceRecordConflict({ status: call.status, body: call.result }, t)) {
      onDone()
      return
    }
    setError(errorMessage(t, call.result, t('itad.certificates.errors.reissueFailed', 'Could not reissue the certificate')))
  }

  const differences = preview.data?.differences ?? []
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !submitting) onClose() }}>
      <DialogContent className="max-w-2xl" onKeyDown={submitOnModEnter(() => void submit())}>
        <DialogHeader>
          <DialogTitle>
            {t('itad.certificates.reissue.title', 'Reissue certificate {number}', { number: certificate?.certificateNumber ?? '' })}
          </DialogTitle>
          <DialogDescription>
            {t(
              'itad.certificates.reissue.description',
              'A new certificate with a new number is issued from the current data. This certificate stays in the history as superseded.',
            )}
          </DialogDescription>
        </DialogHeader>
        {preview.isLoading || preview.isFetching ? (
          <Spinner className="h-5 w-5" />
        ) : preview.error ? (
          <Alert status="error">
            <AlertDescription>{t('itad.certificates.reissue.previewError', 'Could not load the preview')}</AlertDescription>
          </Alert>
        ) : differences.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('itad.certificates.reissue.noDifferences', 'The data has not changed. The new certificate repeats the current content with a new number.')}
          </p>
        ) : (
          <div className="space-y-2">
            <p className="text-sm font-medium">{t('itad.certificates.reissue.differences', 'Changes on the new certificate')}</p>
            <table className="w-full text-sm" data-testid="itad-certificate-reissue-differences">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th scope="col" className="py-1 pr-3 font-normal">{t('itad.certificates.reissue.field', 'Field')}</th>
                  <th scope="col" className="py-1 pr-3 font-normal">{t('itad.certificates.reissue.current', 'Current certificate')}</th>
                  <th scope="col" className="py-1 font-normal">{t('itad.certificates.reissue.next', 'New certificate')}</th>
                </tr>
              </thead>
              <tbody>
                {differences.map((difference) => (
                  <tr key={difference.field} className="border-t align-top">
                    <th scope="row" className="py-1 pr-3 text-left font-medium">{fieldLabel(t, difference.field)}</th>
                    <td className="py-1 pr-3 break-all text-muted-foreground line-through">{formatSourceValue(difference.field, difference.from)}</td>
                    <td className="py-1 break-all">{formatSourceValue(difference.field, difference.to)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <FormField label={t('itad.certificates.fields.locale', 'Certificate language')}>
          <Select value={locale} onValueChange={(value) => setLocale(value as CertificateLocale)}>
            <SelectTrigger aria-label={t('itad.certificates.fields.locale', 'Certificate language')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CERTIFICATE_LOCALES.map((value) => (
                <SelectItem key={value} value={value}>{LOCALE_LABELS[value]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        <ReasonField value={reason} onChange={setReason} invalid={touched && reasonInvalid} />
        {error ? <Alert status="error"><AlertDescription>{error}</AlertDescription></Alert> : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
            {t('itad.certificates.actions.cancel', 'Cancel')}
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={submitting || !preview.data || preview.isFetching}>
            {submitting ? <Spinner className="mr-2 h-4 w-4" /> : null}
            {t('itad.certificates.actions.reissue', 'Reissue')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Void with a required reason (spec "Void", Q11); warns when the job is already completed. */
function VoidDialog({
  jobId,
  certificate,
  jobStatus,
  onClose,
  onDone,
}: {
  jobId: string
  certificate: CertificateListItem | null
  jobStatus: ItadJobStatus | null
  onClose: () => void
  onDone: () => void
}) {
  const t = useT()
  const [reason, setReason] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [touched, setTouched] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  React.useEffect(() => {
    if (!certificate) return
    setReason('')
    setSubmitting(false)
    setTouched(false)
    setError(null)
  }, [certificate])

  const reasonInvalid = reason.trim().length < CERTIFICATE_REASON_MIN
  const submit = async () => {
    if (!certificate || submitting) return
    setTouched(true)
    if (reasonInvalid) return
    setSubmitting(true)
    setError(null)
    const call = await withScopedApiRequestHeaders(buildOptimisticLockHeader(certificate.updatedAt), () =>
      apiCall(
        `/api/itad/jobs/${encodeURIComponent(jobId)}/certificates/${encodeURIComponent(certificate.id)}/void`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: reason.trim() }) },
      ),
    )
    if (call.ok) {
      flash(t('itad.certificates.flash.voided', 'Certificate {number} voided', { number: certificate.certificateNumber }), 'success')
      onDone()
      return
    }
    setSubmitting(false)
    if (call.status === 409 && surfaceRecordConflict({ status: call.status, body: call.result }, t)) {
      onDone()
      return
    }
    setError(errorMessage(t, call.result, t('itad.certificates.errors.voidFailed', 'Could not void the certificate')))
  }

  return (
    <Dialog open={certificate !== null} onOpenChange={(next) => { if (!next && !submitting) onClose() }}>
      <DialogContent onKeyDown={submitOnModEnter(() => void submit())}>
        <DialogHeader>
          <DialogTitle>
            {t('itad.certificates.void.title', 'Void certificate {number}', { number: certificate?.certificateNumber ?? '' })}
          </DialogTitle>
          <DialogDescription>
            {t(
              'itad.certificates.void.description',
              'The certificate stops being valid but stays in the history with its PDF. If the device still requires a certificate, it counts as missing again.',
            )}
          </DialogDescription>
        </DialogHeader>
        {jobStatus === 'completed' ? (
          <Alert status="warning">
            <AlertDescription>
              {t('itad.certificates.void.completedWarning', 'This job is completed. After the void it lacks a valid certificate for this device until a new one is issued.')}
            </AlertDescription>
          </Alert>
        ) : null}
        <ReasonField value={reason} onChange={setReason} invalid={touched && reasonInvalid} />
        {error ? <Alert status="error"><AlertDescription>{error}</AlertDescription></Alert> : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
            {t('itad.certificates.actions.cancel', 'Cancel')}
          </Button>
          <Button type="button" variant="destructive" onClick={() => void submit()} disabled={submitting}>
            {submitting ? <Spinner className="mr-2 h-4 w-4" /> : null}
            {t('itad.certificates.actions.void', 'Void')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function userName(t: Translate, user: { name: string | null } | null): string {
  return user?.name ?? t('itad.jobs.history.unknownUser', 'unknown user')
}

/** History lines of one certificate: what it replaces, what replaced it, and why it is void. */
function CertificateHistory({ t, item, numbers }: { t: Translate; item: CertificateListItem; numbers: Map<string, string> }) {
  const replaces = item.supersedesCertificateId ? numbers.get(item.supersedesCertificateId) : null
  const replacedBy = item.supersededByCertificateId ? numbers.get(item.supersededByCertificateId) : null
  return (
    <>
      {replaces ? <div>{t('itad.certificates.history.replaces', 'Replaces {number}', { number: replaces })}</div> : null}
      {item.status === 'superseded' ? (
        <div>
          {t('itad.certificates.history.superseded', 'Replaced by {number} on {date} by {user}: {reason}', {
            number: replacedBy ?? '—',
            date: formatDateTime(item.supersededAt),
            user: userName(t, item.supersededBy),
            reason: item.supersedeReason ?? '—',
          })}
        </div>
      ) : null}
      {item.status === 'void' ? (
        <div>
          {item.voidReasonCode === 'reclassified_non_data_bearing'
            ? t('itad.certificates.history.voidedReclassified', 'Voided automatically on {date}: {user} reclassified the device as not carrying data ({reason})', {
                date: formatDateTime(item.voidedAt),
                user: userName(t, item.voidedBy),
                reason: item.voidReason ?? '—',
              })
            : t('itad.certificates.history.voided', 'Voided on {date} by {user}: {reason}', {
                date: formatDateTime(item.voidedAt),
                user: userName(t, item.voidedBy),
                reason: item.voidReason ?? '—',
              })}
        </div>
      ) : null}
    </>
  )
}

/**
 * "Certificates" section of the asset detail (certificates spec "UI/UX", REQ-609): the
 * asset's certificates with the current one marked, their history, PDF links, "Issue
 * certificate", and "Reissue" / "Void" for the current one (REQ-607, REQ-608).
 */
export function AssetCertificatesSection({
  jobId,
  assetId,
  serial,
  canIssue,
  canManage,
}: {
  jobId: string
  assetId: string
  serial: string
  canIssue: boolean
  canManage: boolean
}) {
  const t = useT()
  const queryClient = useQueryClient()
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [reissuing, setReissuing] = React.useState<CertificateListItem | null>(null)
  const [voiding, setVoiding] = React.useState<CertificateListItem | null>(null)
  const base = `/api/itad/jobs/${encodeURIComponent(jobId)}`
  const queryKey = ['itad-asset-certificates', jobId, assetId]
  const certificates = useQuery<AssetCertificates>({
    queryKey,
    queryFn: async () => readApiResultOrThrow(`${base}/assets/${encodeURIComponent(assetId)}/certificates`),
  })
  const title = t('itad.certificates.title', 'Certificates')
  const issue = certificates.data?.issue
  const numbers = React.useMemo(
    () => new Map((certificates.data?.items ?? []).map((item) => [item.id, item.certificateNumber])),
    [certificates.data],
  )
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey })
    void queryClient.invalidateQueries({ queryKey: ['itad-asset-timeline', jobId, assetId] })
  }

  return (
    <section className="space-y-3 rounded-lg border bg-card p-4" aria-label={title} data-testid="itad-asset-certificates">
      <SectionHeader
        title={title}
        action={
          canIssue && issue?.allowed ? (
            <Button type="button" size="sm" onClick={() => setDialogOpen(true)}>
              {t('itad.certificates.actions.issue', 'Issue certificate')}
            </Button>
          ) : null
        }
      />
      {certificates.isLoading ? (
        <Spinner className="h-5 w-5" />
      ) : certificates.error ? (
        <Alert status="error"><AlertDescription>{t('itad.certificates.loadError', 'Could not load the certificates')}</AlertDescription></Alert>
      ) : (certificates.data?.items.length ?? 0) === 0 ? (
        <p className="text-sm text-muted-foreground">
          {issue?.allowed
            ? t('itad.certificates.empty.eligible', 'No certificate yet. The device is ready for one.')
            : issue?.detail
              ? t(`itad.certificates.notEligible.${issue.detail}`, DETAIL_LABELS[issue.detail])
              : t('itad.certificates.empty', 'No certificates.')}
        </p>
      ) : (
        <ul className="space-y-3 text-sm">
          {certificates.data!.items.map((item) => (
            <li key={item.id} className="space-y-1 rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-mono font-medium">{item.certificateNumber}</span>
                <StatusBadge variant={STATUS_VARIANTS[item.status]} dot>{statusLabel(t, item.status)}</StatusBadge>
                {item.id === certificates.data!.currentCertificateId ? (
                  <span className="text-xs text-muted-foreground">{t('itad.certificates.current', 'Current')}</span>
                ) : null}
                <a
                  className="ml-auto underline underline-offset-2"
                  href={`${base}/certificates/${encodeURIComponent(item.id)}/pdf`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t('itad.certificates.actions.openPdf', 'Open PDF')}
                </a>
              </div>
              <div className="text-muted-foreground">
                {t('itad.certificates.issuedLine', 'Issued {date} by {user}', {
                  date: formatDateTime(item.issuedAt),
                  user: item.issuedBy.name ?? t('itad.jobs.history.unknownUser', 'unknown user'),
                })}
              </div>
              <div className="text-muted-foreground">
                {t('itad.certificates.sourceRun', 'Source run: {method} · {tool} · completed {date}', {
                  method: methodLabel(t, item.sourceRun.method as Parameters<typeof methodLabel>[1]),
                  tool: `${item.sourceRun.tool} ${item.sourceRun.toolVersion}`.trim(),
                  date: formatDateTime(item.sourceRun.completedAt),
                })}
              </div>
              <CertificateHistory t={t} item={item} numbers={numbers} />
              {canManage && item.id === certificates.data!.currentCertificateId ? (
                <div className="flex flex-wrap gap-2 pt-1">
                  {certificates.data!.reissue.allowed ? (
                    <Button type="button" size="sm" variant="outline" onClick={() => setReissuing(item)}>
                      {t('itad.certificates.actions.reissue', 'Reissue')}
                    </Button>
                  ) : null}
                  {certificates.data!.void.allowed ? (
                    <Button type="button" size="sm" variant="outline" onClick={() => setVoiding(item)}>
                      {t('itad.certificates.actions.void', 'Void')}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <IssueDialog
        jobId={jobId}
        assetId={assetId}
        serial={serial}
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onIssued={() => {
          setDialogOpen(false)
          refresh()
        }}
      />
      <ReissueDialog
        jobId={jobId}
        certificate={reissuing}
        onClose={() => setReissuing(null)}
        onDone={() => {
          setReissuing(null)
          refresh()
        }}
      />
      <VoidDialog
        jobId={jobId}
        certificate={voiding}
        jobStatus={certificates.data?.jobStatus ?? null}
        onClose={() => setVoiding(null)}
        onDone={() => {
          setVoiding(null)
          refresh()
        }}
      />
    </section>
  )
}

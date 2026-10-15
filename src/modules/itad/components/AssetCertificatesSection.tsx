"use client"
import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { SectionHeader } from '@open-mercato/ui/backend/SectionHeader'
import { Alert, AlertDescription } from '@open-mercato/ui/primitives/alert'
import { Button } from '@open-mercato/ui/primitives/button'
import { FormField } from '@open-mercato/ui/primitives/form-field'
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
import { apiCall, readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'
import { CERTIFICATE_LOCALES, type CertificateLocale, type CertificateStatus, type EligibilityDetail } from '../domain/certificates'
import type { CertificateListItem } from '../services/certificate-reader'
import { methodLabel } from './sanitization-ui'

type Translate = ReturnType<typeof useT>

type AssetCertificates = {
  items: CertificateListItem[]
  currentCertificateId: string | null
  issue: { allowed: boolean; code?: string; detail?: EligibilityDetail | null }
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

function errorMessage(t: Translate, body: unknown): string {
  const record = (body ?? {}) as { error?: unknown; fields?: unknown }
  const base = typeof record.error === 'string' && record.error ? record.error : t('itad.certificates.errors.issueFailed', 'Could not issue the certificate')
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
      <DialogContent
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            void submit()
          }
        }}
      >
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

/**
 * "Certificates" section of the asset detail (certificates spec "UI/UX", REQ-609): the
 * asset's certificates with the current one marked, PDF links, and "Issue certificate".
 */
export function AssetCertificatesSection({
  jobId,
  assetId,
  serial,
  canIssue,
}: {
  jobId: string
  assetId: string
  serial: string
  canIssue: boolean
}) {
  const t = useT()
  const queryClient = useQueryClient()
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const base = `/api/itad/jobs/${encodeURIComponent(jobId)}`
  const queryKey = ['itad-asset-certificates', jobId, assetId]
  const certificates = useQuery<AssetCertificates>({
    queryKey,
    queryFn: async () => readApiResultOrThrow(`${base}/assets/${encodeURIComponent(assetId)}/certificates`),
  })
  const title = t('itad.certificates.title', 'Certificates')
  const issue = certificates.data?.issue

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
              {item.voidReason ? (
                <div>{t('itad.certificates.voidReason', 'Void reason: {reason}', { reason: item.voidReason })}</div>
              ) : null}
              {item.supersedeReason ? (
                <div>{t('itad.certificates.supersedeReason', 'Replaced: {reason}', { reason: item.supersedeReason })}</div>
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
          void queryClient.invalidateQueries({ queryKey })
          void queryClient.invalidateQueries({ queryKey: ['itad-asset-timeline', jobId, assetId] })
        }}
      />
    </section>
  )
}

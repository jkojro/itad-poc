"use client"
import * as React from 'react'
import Link from 'next/link'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { LegacyColumnDef as ColumnDef } from '@tanstack/react-table/legacy'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import { SectionHeader } from '@open-mercato/ui/backend/SectionHeader'
import type { FilterValues } from '@open-mercato/ui/backend/FilterBar'
import { Alert, AlertDescription } from '@open-mercato/ui/primitives/alert'
import { Button } from '@open-mercato/ui/primitives/button'
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
import { apiCall, readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'
import { CERTIFICATE_LOCALES, CERTIFICATE_STATUSES, type CertificateLocale, type CertificateStatus } from '../domain/certificates'
import type { CertificateListItem } from '../services/certificate-reader'
import {
  CERTIFICATE_LOCALE_LABELS,
  CERTIFICATE_STATUS_VARIANTS,
  certificatePdfHref,
  certificateStatusLabel,
  formatCertificateDateTime,
} from './certificate-ui'
import type { ItadJobListItem } from './types'

type Translate = ReturnType<typeof useT>

type Counts = { dataBearing: number; sanitized: number; required: number; issued: number; missing: number }

type JobCertificates = {
  items: CertificateListItem[]
  counts: Counts
  missingAssets: Array<{ id: string; serial: string }>
  issue: { allowed: boolean }
}

type IssueMissingResult = {
  issued: Array<{ assetId: string; serial: string; certificateNumber: string }>
  failed: Array<{ assetId: string; serial: string; error: string | null }>
}

const COUNT_LABELS: Array<[keyof Counts, string, string]> = [
  ['dataBearing', 'itad.documents.counts.dataBearing', 'Data-bearing'],
  ['sanitized', 'itad.documents.counts.sanitized', 'Sanitized'],
  ['required', 'itad.documents.counts.required', 'Require a certificate'],
  ['issued', 'itad.documents.counts.issued', 'Issued'],
  ['missing', 'itad.documents.counts.missing', 'Missing'],
]

const assetHref = (jobId: string, assetId: string) =>
  `/backend/itad/jobs/${encodeURIComponent(jobId)}/assets/${encodeURIComponent(assetId)}`

function buildColumns(t: Translate, jobId: string): ColumnDef<CertificateListItem>[] {
  return [
    {
      id: 'certificateNumber',
      header: t('itad.certificates.pdf.number', 'Certificate number'),
      cell: ({ row }) => <span className="font-mono">{row.original.certificateNumber}</span>,
    },
    {
      id: 'status',
      header: t('itad.documents.columns.status', 'Status'),
      meta: { truncate: false },
      cell: ({ row }) => (
        <StatusBadge variant={CERTIFICATE_STATUS_VARIANTS[row.original.status]} dot>
          {certificateStatusLabel(t, row.original.status)}
        </StatusBadge>
      ),
    },
    {
      id: 'serial',
      header: t('itad.manifest.field.serial', 'Serial number'),
      cell: ({ row }) => (
        <Link className="font-mono underline underline-offset-2" href={assetHref(jobId, row.original.assetId)}>
          {row.original.assetSerial}
        </Link>
      ),
    },
    {
      id: 'issuedAt',
      header: t('itad.certificates.pdf.issuedAt', 'Issued'),
      cell: ({ row }) => formatCertificateDateTime(row.original.issuedAt),
    },
    {
      id: 'issuedBy',
      header: t('itad.certificates.pdf.issuedBy', 'Issued by'),
      cell: ({ row }) => row.original.issuedBy.name ?? t('itad.jobs.history.unknownUser', 'unknown user'),
    },
    {
      id: 'pdf',
      header: t('itad.documents.columns.pdf', 'PDF'),
      cell: ({ row }) => (
        <a className="underline underline-offset-2" href={certificatePdfHref(jobId, row.original.id)} target="_blank" rel="noreferrer">
          {t('itad.certificates.actions.openPdf', 'Open PDF')}
        </a>
      ),
    },
  ]
}

/**
 * "Issue all missing" (certificates spec Q6): one independent issue per missing asset in
 * the chosen language; the dialog then lists what was issued and what failed, and why.
 */
function IssueMissingDialog({
  jobId,
  missing,
  open,
  onClose,
  onDone,
}: {
  jobId: string
  missing: number
  open: boolean
  onClose: () => void
  onDone: () => void
}) {
  const t = useT()
  const uiLocale = useLocale()
  const [locale, setLocale] = React.useState<CertificateLocale>('en')
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [result, setResult] = React.useState<IssueMissingResult | null>(null)
  React.useEffect(() => {
    if (!open) return
    setLocale(uiLocale === 'pl' ? 'pl' : 'en')
    setSubmitting(false)
    setError(null)
    setResult(null)
  }, [open, uiLocale])

  const submit = async () => {
    if (submitting || result) return
    setSubmitting(true)
    setError(null)
    const call = await apiCall<IssueMissingResult>(`/api/itad/jobs/${encodeURIComponent(jobId)}/certificates/issue-missing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ locale }),
    })
    setSubmitting(false)
    if (!call.ok || !call.result) {
      const message = (call.result as { error?: unknown } | null)?.error
      setError(typeof message === 'string' && message ? message : t('itad.documents.issueMissing.error', 'Could not issue the certificates'))
      return
    }
    setResult(call.result)
    if (call.result.issued.length > 0) {
      flash(t('itad.documents.issueMissing.flash', '{count} certificates issued', { count: call.result.issued.length }), 'success')
    }
    onDone()
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
          <DialogTitle>{t('itad.documents.issueMissing.title', 'Issue all missing certificates')}</DialogTitle>
          <DialogDescription>
            {t(
              'itad.documents.issueMissing.description',
              '{count} devices still need a certificate. Each gets its own certificate with a new number, based on its latest PASS run.',
              { count: missing },
            )}
          </DialogDescription>
        </DialogHeader>
        {result ? (
          <div className="space-y-3 text-sm" aria-live="polite" data-testid="itad-documents-issue-result">
            <p>
              {t('itad.documents.issueMissing.summary', 'Issued: {issued}. Failed: {failed}.', {
                issued: result.issued.length,
                failed: result.failed.length,
              })}
            </p>
            {result.failed.length > 0 ? (
              <ul className="space-y-1">
                {result.failed.map((entry) => (
                  <li key={entry.assetId}>
                    <Link className="font-mono underline underline-offset-2" href={assetHref(jobId, entry.assetId)}>{entry.serial}</Link>
                    {': '}
                    {entry.error ?? t('itad.documents.issueMissing.error', 'Could not issue the certificates')}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : (
          <FormField label={t('itad.certificates.fields.locale', 'Certificate language')}>
            <Select value={locale} onValueChange={(value) => setLocale(value as CertificateLocale)}>
              <SelectTrigger aria-label={t('itad.certificates.fields.locale', 'Certificate language')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CERTIFICATE_LOCALES.map((value) => (
                  <SelectItem key={value} value={value}>{CERTIFICATE_LOCALE_LABELS[value]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        )}
        {error ? <Alert status="error"><AlertDescription>{error}</AlertDescription></Alert> : null}
        <DialogFooter>
          {result ? (
            <Button type="button" onClick={onClose}>{t('itad.documents.issueMissing.close', 'Close')}</Button>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
                {t('itad.certificates.actions.cancel', 'Cancel')}
              </Button>
              <Button type="button" onClick={() => void submit()} disabled={submitting}>
                {submitting ? <Spinner className="mr-2 h-4 w-4" /> : null}
                {t('itad.documents.issueMissing.submit', 'Issue {count} certificates', { count: missing })}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Job "Documents" tab (certificates spec "UI/UX", REQ-610): counts of required, issued
 * and missing certificates, the devices still missing one, "Issue all missing", and every
 * certificate of the job with its PDF.
 */
export function JobDocumentsPanel({ job, canIssue }: { job: ItadJobListItem; canIssue: boolean }) {
  const t = useT()
  const queryClient = useQueryClient()
  const [filterValues, setFilterValues] = React.useState<FilterValues>({})
  const [issueOpen, setIssueOpen] = React.useState(false)
  const status = CERTIFICATE_STATUSES.find((value) => value === filterValues.status) as CertificateStatus | undefined
  const queryKey = ['itad-job-certificates', job.id, status ?? 'all']
  const data = useQuery<JobCertificates>({
    queryKey,
    queryFn: async () =>
      readApiResultOrThrow(`/api/itad/jobs/${encodeURIComponent(job.id)}/certificates${status ? `?status=${status}` : ''}`),
  })
  const columns = React.useMemo(() => buildColumns(t, job.id), [t, job.id])
  const filters = React.useMemo(
    () => [
      {
        id: 'status',
        label: t('itad.documents.columns.status', 'Status'),
        type: 'select' as const,
        options: CERTIFICATE_STATUSES.map((value) => ({ value, label: certificateStatusLabel(t, value) })),
      },
    ],
    [t],
  )
  const counts = data.data?.counts
  const missingAssets = data.data?.missingAssets ?? []
  const title = t('itad.documents.title', 'Documents')

  return (
    <section className="space-y-4 rounded-lg border bg-card p-4" aria-label={title} data-testid="itad-job-documents">
      <SectionHeader
        title={title}
        action={
          canIssue && data.data?.issue.allowed && missingAssets.length > 0 ? (
            <Button type="button" size="sm" onClick={() => setIssueOpen(true)}>
              {t('itad.documents.issueMissing.open', 'Issue all missing')}
            </Button>
          ) : null
        }
      />
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5" aria-live="polite">
        {COUNT_LABELS.map(([key, labelKey, fallback]) => (
          <div key={key}>
            <dt className="text-muted-foreground">{t(labelKey, fallback)}</dt>
            <dd className="text-lg font-medium" data-testid={`itad-documents-count-${key}`}>{counts ? counts[key] : '—'}</dd>
          </div>
        ))}
      </dl>
      {data.error ? (
        <Alert status="error"><AlertDescription>{t('itad.documents.loadError', 'Could not load the documents')}</AlertDescription></Alert>
      ) : (
        <>
          {missingAssets.length > 0 ? (
            <div className="space-y-2">
              <h3 className="text-sm font-medium">{t('itad.documents.missingTitle', 'Devices missing a certificate')}</h3>
              <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                {missingAssets.map((asset) => (
                  <li key={asset.id}>
                    <Link className="font-mono underline underline-offset-2" href={assetHref(job.id, asset.id)}>{asset.serial}</Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : counts && counts.required > 0 ? (
            <p className="text-sm text-muted-foreground">{t('itad.documents.allIssued', 'Every device that requires a certificate has one.')}</p>
          ) : null}
          <DataTable<CertificateListItem>
            title={t('itad.documents.tableTitle', 'Certificates of this job')}
            columns={columns}
            data={data.data?.items ?? []}
            filters={filters}
            filterValues={filterValues}
            onFiltersApply={(values: FilterValues) => setFilterValues(values)}
            onFiltersClear={() => setFilterValues({})}
            extensionTableId="itad.certificates.job"
            emptyState={(
              <p className="py-8 text-center text-sm text-muted-foreground">
                {status ? t('itad.documents.emptyFiltered', 'No certificates match the filters.') : t('itad.documents.empty', 'No certificates issued yet.')}
              </p>
            )}
            isLoading={data.isLoading}
          />
        </>
      )}
      <IssueMissingDialog
        jobId={job.id}
        missing={missingAssets.length}
        open={issueOpen}
        onClose={() => setIssueOpen(false)}
        onDone={() => {
          void queryClient.invalidateQueries({ queryKey: ['itad-job-certificates', job.id] })
        }}
      />
    </section>
  )
}

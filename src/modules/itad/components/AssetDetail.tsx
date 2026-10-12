"use client"
import * as React from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { SectionHeader } from '@open-mercato/ui/backend/SectionHeader'
import { Alert, AlertDescription } from '@open-mercato/ui/primitives/alert'
import { Spinner } from '@open-mercato/ui/primitives/spinner'
import { StatusBadge } from '@open-mercato/ui/primitives/status-badge'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import type { TimelineKind } from '../domain/asset-timeline'
import type { ItadDataBearingSource } from '../domain/data-bearing'
import type { ItadExceptionOutcome, ItadExceptionType } from '../domain/exceptions'
import type { ItadAssetStatus, ItadJobStatus, ItadScanResult } from '../domain/job-types'
import type { ItadSanitizationMethod } from '../domain/sanitization-state-machine'
import { ASSET_STATUS_VARIANTS, assetStatusLabel, dataBearingLabel, dataBearingSourceLabel } from './data-bearing-ui'
import { EXCEPTION_STATUS_VARIANTS, exceptionOutcomeLabel, exceptionStatusLabel, exceptionTypeLabel } from './exception-ui'
import type { ExceptionList } from './exception-types'
import { ReconciliationBadge } from './reconciliation-ui'
import { RUN_RESULT_VARIANTS, methodLabel, runResultLabel, verificationLabel } from './sanitization-ui'
import type { AssetSanitization } from './sanitization-types'
import { useGrantedFeatures } from './use-granted-features'

type Translate = ReturnType<typeof useT>
type Actor = { id: string; name: string | null } | null

type AssetDetailBody = {
  id: string
  serial: string
  customerAssetTag: string | null
  manufacturer: string | null
  model: string | null
  dataBearing: boolean | null
  dataBearingSource: ItadDataBearingSource | null
  status: ItadAssetStatus
  reconciliation: 'matched' | 'unexpected'
  receivedAt: string
  receivedBy: { id: string; name: string | null }
  deleted: boolean
  openExceptionCount: number
  job: { id: string; internalReference: string; name: string; status: ItadJobStatus }
}

type TimelineItem = {
  at: string
  kind: TimelineKind
  category: string
  actor: Actor
  details: {
    scanResult?: ItadScanResult
    dataBearingFrom?: boolean | null
    dataBearingTo?: boolean | null
    dataBearingSource?: ItadDataBearingSource | null
    method?: ItadSanitizationMethod | null
    tool?: string | null
    exceptionType?: ItadExceptionType
    outcome?: ItadExceptionOutcome | null
    assignedTo?: Actor
    reason?: string | null
  }
}

const FEATURES = ['itad.sanitization.view', 'itad.exceptions.view'] as const

const KIND_LABELS: Record<TimelineKind, string> = {
  received: 'Received',
  scanned_again: 'Scanned again (duplicate)',
  duplicate_same_device: 'Duplicate resolved: same device',
  duplicate_flagged: 'Duplicate flagged as a different device',
  duplicate_set_aside: 'Second device set aside',
  voided: 'Scan removed (voided)',
  data_bearing_decided: 'Carries data decided',
  data_bearing_changed: 'Carries data changed',
  sanitization_started: 'Sanitization started',
  sanitization_passed: 'Sanitization passed',
  sanitization_failed: 'Sanitization failed',
  sanitization_aborted: 'Sanitization aborted',
  retry_approved: 'Retry approved',
  exception_opened: 'Exception opened',
  exception_assigned: 'Exception assigned',
  exception_unassigned: 'Exception unassigned',
  exception_resolved: 'Exception resolved',
  reconciled: 'Reconciled — receiving finished',
  job_completed: 'Job completed',
  job_cancelled: 'Job cancelled',
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()
}

/** One line of business detail under a timeline entry. */
function timelineDetail(t: Translate, item: TimelineItem): string | null {
  const d = item.details
  switch (item.kind) {
    case 'received':
      return d.scanResult ? t(`itad.timeline.scanResult.${d.scanResult}`, d.scanResult === 'matched' ? 'Matched the manifest' : 'Not in the manifest') : null
    case 'data_bearing_decided':
      return `${dataBearingLabel(t, d.dataBearingTo)}${d.dataBearingSource ? ` (${dataBearingSourceLabel(t, d.dataBearingSource)})` : ''}`
    case 'data_bearing_changed':
      return `${dataBearingLabel(t, d.dataBearingFrom)} → ${dataBearingLabel(t, d.dataBearingTo)}${d.reason ? ` · ${d.reason}` : ''}`
    case 'sanitization_started':
    case 'sanitization_passed':
      return [d.method ? methodLabel(t, d.method) : null, d.tool].filter(Boolean).join(' · ') || null
    case 'exception_opened':
      return d.exceptionType ? exceptionTypeLabel(t, d.exceptionType) : null
    case 'exception_assigned':
      return d.assignedTo ? d.assignedTo.name ?? t('itad.jobs.history.unknownUser', 'unknown user') : null
    case 'exception_resolved':
      return [d.exceptionType ? exceptionTypeLabel(t, d.exceptionType) : null, d.outcome ? exceptionOutcomeLabel(t, d.outcome) : null, d.reason]
        .filter(Boolean)
        .join(' · ')
    default:
      return d.reason ?? null
  }
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-lg border bg-card p-4" aria-label={title}>
      <SectionHeader title={title} />
      {children}
    </section>
  )
}

/**
 * Asset detail page (exceptions spec "Asset detail", E4-062, E4-063): the device, its
 * exceptions, its sanitization runs and its business timeline. Sections follow the
 * viewer's features; every API route enforces its own.
 */
export function AssetDetail({ jobId, assetId }: { jobId: string; assetId: string }) {
  const t = useT()
  const { granted } = useGrantedFeatures(FEATURES)
  const canViewSanitization = granted.has('itad.sanitization.view')
  const canViewExceptions = granted.has('itad.exceptions.view')
  const base = `/api/itad/jobs/${encodeURIComponent(jobId)}`
  const asset = useQuery<AssetDetailBody>({
    queryKey: ['itad-asset-detail', jobId, assetId],
    queryFn: async () => readApiResultOrThrow(`${base}/assets/${encodeURIComponent(assetId)}`),
  })
  const timeline = useQuery<{ items: TimelineItem[] }>({
    queryKey: ['itad-asset-timeline', jobId, assetId],
    queryFn: async () => readApiResultOrThrow(`${base}/assets/${encodeURIComponent(assetId)}/timeline`),
  })
  const exceptions = useQuery<ExceptionList>({
    queryKey: ['itad-asset-exceptions', jobId, assetId],
    enabled: canViewExceptions,
    queryFn: async () => readApiResultOrThrow(`${base}/exceptions?assetId=${encodeURIComponent(assetId)}&pageSize=100`),
  })
  const runs = useQuery<AssetSanitization>({
    queryKey: ['itad-asset-sanitization', jobId, assetId],
    enabled: canViewSanitization,
    queryFn: async () => readApiResultOrThrow(`${base}/assets/${encodeURIComponent(assetId)}/sanitization`),
  })
  const unknownUser = t('itad.jobs.history.unknownUser', 'unknown user')

  if (asset.isLoading) return <div className="flex justify-center py-12"><Spinner className="h-6 w-6" /></div>
  if (asset.error || !asset.data) {
    return <Alert status="error"><AlertDescription>{t('itad.assetDetail.loadError', 'Could not load the device')}</AlertDescription></Alert>
  }
  const data = asset.data

  return (
    <div className="space-y-6">
      <section className="space-y-3 rounded-lg border bg-card p-4" aria-label={t('itad.assetDetail.title', 'Device')}>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-mono text-xl font-semibold">{data.serial}</h1>
          <StatusBadge variant={ASSET_STATUS_VARIANTS[data.status]} dot>{assetStatusLabel(t, data.status)}</StatusBadge>
          <ReconciliationBadge t={t} state={data.reconciliation} />
          {data.deleted ? <StatusBadge variant="neutral">{t('itad.receiving.duplicates.assetRemoved', 'Asset removed')}</StatusBadge> : null}
        </div>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <dt className="text-muted-foreground">{t('itad.assets.lookup.job', 'Job')}</dt>
            <dd>
              <Link className="underline underline-offset-2" href={`/backend/itad/jobs/${encodeURIComponent(data.job.id)}`}>
                {data.job.internalReference}
              </Link>{' '}
              · {data.job.name}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t('itad.manifest.field.model', 'Model')}</dt>
            <dd>{[data.manufacturer, data.model].filter(Boolean).join(' ') || '—'}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t('itad.manifest.field.customerAssetTag', 'Customer asset tag')}</dt>
            <dd>{data.customerAssetTag ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t('itad.receiving.dataBearing.label', 'Carries data')}</dt>
            <dd>
              {dataBearingLabel(t, data.dataBearing)}
              {data.dataBearingSource ? (
                <>
                  {' '}
                  <span className="text-xs text-muted-foreground">({dataBearingSourceLabel(t, data.dataBearingSource)})</span>
                </>
              ) : null}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t('itad.receiving.assets.receivedAt', 'Received')}</dt>
            <dd>{formatDateTime(data.receivedAt)} · {data.receivedBy.name ?? unknownUser}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t('itad.exceptions.openSummaryLabel', 'Open exceptions')}</dt>
            <dd>{data.openExceptionCount}</dd>
          </div>
        </dl>
      </section>

      {canViewExceptions ? (
        <Section title={t('itad.exceptions.title', 'Exceptions')}>
          {exceptions.isLoading ? (
            <Spinner className="h-5 w-5" />
          ) : (exceptions.data?.items ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('itad.assetDetail.noExceptions', 'No exceptions for this device.')}</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {(exceptions.data?.items ?? []).map((entry) => (
                <li key={entry.id} className="flex flex-col gap-1 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{exceptionTypeLabel(t, entry.type)}</span>
                    <StatusBadge variant={EXCEPTION_STATUS_VARIANTS[entry.status]} dot>{exceptionStatusLabel(t, entry.status)}</StatusBadge>
                    {entry.resolutionOutcome ? <span>{exceptionOutcomeLabel(t, entry.resolutionOutcome)}</span> : null}
                  </div>
                  <span className="text-muted-foreground">
                    {entry.status === 'resolved'
                      ? `${formatDateTime(entry.resolvedAt)} · ${entry.resolvedBy?.name ?? unknownUser}`
                      : entry.assignedTo
                        ? entry.assignedTo.name ?? unknownUser
                        : t('itad.exceptions.unassigned', 'Unassigned')}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <Link className="text-sm underline underline-offset-2" href={`/backend/itad/jobs/${encodeURIComponent(jobId)}?tab=exceptions`}>
            {t('itad.assetDetail.openExceptionsTab', 'Open the job exceptions')}
          </Link>
        </Section>
      ) : null}

      {canViewSanitization ? (
        <Section title={t('itad.assetDetail.runs', 'Sanitization runs')}>
          {runs.isLoading ? (
            <Spinner className="h-5 w-5" />
          ) : (runs.data?.runs ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('itad.sanitization.noRuns', 'No runs yet')}</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {(runs.data?.runs ?? []).map((run) => (
                <li key={run.id} className="space-y-1 rounded-md border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge variant={RUN_RESULT_VARIANTS[run.result ?? 'OPEN']}>{runResultLabel(t, run.result)}</StatusBadge>
                    <span className="font-medium">{methodLabel(t, run.method)}</span>
                    <span className="text-muted-foreground">{run.tool} {run.toolVersion}</span>
                  </div>
                  <p className="text-muted-foreground">
                    {formatDateTime(run.startedAt)} · {run.operator?.name ?? unknownUser}
                    {run.verificationMethod ? ` · ${verificationLabel(t, run.verificationMethod)}` : ''}
                  </p>
                  {run.verificationNotes ? <p>{run.verificationNotes}</p> : null}
                </li>
              ))}
            </ul>
          )}
        </Section>
      ) : null}

      <Section title={t('itad.timeline.title', 'Timeline')}>
        {timeline.isLoading ? (
          <Spinner className="h-5 w-5" />
        ) : timeline.error ? (
          <Alert status="error"><AlertDescription>{t('itad.timeline.loadError', 'Could not load the timeline')}</AlertDescription></Alert>
        ) : (
          <ol className="space-y-3 border-l pl-4 text-sm">
            {(timeline.data?.items ?? []).map((item, index) => {
              const detail = timelineDetail(t, item)
              return (
                <li key={`${item.at}-${item.kind}-${index}`} className="space-y-0.5">
                  <div className="font-medium">{t(`itad.timeline.kind.${item.kind}`, KIND_LABELS[item.kind])}</div>
                  <div className="text-muted-foreground">
                    {formatDateTime(item.at)} · {item.actor ? item.actor.name ?? unknownUser : t('itad.sanitization.history.system', 'system')}
                  </div>
                  {detail ? <div>{detail}</div> : null}
                </li>
              )
            })}
          </ol>
        )}
      </Section>
    </div>
  )
}

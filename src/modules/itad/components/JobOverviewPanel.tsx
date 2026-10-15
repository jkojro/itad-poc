"use client"
import * as React from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { Alert, AlertDescription } from '@open-mercato/ui/primitives/alert'
import { Spinner } from '@open-mercato/ui/primitives/spinner'
import { StatusBadge, type StatusBadgeVariant } from '@open-mercato/ui/primitives/status-badge'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import type { AttentionSeverity, AttentionSignalKey, JobOverviewCounters, JobSeverity } from '../domain/job-overview'
import type { ItadJobListItem } from './types'

type Translate = ReturnType<typeof useT>

type OverviewResponse = {
  counters: JobOverviewCounters
  signals: Array<{ key: AttentionSignalKey; severity: AttentionSeverity; count: number; href: string }>
  severity: JobSeverity
}

/** Semantic variants only — never hard-coded colors. */
export const ATTENTION_VARIANTS: Record<AttentionSeverity, StatusBadgeVariant> = { red: 'error', orange: 'warning' }

const SIGNAL_LABELS: Record<AttentionSignalKey, string> = {
  failed: '{count} failed sanitization',
  unresolved_duplicates: '{count} duplicate scans to resolve',
  unexpected: '{count} unexpected',
  missing_exceptions: '{count} missing',
  unexpected_exceptions: '{count} unexpected',
  data_bearing_unknown: '{count} carries data: not determined',
  certificates_missing: 'Missing certificates: {count}',
}

export function attentionSignalLabel(t: Translate, key: AttentionSignalKey, count: number): string {
  return t(`itad.overview.signal.${key}`, SIGNAL_LABELS[key], { count })
}

type Tile = { key: keyof JobOverviewCounters; labelKey: string; fallback: string; query?: string }

const BLOCKS: Array<{ id: string; titleKey: string; title: string; tiles: Tile[] }> = [
  {
    id: 'receiving',
    titleKey: 'itad.overview.block.receiving',
    title: 'Receiving',
    tiles: [
      { key: 'expected', labelKey: 'itad.overview.counter.expected', fallback: 'Expected', query: 'tab=manifest' },
      { key: 'received', labelKey: 'itad.overview.counter.received', fallback: 'Received', query: 'tab=receiving&reconciliation=matched' },
      { key: 'missing', labelKey: 'itad.overview.counter.missing', fallback: 'Missing', query: 'tab=manifest&reconciliation=missing' },
      { key: 'unexpected', labelKey: 'itad.overview.counter.unexpected', fallback: 'Unexpected', query: 'tab=receiving&reconciliation=unexpected' },
      { key: 'totalIntake', labelKey: 'itad.overview.counter.totalIntake', fallback: 'Total intake', query: 'tab=receiving' },
    ],
  },
  {
    id: 'sanitization',
    titleKey: 'itad.overview.block.sanitization',
    title: 'Sanitization',
    tiles: [
      { key: 'awaitingWipe', labelKey: 'itad.overview.counter.awaitingWipe', fallback: 'Awaiting wipe', query: 'tab=sanitization' },
      { key: 'sanitized', labelKey: 'itad.overview.counter.sanitized', fallback: 'Sanitized', query: 'tab=sanitization&status=sanitized' },
      { key: 'failed', labelKey: 'itad.overview.counter.failed', fallback: 'Failed', query: 'tab=sanitization&status=review_required' },
      { key: 'dataBearingUnknown', labelKey: 'itad.overview.counter.dataBearingUnknown', fallback: 'Carries data: not determined', query: 'tab=receiving&dataBearing=unknown' },
    ],
  },
  {
    id: 'issues',
    titleKey: 'itad.overview.block.issues',
    title: 'Issues',
    tiles: [
      { key: 'openExceptions', labelKey: 'itad.overview.counter.openExceptions', fallback: 'Open exceptions', query: 'tab=exceptions' },
      { key: 'unresolvedDuplicates', labelKey: 'itad.overview.counter.unresolvedDuplicates', fallback: 'Duplicate scans to resolve', query: 'tab=exceptions&status=open&type=duplicate_serial' },
    ],
  },
  {
    id: 'closeout',
    titleKey: 'itad.overview.block.closeout',
    title: 'Closeout',
    tiles: [
      { key: 'certificatesRequired', labelKey: 'itad.overview.counter.certificatesRequired', fallback: 'Certificates required', query: 'tab=documents' },
      { key: 'certificatesIssued', labelKey: 'itad.overview.counter.certificatesIssued', fallback: 'Certificates issued', query: 'tab=documents' },
      { key: 'certificatesMissing', labelKey: 'itad.overview.counter.certificatesMissing', fallback: 'Certificates missing', query: 'tab=documents' },
    ],
  },
]

/**
 * Job Overview (operations dashboard spec Q5): what needs attention and every counter of
 * the job at the top of the Overview tab. Each signal and number links to the tab and
 * filter where it is resolved. Numbers are read live; nothing is stored.
 */
export function JobOverviewPanel({ job }: { job: ItadJobListItem }) {
  const t = useT()
  const base = `/backend/itad/jobs/${encodeURIComponent(job.id)}`
  const overview = useQuery<OverviewResponse>({
    queryKey: ['itad-job-overview', job.id, job.updatedAt],
    queryFn: async () => readApiResultOrThrow(`/api/itad/jobs/${encodeURIComponent(job.id)}/overview`),
  })
  const title = t('itad.overview.title', 'Operations overview')

  return (
    <section className="space-y-4 rounded-lg border bg-card p-4" aria-label={title} data-testid="itad-job-overview">
      <h2 className="text-sm font-semibold">{title}</h2>
      {overview.isLoading ? (
        <Spinner className="h-5 w-5" />
      ) : overview.error || !overview.data ? (
        <Alert status="error"><AlertDescription>{t('itad.overview.loadError', 'Could not load the overview')}</AlertDescription></Alert>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2" aria-live="polite" data-testid="itad-job-overview-attention">
            {overview.data.signals.length === 0 ? (
              <span className="text-sm text-muted-foreground">{t('itad.overview.noAttention', 'Nothing needs attention.')}</span>
            ) : (
              overview.data.signals.map((signal) => (
                <Link key={signal.key} href={signal.href} className="rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <StatusBadge variant={ATTENTION_VARIANTS[signal.severity]} dot>
                    {attentionSignalLabel(t, signal.key, signal.count)}
                  </StatusBadge>
                </Link>
              ))
            )}
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {BLOCKS.map((block) => (
              <div key={block.id} className="space-y-2">
                <h3 className="text-xs font-medium uppercase text-muted-foreground">{t(block.titleKey, block.title)}</h3>
                <dl className="grid grid-cols-2 gap-2 text-sm">
                  {block.tiles.map((tile) => (
                    <div key={tile.key}>
                      <dt className="text-muted-foreground">{t(tile.labelKey, tile.fallback)}</dt>
                      <dd className="text-lg font-medium" data-testid={`itad-overview-${tile.key}`}>
                        {tile.query ? (
                          <Link className="underline-offset-2 hover:underline" href={`${base}?${tile.query}`}>
                            {overview.data!.counters[tile.key]}
                          </Link>
                        ) : (
                          overview.data!.counters[tile.key]
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  )
}

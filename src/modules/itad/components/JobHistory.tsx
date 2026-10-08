"use client"
import * as React from 'react'
import { Alert, AlertDescription } from '@open-mercato/ui/primitives/alert'
import { Spinner } from '@open-mercato/ui/primitives/spinner'
import { StatusBadge } from '@open-mercato/ui/primitives/status-badge'
import { SectionHeader } from '@open-mercato/ui/backend/SectionHeader'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import type { ItadJobStatus } from '../domain/job-types'
import { ITAD_JOB_STATUS_FALLBACK_LABELS, itadJobStatusLabelKey } from './job-status'
import {
  ITAD_JOB_ACTION_FALLBACK_LABELS,
  ITAD_JOB_CONDITION_FALLBACK_LABELS,
  type ItadJobActionId,
  type ItadJobConditionId,
} from './job-lifecycle-labels'

type Actor = { id: string; name: string | null }

type HistoryItem = {
  id: string
  action: ItadJobActionId
  from: ItadJobStatus
  to: ItadJobStatus
  reason: string | null
  actor: Actor
  createdAt: string
  confirmations: Array<{ condition: ItadJobConditionId; comment: string; confirmedBy: Actor; confirmedAt: string }>
}

type ManifestChange =
  | {
      kind: 'import'
      id: string
      at: string
      actor: Actor
      jobStatus: ItadJobStatus
      duringReceiving: boolean
      fileName: string
      sheetName: string | null
      importedCount: number
      skippedCount: number
    }
  | {
      kind: 'item_deleted'
      id: string
      at: string
      actor: Actor
      jobStatus: ItadJobStatus
      duringReceiving: boolean
      serial: string
      reason: string | null
    }

type Entry = { kind: 'transition'; at: string; item: HistoryItem } | { kind: 'manifest'; at: string; change: ManifestChange }

function formatDateTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()
}

/**
 * Domain lifecycle history (spec REQ-007), newest first. With `itad.manifest.view` it
 * also interleaves manifest imports and item removals (manifest spec, "Manifest changes
 * in history"); changes made while receiving carry a "During receiving" badge. Reloads
 * when the job version or `refreshKey` changes (manifest changes do not bump the job).
 */
export function JobHistory({
  jobId,
  version,
  includeManifest = false,
  refreshKey = 0,
}: {
  jobId: string
  version: string | null
  includeManifest?: boolean
  refreshKey?: number
}) {
  const t = useT()
  const [items, setItems] = React.useState<Entry[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    setError(null)
    const errorMessage = t('itad.jobs.history.error', 'Could not load the status history')
    const base = `/api/itad/jobs/${encodeURIComponent(jobId)}`
    Promise.all([
      readApiResultOrThrow<{ items: HistoryItem[] }>(`${base}/history`, undefined, { errorMessage }),
      includeManifest
        ? readApiResultOrThrow<{ items: ManifestChange[] }>(`${base}/manifest/changes`, undefined, { errorMessage })
        : Promise.resolve({ items: [] as ManifestChange[] }),
    ])
      .then(([history, manifest]) => {
        if (cancelled) return
        const entries: Entry[] = [
          ...(history.items ?? []).map((item): Entry => ({ kind: 'transition', at: item.createdAt, item })),
          ...(manifest.items ?? []).map((change): Entry => ({ kind: 'manifest', at: change.at, change })),
        ]
        entries.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
        setItems(entries)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error && err.message ? err.message : errorMessage)
      })
    return () => { cancelled = true }
  }, [jobId, version, includeManifest, refreshKey, t])

  const status = (value: ItadJobStatus) => t(itadJobStatusLabelKey(value), ITAD_JOB_STATUS_FALLBACK_LABELS[value])
  const userName = (actor: Actor) => actor.name ?? t('itad.jobs.history.unknownUser', 'unknown user')

  return (
    <section className="space-y-3 rounded-lg border bg-card p-4" aria-label={t('itad.jobs.history.title', 'Status history')}>
      <SectionHeader title={t('itad.jobs.history.title', 'Status history')} count={items?.length} />
      {error ? (
        <Alert status="error"><AlertDescription>{error}</AlertDescription></Alert>
      ) : items === null ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="h-4 w-4" /> {t('itad.jobs.history.loading', 'Loading history…')}
        </div>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('itad.jobs.history.empty', 'No status changes yet.')}</p>
      ) : (
        <ol className="space-y-3">
          {items.map((entry) => entry.kind === 'manifest' ? (
            <li key={`manifest-${entry.change.id}`} className="space-y-1 border-l-2 border-border pl-3 text-sm">
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-medium">
                  {entry.change.kind === 'import'
                    ? t('itad.jobs.history.manifestImported', 'Manifest imported: {file}', {
                        file: entry.change.sheetName ? `${entry.change.fileName} (${entry.change.sheetName})` : entry.change.fileName,
                      })
                    : t('itad.jobs.history.manifestItemRemoved', 'Removed from manifest: {serial}', { serial: entry.change.serial })}
                </span>
                {entry.change.duringReceiving ? (
                  <StatusBadge variant="warning">{t('itad.jobs.history.duringReceiving', 'During receiving')}</StatusBadge>
                ) : null}
              </p>
              <p className="text-muted-foreground">
                {formatDateTime(entry.change.at)} · {userName(entry.change.actor)}
              </p>
              {entry.change.kind === 'import' ? (
                <p className="text-muted-foreground">
                  {t('itad.jobs.history.manifestImportedCounts', '{imported} imported, {skipped} skipped', {
                    imported: entry.change.importedCount,
                    skipped: entry.change.skippedCount,
                  })}
                </p>
              ) : entry.change.reason ? (
                <p>
                  <span className="text-muted-foreground">{t('itad.jobs.history.reason', 'Reason')}: </span>
                  {entry.change.reason}
                </p>
              ) : null}
            </li>
          ) : (() => {
            const item = entry.item
            return (
            <li key={item.id} className="space-y-1 border-l-2 border-border pl-3 text-sm">
              <p>
                <span className="font-medium">{t(`itad.jobs.actions.${item.action}`, ITAD_JOB_ACTION_FALLBACK_LABELS[item.action])}</span>
                {': '}
                {status(item.from)} → {status(item.to)}
              </p>
              <p className="text-muted-foreground">
                {formatDateTime(item.createdAt)} · {userName(item.actor)}
              </p>
              {item.reason ? (
                <p>
                  <span className="text-muted-foreground">{t('itad.jobs.history.reason', 'Reason')}: </span>
                  {item.reason}
                </p>
              ) : null}
              {item.confirmations.length > 0 ? (
                <ul className="space-y-1">
                  {item.confirmations.map((confirmation) => (
                    <li key={`${item.id}-${confirmation.condition}`} className="text-muted-foreground">
                      {t('itad.jobs.history.confirmation', '{condition} confirmed manually by {user}: "{comment}"', {
                        condition: t(`itad.jobs.conditions.${confirmation.condition}`, ITAD_JOB_CONDITION_FALLBACK_LABELS[confirmation.condition]),
                        user: userName(confirmation.confirmedBy),
                        comment: confirmation.comment,
                      })}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
            )
          })())}
        </ol>
      )}
    </section>
  )
}

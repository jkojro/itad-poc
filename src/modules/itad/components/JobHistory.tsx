"use client"
import * as React from 'react'
import { Alert, AlertDescription } from '@open-mercato/ui/primitives/alert'
import { Spinner } from '@open-mercato/ui/primitives/spinner'
import { SectionHeader } from '@open-mercato/ui/backend/SectionHeader'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import type { ItadJobStatus } from '../data/entities'
import { ITAD_JOB_STATUS_FALLBACK_LABELS, itadJobStatusLabelKey } from './jobStatus'
import {
  ITAD_JOB_ACTION_FALLBACK_LABELS,
  ITAD_JOB_CONDITION_FALLBACK_LABELS,
  type ItadJobActionId,
  type ItadJobConditionId,
} from './jobLifecycleLabels'

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

function formatDateTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()
}

/** Domain lifecycle history (spec REQ-007), newest first; reloads when the job version changes. */
export function JobHistory({ jobId, version }: { jobId: string; version: string | null }) {
  const t = useT()
  const [items, setItems] = React.useState<HistoryItem[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    setError(null)
    readApiResultOrThrow<{ items: HistoryItem[] }>(`/api/itad/jobs/${encodeURIComponent(jobId)}/history`, undefined, {
      errorMessage: t('itad.jobs.history.error', 'Could not load the status history'),
    })
      .then((result) => { if (!cancelled) setItems(result.items ?? []) })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error && err.message ? err.message : t('itad.jobs.history.error', 'Could not load the status history'))
      })
    return () => { cancelled = true }
  }, [jobId, version, t])

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
          {items.map((item) => (
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
          ))}
        </ol>
      )}
    </section>
  )
}

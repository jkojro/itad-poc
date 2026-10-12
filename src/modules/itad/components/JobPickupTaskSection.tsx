"use client"
import * as React from 'react'
import Link from 'next/link'
import { Button } from '@open-mercato/ui/primitives/button'
import { Alert, AlertDescription, AlertTitle } from '@open-mercato/ui/primitives/alert'
import { StatusBadge, type StatusMap } from '@open-mercato/ui/primitives/status-badge'
import { Spinner } from '@open-mercato/ui/primitives/spinner'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import type { ItadJobListItem } from './types'
import { useGrantedFeatures } from './use-granted-features'

type PickupTaskState = NonNullable<ItadJobListItem['pickupTask']>['state']

const STATE_VARIANTS: StatusMap<PickupTaskState> = {
  creating: 'warning',
  planned: 'info',
  completed: 'success',
  cancelled: 'neutral',
  lost: 'error',
}

const STATE_FALLBACK_LABELS: Record<PickupTaskState, string> = {
  creating: 'Being created',
  planned: 'Planned',
  completed: 'Completed',
  cancelled: 'Cancelled',
  lost: 'Missing',
}

const MANAGE_FEATURES = ['itad.jobs.manage'] as const

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
}

/**
 * "Pickup task" section of the job status panel (pickup calendar spec "UI/UX"): the
 * calendar task the job projects, and a Retry action when the last sync failed.
 */
export function JobPickupTaskSection({ job, onChanged }: { job: ItadJobListItem; onChanged: () => void }) {
  const t = useT()
  const { granted } = useGrantedFeatures(MANAGE_FEATURES)
  const [retrying, setRetrying] = React.useState(false)
  const task = job.pickupTask ?? null
  const earlier = Math.max((job.pickupTaskHistoryCount ?? 0) - 1, 0)

  const retry = React.useCallback(async () => {
    if (retrying) return
    setRetrying(true)
    try {
      const call = await apiCall<{ ok?: boolean; error?: string }>(
        `/api/itad/jobs/${encodeURIComponent(job.id)}/pickup-task/sync`,
        { method: 'POST' },
      )
      if (call.ok && call.result?.ok) {
        flash(t('itad.pickupTask.retry.success', 'Calendar sync completed'), 'success')
      } else {
        const message = typeof call.result?.error === 'string' && call.result.error
          ? call.result.error
          : t('itad.pickupTask.retry.error', 'Calendar sync failed again')
        flash(message, 'error')
      }
      onChanged()
    } finally {
      setRetrying(false)
    }
  }, [job.id, onChanged, retrying, t])

  return (
    <div className="space-y-2 border-t pt-4" data-testid="itad-pickup-task">
      <h3 className="text-sm font-semibold">{t('itad.pickupTask.section.title', 'Pickup task')}</h3>
      {task ? (
        <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">{t('itad.pickupTask.section.state', 'Calendar status')}</dt>
            <dd>
              <StatusBadge variant={STATE_VARIANTS[task.state]} dot>
                {t(`itad.pickupTask.state.${task.state}`, STATE_FALLBACK_LABELS[task.state])}
              </StatusBadge>
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t('itad.pickupTask.section.date', 'Pickup')}</dt>
            <dd>{formatDateTime(task.scheduledAt)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t('itad.pickupTask.section.coordinator', 'Coordinator')}</dt>
            <dd>{job.pickupCoordinator?.name ?? t('itad.pickupTask.section.noCoordinator', 'Not assigned')}</dd>
          </div>
          <div className="flex items-end">
            <Link className="text-sm underline underline-offset-2" href="/backend/calendar">
              {t('itad.pickupTask.section.openCalendar', 'Open calendar')}
            </Link>
          </div>
        </dl>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t('itad.pickupTask.section.none', 'A pickup task is created in the calendar when the job is scheduled.')}
        </p>
      )}
      {earlier > 0 ? (
        <p className="text-xs text-muted-foreground">
          {t('itad.pickupTask.section.history', 'Earlier pickup tasks: {count}', { count: earlier })}
        </p>
      ) : null}
      {task?.lastError ? (
        <Alert status="warning">
          <AlertTitle>{t('itad.pickupTask.section.failed', 'Calendar sync failed')}</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>{task.lastError}</p>
            {granted.has('itad.jobs.manage') ? (
              <Button type="button" size="sm" variant="outline" onClick={() => void retry()} disabled={retrying}>
                {retrying ? <Spinner className="mr-2 h-4 w-4" /> : null}
                {t('itad.pickupTask.retry.action', 'Retry calendar sync')}
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  )
}

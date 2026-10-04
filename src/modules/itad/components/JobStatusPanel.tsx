"use client"
import * as React from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Alert, AlertDescription, AlertTitle } from '@open-mercato/ui/primitives/alert'
import { Checkbox } from '@open-mercato/ui/primitives/checkbox'
import { Label } from '@open-mercato/ui/primitives/label'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { FormField } from '@open-mercato/ui/primitives/form-field'
import { StatusBadge } from '@open-mercato/ui/primitives/status-badge'
import { Spinner } from '@open-mercato/ui/primitives/spinner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@open-mercato/ui/primitives/dialog'
import { SectionHeader } from '@open-mercato/ui/backend/SectionHeader'
import { apiCall, readApiResultOrThrow, withScopedApiRequestHeaders } from '@open-mercato/ui/backend/utils/apiCall'
import { buildOptimisticLockHeader } from '@open-mercato/ui/backend/utils/optimisticLock'
import { surfaceRecordConflict } from '@open-mercato/ui/backend/conflicts'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import type { ItadJobStatus } from '../data/entities'
import {
  ITAD_JOB_STATUS_FALLBACK_LABELS,
  ITAD_JOB_STATUS_VARIANTS,
  itadJobStatusLabelKey,
} from './jobStatus'
import {
  ITAD_JOB_ACTION_FALLBACK_LABELS,
  ITAD_JOB_CONDITION_FALLBACK_LABELS,
  type ItadJobActionId,
  type ItadJobConditionId,
} from './jobLifecycleLabels'
import type { ItadJobListItem } from './types'

type ConditionView = {
  key: ItadJobConditionId
  state: 'met' | 'unmet' | 'confirmation_required'
  manualAllowed: boolean
  canConfirm: boolean
  detailKey: string | null
}

type ActionView = {
  id: ItadJobActionId
  to: ItadJobStatus
  reasonRequired: boolean
  allowed: boolean
  conditions: ConditionView[]
}

type TransitionsResponse = {
  status: ItadJobStatus
  updatedAt: string
  canTransition: boolean
  canConfirm: boolean
  actions: ActionView[]
}

type Translate = ReturnType<typeof useT>

const DESTRUCTIVE_ACTIONS: readonly ItadJobActionId[] = ['cancel']

function statusLabel(t: Translate, status: ItadJobStatus): string {
  return t(itadJobStatusLabelKey(status), ITAD_JOB_STATUS_FALLBACK_LABELS[status])
}

function actionLabel(t: Translate, action: ItadJobActionId): string {
  return t(`itad.jobs.actions.${action}`, ITAD_JOB_ACTION_FALLBACK_LABELS[action])
}

function conditionLabel(t: Translate, condition: ItadJobConditionId): string {
  return t(`itad.jobs.conditions.${condition}`, ITAD_JOB_CONDITION_FALLBACK_LABELS[condition])
}

function formatDateTime(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()
}

/** Why an action cannot run for this user, or `null` when it can. */
function blockedReason(t: Translate, action: ActionView, canTransition: boolean): string | null {
  if (!canTransition) return t('itad.jobs.transition.blocked.noPermission', 'You are not allowed to change the status')
  if (action.allowed) return null
  const needsSupervisor = action.conditions.some((condition) => condition.state === 'confirmation_required' && !condition.canConfirm)
  if (needsSupervisor) return t('itad.jobs.transition.blocked.needsConfirmation', 'Requires a supervisor confirmation')
  return t('itad.jobs.transition.blocked.unmet', 'Required conditions are not met')
}

type DialogState = {
  action: ActionView
  reason: string
  confirm: Partial<Record<ItadJobConditionId, { checked: boolean; comment: string }>>
  error: string | null
  submitting: boolean
}

export function JobStatusPanel({ job, onChanged }: { job: ItadJobListItem; onChanged: () => void }) {
  const t = useT()
  const [data, setData] = React.useState<TransitionsResponse | null>(null)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [dialog, setDialog] = React.useState<DialogState | null>(null)

  React.useEffect(() => {
    let cancelled = false
    setLoadError(null)
    readApiResultOrThrow<TransitionsResponse>(`/api/itad/jobs/${encodeURIComponent(job.id)}/transitions`, undefined, {
      errorMessage: t('itad.jobs.transition.error.load', 'Could not load status actions'),
    })
      .then((result) => { if (!cancelled) setData(result) })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error && err.message ? err.message : t('itad.jobs.transition.error.load', 'Could not load status actions'))
      })
    return () => { cancelled = true }
  }, [job.id, job.updatedAt, t])

  const openDialog = (action: ActionView) =>
    setDialog({ action, reason: '', confirm: {}, error: null, submitting: false })

  const submit = React.useCallback(async () => {
    if (!dialog || dialog.submitting) return
    const confirmations = dialog.action.conditions
      .filter((condition) => condition.state === 'confirmation_required' && dialog.confirm[condition.key]?.checked)
      .map((condition) => ({ condition: condition.key, comment: dialog.confirm[condition.key]?.comment ?? '' }))
    setDialog({ ...dialog, submitting: true, error: null })
    const call = await withScopedApiRequestHeaders(buildOptimisticLockHeader(job.updatedAt), () =>
      apiCall<{ error?: string; code?: string }>(`/api/itad/jobs/${encodeURIComponent(job.id)}/transitions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: dialog.action.id,
          ...(dialog.action.reasonRequired ? { reason: dialog.reason } : {}),
          ...(confirmations.length ? { confirmations } : {}),
        }),
      }),
    )
    if (call.ok) {
      setDialog(null)
      flash(t('itad.jobs.transition.flash.done', 'Status changed to {status}', { status: statusLabel(t, dialog.action.to) }), 'success')
      onChanged()
      return
    }
    if (call.status === 409 && surfaceRecordConflict({ status: call.status, body: call.result }, t)) {
      setDialog(null)
      onChanged()
      return
    }
    const message = typeof call.result?.error === 'string' && call.result.error
      ? call.result.error
      : t('itad.jobs.transition.error.submit', 'Could not change the status')
    setDialog((current) => (current ? { ...current, submitting: false, error: message } : current))
  }, [dialog, job.id, job.updatedAt, onChanged, t])

  const onDialogKeyDown = (event: React.KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      void submit()
    }
  }

  const canSubmit = (() => {
    if (!dialog) return false
    if (dialog.action.reasonRequired && dialog.reason.trim().length < 3) return false
    return dialog.action.conditions.every((condition) => {
      if (condition.state === 'met') return true
      if (condition.state !== 'confirmation_required' || !condition.canConfirm) return false
      const entry = dialog.confirm[condition.key]
      return Boolean(entry?.checked && entry.comment.trim().length >= 3)
    })
  })()

  return (
    <section className="space-y-4 rounded-lg border bg-card p-4" aria-label={t('itad.jobs.transition.title', 'Status')}>
      <SectionHeader title={t('itad.jobs.transition.title', 'Status')} />
      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge variant={ITAD_JOB_STATUS_VARIANTS[job.status] ?? 'neutral'} dot>
          {statusLabel(t, job.status)}
        </StatusBadge>
      </div>

      {job.status === 'on_hold' ? (
        <Alert status="warning">
          <AlertTitle>{t('itad.jobs.hold.title', 'On hold')}</AlertTitle>
          <AlertDescription>
            {t('itad.jobs.hold.description', 'Since {date} by {user} — "{reason}". Was: {status}.', {
              date: formatDateTime(job.heldAt),
              user: job.heldBy?.name ?? t('itad.jobs.history.unknownUser', 'unknown user'),
              reason: job.holdReason ?? '',
              status: job.statusBeforeHold ? statusLabel(t, job.statusBeforeHold) : '—',
            })}
          </AlertDescription>
        </Alert>
      ) : null}

      {loadError ? (
        <Alert status="error"><AlertDescription>{loadError}</AlertDescription></Alert>
      ) : !data ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="h-4 w-4" /> {t('itad.jobs.transition.loading', 'Loading status actions…')}
        </div>
      ) : data.actions.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('itad.jobs.transition.none', 'No further status changes are possible.')}</p>
      ) : (
        <ul className="flex flex-wrap gap-3" aria-label={t('itad.jobs.transition.actions', 'Status actions')}>
          {data.actions.map((action) => {
            const blocked = blockedReason(t, action, data.canTransition)
            return (
              <li key={action.id} className="flex flex-col gap-1">
                <Button
                  type="button"
                  variant={DESTRUCTIVE_ACTIONS.includes(action.id) ? 'destructive' : 'outline'}
                  disabled={Boolean(blocked)}
                  onClick={() => openDialog(action)}
                  aria-describedby={blocked ? `itad-action-${action.id}-blocked` : undefined}
                >
                  {actionLabel(t, action.id)}
                </Button>
                {blocked ? (
                  <span id={`itad-action-${action.id}-blocked`} className="text-xs text-muted-foreground">{blocked}</span>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}

      <Dialog open={dialog !== null} onOpenChange={(open) => { if (!open) setDialog(null) }}>
        <DialogContent onKeyDown={onDialogKeyDown}>
          {dialog ? (
            <>
              <DialogHeader>
                <DialogTitle>{actionLabel(t, dialog.action.id)}</DialogTitle>
                <DialogDescription>
                  {t('itad.jobs.transition.dialog.description', '{from} → {to}', {
                    from: statusLabel(t, job.status),
                    to: statusLabel(t, dialog.action.to),
                  })}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-2">
                {dialog.action.conditions.length > 0 ? (
                  <fieldset className="space-y-3">
                    <legend className="text-sm font-medium">{t('itad.jobs.transition.dialog.conditions', 'Conditions')}</legend>
                    {dialog.action.conditions.map((condition) => {
                      const entry = dialog.confirm[condition.key] ?? { checked: false, comment: '' }
                      const stateLabel = condition.state === 'met'
                        ? t('itad.jobs.conditions.state.met', 'Met')
                        : condition.state === 'unmet'
                          ? t(condition.detailKey ?? 'itad.jobs.conditions.state.unmet', 'Not met')
                          : t('itad.jobs.conditions.state.confirmation_required', 'Requires confirmation')
                      return (
                        <div key={condition.key} className="space-y-2 rounded-md border p-3">
                          <p className="text-sm">
                            <span className="font-medium">{conditionLabel(t, condition.key)}</span>
                            {' — '}
                            <span className="text-muted-foreground">{stateLabel}</span>
                          </p>
                          {condition.state === 'confirmation_required' && condition.canConfirm ? (
                            <>
                              <div className="flex items-center gap-2">
                                <Checkbox
                                  id={`itad-confirm-${condition.key}`}
                                  checked={entry.checked}
                                  onCheckedChange={(checked) =>
                                    setDialog({ ...dialog, confirm: { ...dialog.confirm, [condition.key]: { ...entry, checked: checked === true } } })
                                  }
                                />
                                <Label htmlFor={`itad-confirm-${condition.key}`}>
                                  {t('itad.jobs.transition.dialog.confirmManually', 'Confirm manually')}
                                </Label>
                              </div>
                              {entry.checked ? (
                                <FormField
                                  label={t('itad.jobs.transition.dialog.comment', 'Confirmation comment')}
                                  required
                                  description={t('itad.jobs.transition.dialog.commentHint', 'Stored in the job history with your name. Avoid personal data.')}
                                >
                                  <Textarea
                                    value={entry.comment}
                                    maxLength={1000}
                                    onChange={(event) =>
                                      setDialog({ ...dialog, confirm: { ...dialog.confirm, [condition.key]: { ...entry, comment: event.target.value } } })
                                    }
                                  />
                                </FormField>
                              ) : null}
                            </>
                          ) : null}
                        </div>
                      )
                    })}
                  </fieldset>
                ) : null}
                {dialog.action.reasonRequired ? (
                  <FormField
                    label={t('itad.jobs.transition.dialog.reason', 'Reason')}
                    required
                    description={t('itad.jobs.transition.dialog.reasonHint', '3–1000 characters, stored in the job history.')}
                  >
                    <Textarea
                      value={dialog.reason}
                      maxLength={1000}
                      autoFocus
                      onChange={(event) => setDialog({ ...dialog, reason: event.target.value })}
                    />
                  </FormField>
                ) : null}
                {dialog.error ? (
                  <Alert status="error"><AlertDescription>{dialog.error}</AlertDescription></Alert>
                ) : null}
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setDialog(null)} disabled={dialog.submitting}>
                  {t('itad.jobs.transition.dialog.cancel', 'Cancel')}
                </Button>
                <Button
                  type="button"
                  variant={DESTRUCTIVE_ACTIONS.includes(dialog.action.id) ? 'destructive' : 'default'}
                  onClick={() => void submit()}
                  disabled={!canSubmit || dialog.submitting}
                >
                  {dialog.submitting ? <Spinner className="mr-2 h-4 w-4" /> : null}
                  {t('itad.jobs.transition.dialog.submit', 'Confirm')}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </section>
  )
}

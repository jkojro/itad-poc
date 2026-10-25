"use client"
import * as React from 'react'
import Link from 'next/link'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@open-mercato/ui/primitives/button'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { Input } from '@open-mercato/ui/primitives/input'
import { FormField } from '@open-mercato/ui/primitives/form-field'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@open-mercato/ui/primitives/select'
import { Alert, AlertDescription } from '@open-mercato/ui/primitives/alert'
import { Spinner } from '@open-mercato/ui/primitives/spinner'
import { StatusBadge } from '@open-mercato/ui/primitives/status-badge'
import { SectionHeader } from '@open-mercato/ui/backend/SectionHeader'
import { apiCall, readApiResultOrThrow, withScopedApiRequestHeaders } from '@open-mercato/ui/backend/utils/apiCall'
import { buildOptimisticLockHeader } from '@open-mercato/ui/backend/utils/optimisticLock'
import { surfaceRecordConflict } from '@open-mercato/ui/backend/conflicts'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import type { FieldSource, InboxActionStatus, InboxActionType, InboxIntent, InboxMessageStatus, MatchStatus } from '../domain/inbox'
import {
  ACTION_STATUS_LABELS,
  ACTION_TYPE_LABELS,
  FIELD_LABELS,
  INTENT_LABELS,
  isHidden,
  type Hidden,
} from './inbox-ui'
import { MatchStatusBadge, MessageStatusBadge } from './InboxTable'
import { useGrantedFeatures } from './use-granted-features'

/**
 * One customer email and its ITAD proposal (spec "UI/UX"): the operator edits the fields
 * of each action, accepts or rejects it, and chooses the match when it is ambiguous —
 * the only way to change an action's target. Details from ITAD records the reader may
 * not see arrive as `{ hidden: true }` and are shown as "No access".
 */

type JobView = { id: string; reference: string; name: string; status: string; scheduledPickupAt: string | null; customerReference: string | null }
type Evidence = { kind: string; source: string; value?: string; hidden?: true }

type MessageDetail = {
  id: string
  source: 'email' | 'manual'
  status: InboxMessageStatus
  stalled: boolean
  generation: number
  receivedAt: string
  from: { address: string; name: string | null }
  customerSender: { address: string; name: string | null }
  forwardedByOrganizationUser: boolean
  subject: string
  currentText: string
  threadMessages: Array<{ from: string | null; date: string | null; body: string; isForwarded?: boolean }>
  intents: InboxIntent[]
  summary: string | null
  matchStatus: MatchStatus | null
  match: {
    customer: { id: string; name: string | null } | Hidden | null
    job: JobView | Hidden | null
    jobCandidates: Array<{ job: JobView | Hidden | null; evidence: Evidence[] }>
    customerCandidates: Array<{ customer: { id: string; name: string | null } | Hidden | null; evidence: Evidence[] }>
  } | null
  draftReply: string | null
  draftHidden: boolean
  draftGeneratedAt: string | null
  processingError: { code: string; message: string } | null
  actions: Array<{
    id: string
    type: InboxActionType
    status: InboxActionStatus
    matchStatus: MatchStatus
    target: {
      customer: { id: string; name: string | null } | Hidden | null
      job: JobView | Hidden | null
      exception: { id: string; type: string; status: string; serial: string } | (Hidden & { kind: string }) | null
    }
    payload: Record<string, unknown>
    fieldSources: Record<string, FieldSource>
    missingFields: string[]
    before: { scheduledPickupAt: string | null } | null
    allowedOutcomes: string[] | null
    result: { recordId?: string; commandId?: string; error?: { code: string; message: string } } | null
    rejectReason: string | null
    updatedAt: string
  }>
  updatedAt: string
}

const EVIDENCE_LABELS: Record<string, string> = {
  job_reference: 'job reference',
  customer_reference: 'customer reference',
  sender_email: 'sender is a contact of the customer',
  serial: 'serial',
}

const SOURCE_LABELS: Record<string, string> = {
  current: 'in the message',
  subject: 'in the subject',
  history: 'only in the quoted history',
  sender: 'sender',
  forwarded_sender: 'forwarded sender (not verified)',
}

function NoAccess() {
  const t = useT()
  return <span className="text-muted-foreground">{t('itad.inbox.hidden', 'No access')}</span>
}

function JobLink({ job }: { job: JobView | Hidden | null }) {
  const t = useT()
  if (!job) return <span className="text-muted-foreground">{t('itad.inbox.match.none', 'Not matched')}</span>
  if (isHidden(job)) return <NoAccess />
  return (
    <Link className="underline" href={`/backend/itad/jobs/${job.id}`}>
      {job.reference}
    </Link>
  )
}

function EvidenceList({ evidence }: { evidence: Evidence[] }) {
  const t = useT()
  return (
    <ul className="text-xs text-muted-foreground">
      {evidence.map((item, index) => (
        <li key={index}>
          {t(`itad.inbox.evidence.${item.kind}`, EVIDENCE_LABELS[item.kind] ?? item.kind)}
          {item.value && !item.hidden ? ` ${item.value}` : ''} — {t(`itad.inbox.source.${item.source}`, SOURCE_LABELS[item.source] ?? item.source)}
        </li>
      ))}
    </ul>
  )
}

const OUTCOME_LABELS: Record<string, string> = {
  not_shipped: 'Not shipped',
  lost_in_transit: 'Lost in transit',
  manifest_error: 'Manifest error',
  accepted_into_job: 'Accepted into the job',
}

const browserTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return undefined
  }
}

type ActionView = MessageDetail['actions'][number]

/** POST/PUT on an action with its version as the lock; returns the error message or null. */
async function actionRequest(t: ReturnType<typeof useT>, action: ActionView, path: string, method: 'POST' | 'PUT', body: unknown): Promise<string | null> {
  try {
    const call = await withScopedApiRequestHeaders(buildOptimisticLockHeader(action.updatedAt), () =>
      apiCall<{ error?: string; status?: string; error_?: unknown } & Record<string, unknown>>(path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
    if (call.ok) return null
    const result = call.result as { error?: unknown } | null
    const error = result?.error
    if (typeof error === 'string') return error
    if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') return (error as { message: string }).message
    return t('itad.inbox.errors.generic', 'Could not complete the action')
  } catch (err) {
    if (surfaceRecordConflict(err, t)) return t('itad.inbox.errors.changed', 'This changed in the meantime; the latest version is shown')
    return t('itad.inbox.errors.generic', 'Could not complete the action')
  }
}

function ActionFieldsForm({ action, onDone, onCancel }: { action: ActionView; onDone: () => void; onCancel: () => void }) {
  const t = useT()
  const [values, setValues] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(action.payload).map(([key, value]) => [key, value === null || value === undefined ? '' : String(value)])),
  )
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const set = (key: string, value: string) => setValues((current) => ({ ...current, [key]: value }))
  const fields: Array<{ key: string; kind: 'text' | 'number' | 'datetime' | 'textarea' | 'outcome' }> =
    action.type === 'update_pickup'
      ? [{ key: 'scheduledPickupAt', kind: 'datetime' }, { key: 'timeZone', kind: 'text' }]
      : action.type === 'resolve_exception'
        ? [{ key: 'outcome', kind: 'outcome' }, { key: 'reason', kind: 'textarea' }]
        : [
            { key: 'name', kind: 'text' },
            { key: 'customerReference', kind: 'text' },
            { key: 'expectedAssetEstimate', kind: 'number' },
            { key: 'scheduledPickupAt', kind: 'datetime' },
            { key: 'timeZone', kind: 'text' },
            { key: 'pickupLocation', kind: 'text' },
          ]

  const save = async () => {
    setSaving(true)
    setError(null)
    const payload: Record<string, unknown> = {}
    for (const field of fields) {
      const raw = (values[field.key] ?? '').trim()
      payload[field.key] = raw === '' ? null : field.kind === 'number' ? Number(raw) : raw
    }
    const failure = await actionRequest(t, action, `/api/itad/inbox/actions/${action.id}`, 'PUT', { payload })
    setSaving(false)
    if (failure) setError(failure)
    else onDone()
  }

  return (
    <div className="mt-3 space-y-3 rounded-md border bg-muted/20 p-3" data-testid="itad-inbox-action-form">
      {fields.map((field) => {
        const label = t(`itad.inbox.field.${field.key}`, FIELD_LABELS[field.key] ?? field.key)
        if (field.kind === 'outcome') {
          const options = action.allowedOutcomes ?? Object.keys(OUTCOME_LABELS)
          return (
            <FormField key={field.key} label={label}>
              <Select value={values.outcome || undefined} onValueChange={(value) => set('outcome', value)}>
                <SelectTrigger aria-label={label}>
                  <SelectValue placeholder={t('itad.inbox.field.choose', 'Choose')} />
                </SelectTrigger>
                <SelectContent>
                  {options.map((outcome) => (
                    <SelectItem key={outcome} value={outcome}>
                      {t(`itad.exceptions.outcome.${outcome}`, OUTCOME_LABELS[outcome] ?? outcome)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          )
        }
        if (field.kind === 'textarea') {
          return (
            <FormField key={field.key} label={label}>
              <Textarea rows={3} value={values[field.key] ?? ''} onChange={(event) => set(field.key, event.target.value)} />
            </FormField>
          )
        }
        return (
          <FormField key={field.key} label={label}>
            <Input
              type={field.kind === 'number' ? 'number' : field.kind === 'datetime' ? 'datetime-local' : 'text'}
              value={values[field.key] ?? ''}
              placeholder={field.key === 'timeZone' ? browserTimeZone() : undefined}
              onChange={(event) => set(field.key, event.target.value)}
            />
          </FormField>
        )
      })}
      {error ? (
        <Alert status="error"><AlertDescription>{error}</AlertDescription></Alert>
      ) : null}
      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={() => void save()} disabled={saving}>
          {saving ? <Spinner className="mr-2 h-4 w-4" /> : null}
          {t('itad.inbox.action.save', 'Save')}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel} disabled={saving}>
          {t('itad.sanitization.actions.cancel', 'Cancel')}
        </Button>
      </div>
    </div>
  )
}

function ActionCard({ action, canManage, onChanged }: { action: ActionView; canManage: boolean; onChanged: () => void }) {
  const t = useT()
  const fields = Object.entries(action.payload)
  const [mode, setMode] = React.useState<'view' | 'edit' | 'reject'>('view')
  const [reason, setReason] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const pending = action.status === 'pending'
  const targetIncomplete =
    (action.type === 'create_job' && !action.target.customer) ||
    (action.type !== 'create_job' && !action.target.job) ||
    (action.type === 'resolve_exception' && !action.target.exception)
  const acceptBlocked = action.missingFields.length > 0 || targetIncomplete

  const run = async (path: string, body: unknown) => {
    setBusy(true)
    setError(null)
    const failure = await actionRequest(t, action, path, 'POST', body)
    setBusy(false)
    if (failure) setError(failure)
    setMode('view')
    onChanged()
  }

  const title = t(`itad.inbox.action.${action.type}`, ACTION_TYPE_LABELS[action.type])
  return (
    <section className="rounded-lg border p-4" aria-label={title} data-testid="itad-inbox-action">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        <MatchStatusBadge status={action.matchStatus} />
        <StatusBadge variant={action.status === 'executed' ? 'success' : action.status === 'failed' ? 'error' : 'neutral'}>
          {t(`itad.inbox.actionStatus.${action.status}`, ACTION_STATUS_LABELS[action.status])}
        </StatusBadge>
      </div>
      <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
        {action.type === 'create_job' ? (
          <>
            <dt className="text-muted-foreground">{t('itad.inbox.target.customer', 'Customer')}</dt>
            <dd className="sm:col-span-2">
              {action.target.customer ? (isHidden(action.target.customer) ? <NoAccess /> : action.target.customer.name ?? action.target.customer.id) : <span className="text-muted-foreground">{t('itad.inbox.target.chooseCustomer', 'To choose')}</span>}
            </dd>
          </>
        ) : (
          <>
            <dt className="text-muted-foreground">{t('itad.inbox.target.job', 'Job')}</dt>
            <dd className="sm:col-span-2"><JobLink job={action.target.job} /></dd>
          </>
        )}
        {action.type === 'resolve_exception' ? (
          <>
            <dt className="text-muted-foreground">{t('itad.inbox.target.exception', 'Exception')}</dt>
            <dd className="sm:col-span-2">
              {!action.target.exception ? (
                <span className="text-muted-foreground">{t('itad.inbox.target.chooseException', 'To choose')}</span>
              ) : isHidden(action.target.exception) ? (
                <NoAccess />
              ) : (
                `${action.target.exception.serial} · ${t(`itad.exceptions.type.${action.target.exception.type}`, action.target.exception.type)}`
              )}
            </dd>
          </>
        ) : null}
        {action.before ? (
          <>
            <dt className="text-muted-foreground">{t('itad.inbox.before.pickup', 'Current pickup')}</dt>
            <dd className="sm:col-span-2">{action.before.scheduledPickupAt ? new Date(action.before.scheduledPickupAt).toLocaleString() : '—'}</dd>
          </>
        ) : null}
        {fields.map(([key, value]) => (
          <React.Fragment key={key}>
            <dt className="text-muted-foreground">{t(`itad.inbox.field.${key}`, FIELD_LABELS[key] ?? key)}</dt>
            <dd className="sm:col-span-2">
              {key === 'outcome' ? t(`itad.exceptions.outcome.${String(value)}`, OUTCOME_LABELS[String(value)] ?? String(value)) : String(value)}
              {action.fieldSources[key] === 'operator' ? <span className="ml-2 text-xs text-muted-foreground">{t('itad.inbox.field.byOperator', '(edited)')}</span> : null}
            </dd>
          </React.Fragment>
        ))}
      </dl>
      {pending && action.missingFields.length ? (
        <p className="mt-2 text-sm text-status-warning-text">
          {t('itad.inbox.missing', 'Missing: {fields}', {
            fields: action.missingFields.map((key) => t(`itad.inbox.field.${key}`, FIELD_LABELS[key] ?? key)).join(', '),
          })}
        </p>
      ) : null}
      {action.status === 'executed' && action.type === 'create_job' && action.result?.recordId ? (
        <p className="mt-2 text-sm">
          {t('itad.inbox.jobCreated', 'Job created:')}{' '}
          <Link className="underline" href={`/backend/itad/jobs/${action.result.recordId}`}>
            {t('itad.inbox.openJob', 'open the job')}
          </Link>
        </p>
      ) : null}
      {action.status === 'executed' && action.target.job && !isHidden(action.target.job) ? (
        <p className="mt-2 text-sm">
          {t('itad.inbox.executed', 'Done in')} <JobLink job={action.target.job} />
        </p>
      ) : null}
      {action.status === 'failed' && action.result?.error ? (
        <Alert status="error" className="mt-2"><AlertDescription>{action.result.error.message}</AlertDescription></Alert>
      ) : null}
      {action.status === 'rejected' && action.rejectReason ? (
        <p className="mt-2 text-sm text-muted-foreground">{t('itad.inbox.rejectedBecause', 'Rejected: {reason}', { reason: action.rejectReason })}</p>
      ) : null}
      {error ? (
        <Alert status="error" className="mt-2"><AlertDescription>{error}</AlertDescription></Alert>
      ) : null}

      {pending && canManage && mode === 'edit' ? (
        <ActionFieldsForm action={action} onCancel={() => setMode('view')} onDone={() => { setMode('view'); onChanged() }} />
      ) : null}
      {pending && canManage && mode === 'reject' ? (
        <div className="mt-3 space-y-2 rounded-md border bg-muted/20 p-3">
          <FormField label={t('itad.inbox.rejectReason', 'Reason (optional)')}>
            <Textarea rows={2} value={reason} onChange={(event) => setReason(event.target.value)} />
          </FormField>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="destructive" onClick={() => void run(`/api/itad/inbox/actions/${action.id}/reject`, { reason: reason.trim() || null })} disabled={busy}>
              {t('itad.inbox.rejectConfirm', 'Reject action')}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setMode('view')} disabled={busy}>
              {t('itad.sanitization.actions.cancel', 'Cancel')}
            </Button>
          </div>
        </div>
      ) : null}
      {pending && canManage && mode === 'view' ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            onClick={() => void run(`/api/itad/inbox/actions/${action.id}/accept`, { timeZone: browserTimeZone() })}
            disabled={busy || acceptBlocked}
            data-testid="itad-inbox-accept"
          >
            {busy ? <Spinner className="mr-2 h-4 w-4" /> : null}
            {t('itad.inbox.accept', 'Accept')}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setMode('edit')} disabled={busy} data-testid="itad-inbox-edit">
            {t('itad.inbox.edit', 'Edit')}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setMode('reject')} disabled={busy} data-testid="itad-inbox-reject">
            {t('itad.inbox.reject', 'Reject')}
          </Button>
          {targetIncomplete ? (
            <span className="text-xs text-muted-foreground">
              {action.type === 'create_job'
                ? t('itad.inbox.chooseCustomer', 'Choose the customer in Match first.')
                : t('itad.inbox.chooseTarget', 'Choose the job or exception in Match first.')}
            </span>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

type ExceptionOption = { id: string; serial: string; type: string; status: string }

/**
 * Match panel (spec "Target vs fields"): the job — among the candidates or by reference —
 * and, per pending I3 action, the exception. Saving rebuilds the pending actions.
 */
function MatchEditor({ data, onDone, onCancel }: { data: MessageDetail; onDone: () => void; onCancel: () => void }) {
  const t = useT()
  const currentJob = data.match?.job && !isHidden(data.match.job) ? data.match.job : null
  const [jobId, setJobId] = React.useState<string>(currentJob?.id ?? '')
  const needsCustomer = data.actions.some((action) => action.type === 'create_job' && action.status === 'pending')
  const needsJob = data.actions.some((action) => action.type !== 'create_job' && action.status === 'pending')
  const currentCustomer = data.match?.customer && !isHidden(data.match.customer) ? data.match.customer : null
  const [customerId, setCustomerId] = React.useState<string>(currentCustomer?.id ?? '')
  const [customerSearch, setCustomerSearch] = React.useState('')
  const customers = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ['itad-inbox-customer-search', customerSearch],
    enabled: needsCustomer && customerSearch.trim().length >= 2,
    queryFn: async () => {
      const result = await readApiResultOrThrow<{ items?: Array<{ id?: unknown; display_name?: unknown }> }>(
        `/api/customers/companies?search=${encodeURIComponent(customerSearch.trim())}&pageSize=20`,
      )
      return (result.items ?? []).flatMap((item) =>
        typeof item.id === 'string' && typeof item.display_name === 'string' ? [{ id: item.id, name: item.display_name }] : [],
      )
    },
  })
  const customerOptions = [
    ...(currentCustomer ? [{ id: currentCustomer.id, name: currentCustomer.name ?? currentCustomer.id }] : []),
    ...(customers.data ?? []).filter((customer) => customer.id !== currentCustomer?.id),
  ]
  const [search, setSearch] = React.useState('')
  const [exceptions, setExceptions] = React.useState<Record<string, string>>({})
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const candidates = (data.match?.jobCandidates ?? []).flatMap((candidate) => (candidate.job && !isHidden(candidate.job) ? [candidate.job] : []))
  const found = useQuery<JobView[]>({
    queryKey: ['itad-inbox-job-search', search],
    enabled: search.trim().length >= 3,
    queryFn: async () => {
      const result = await readApiResultOrThrow<{ items: Array<{ id: string; internalReference: string; name: string; status: string }> }>(
        `/api/itad/jobs?search=${encodeURIComponent(search.trim())}&pageSize=10`,
      )
      return result.items.map((job) => ({ id: job.id, reference: job.internalReference, name: job.name, status: job.status, scheduledPickupAt: null, customerReference: null }))
    },
  })
  const options = [...candidates, ...(found.data ?? []).filter((job) => !candidates.some((candidate) => candidate.id === job.id))]
  const i3Actions = data.actions.filter((action) => action.type === 'resolve_exception' && action.status === 'pending')
  const openExceptions = useQuery<ExceptionOption[]>({
    queryKey: ['itad-inbox-job-exceptions', jobId],
    enabled: Boolean(jobId) && i3Actions.length > 0,
    queryFn: async () => {
      const result = await readApiResultOrThrow<{ items: ExceptionOption[] }>(`/api/itad/jobs/${jobId}/exceptions?status=open&pageSize=100`)
      return result.items.filter((item) => item.type === 'missing_from_delivery' || item.type === 'unexpected_asset')
    },
  })

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const call = await withScopedApiRequestHeaders(buildOptimisticLockHeader(data.updatedAt), () =>
        apiCall<{ error?: string }>(`/api/itad/inbox/messages/${data.id}/match`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            // Without actions that need a job (I1 only), the chosen customer decides: no job.
            ...(needsJob ? { jobId: jobId || null } : { jobId: null, customerId: customerId || null }),
            actionTargets: Object.entries(exceptions)
              .filter(([, exceptionId]) => Boolean(exceptionId))
              .map(([actionId, exceptionId]) => ({ actionId, exceptionId })),
          }),
        }),
      )
      setSaving(false)
      if (call.ok) onDone()
      else setError(typeof call.result?.error === 'string' ? call.result.error : t('itad.inbox.errors.generic', 'Could not complete the action'))
    } catch (err) {
      setSaving(false)
      if (!surfaceRecordConflict(err, t)) setError(t('itad.inbox.errors.generic', 'Could not complete the action'))
      else onDone()
    }
  }

  return (
    <div className="mt-3 space-y-3 rounded-md border bg-muted/20 p-3" data-testid="itad-inbox-match-editor">
      {needsCustomer ? (
        <>
          <FormField label={t('itad.inbox.match.findCustomer', 'Find the customer')}>
            <Input value={customerSearch} onChange={(event) => setCustomerSearch(event.target.value)} />
          </FormField>
          <FormField label={t('itad.inbox.target.customer', 'Customer')}>
            <Select value={customerId || undefined} onValueChange={setCustomerId}>
              <SelectTrigger aria-label={t('itad.inbox.target.customer', 'Customer')}>
                <SelectValue placeholder={t('itad.inbox.field.choose', 'Choose')} />
              </SelectTrigger>
              <SelectContent>
                {customerOptions.map((customer) => (
                  <SelectItem key={customer.id} value={customer.id}>{customer.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        </>
      ) : null}
      {needsJob ? (<>
      <FormField label={t('itad.inbox.match.findJob', 'Find a job by reference or name')}>
        <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="ITAD-2026-…" />
      </FormField>
      <FormField label={t('itad.inbox.target.job', 'Job')}>
        <Select value={jobId || undefined} onValueChange={(value) => { setJobId(value); setExceptions({}) }}>
          <SelectTrigger aria-label={t('itad.inbox.target.job', 'Job')}>
            <SelectValue placeholder={t('itad.inbox.field.choose', 'Choose')} />
          </SelectTrigger>
          <SelectContent>
            {options.map((job) => (
              <SelectItem key={job.id} value={job.id}>
                {job.reference} · {job.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>
      {jobId
        ? i3Actions.map((action, index) => (
            <FormField key={action.id} label={t('itad.inbox.match.exceptionFor', 'Exception for action {index}', { index: index + 1 })}>
              <Select value={exceptions[action.id] || undefined} onValueChange={(value) => setExceptions((current) => ({ ...current, [action.id]: value }))}>
                <SelectTrigger aria-label={t('itad.inbox.target.exception', 'Exception')}>
                  <SelectValue placeholder={t('itad.inbox.field.choose', 'Choose')} />
                </SelectTrigger>
                <SelectContent>
                  {(openExceptions.data ?? []).map((exception) => (
                    <SelectItem key={exception.id} value={exception.id}>
                      {exception.serial} · {t(`itad.exceptions.type.${exception.type}`, exception.type)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          ))
        : null}
      </>) : null}
      <p className="text-xs text-muted-foreground">{t('itad.inbox.match.rebuildHint', 'Saving rebuilds the pending actions for the chosen job; your edits to their fields are kept.')}</p>
      {error ? (
        <Alert status="error"><AlertDescription>{error}</AlertDescription></Alert>
      ) : null}
      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={() => void save()} disabled={saving || (needsJob ? !jobId : !customerId)} data-testid="itad-inbox-match-save">
          {saving ? <Spinner className="mr-2 h-4 w-4" /> : null}
          {t('itad.inbox.action.save', 'Save')}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel} disabled={saving}>
          {t('itad.sanitization.actions.cancel', 'Cancel')}
        </Button>
      </div>
    </div>
  )
}

export function InboxMessageDetail({ messageId }: { messageId: string }) {
  const t = useT()
  const queryClient = useQueryClient()
  const { granted } = useGrantedFeatures(['itad.inbox.manage'])
  const canManage = granted.has('itad.inbox.manage')
  const [draft, setDraft] = React.useState('')
  const [busy, setBusy] = React.useState<'reprocess' | 'draft' | 'close' | null>(null)
  const [editingMatch, setEditingMatch] = React.useState(false)
  const refresh = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['itad-inbox-message', messageId] })
    void queryClient.invalidateQueries({ queryKey: ['itad-inbox'] })
  }, [messageId, queryClient])

  const { data, isLoading, error } = useQuery<MessageDetail>({
    queryKey: ['itad-inbox-message', messageId],
    queryFn: async () => readApiResultOrThrow<MessageDetail>(`/api/itad/inbox/messages/${messageId}`),
    refetchInterval: (query) => (query.state.data?.status === 'processing' && !query.state.data.stalled ? 2500 : false),
  })

  React.useEffect(() => {
    setDraft(data?.draftReply ?? '')
  }, [data?.draftReply])

  const run = async (kind: 'reprocess' | 'draft' | 'close') => {
    if (!data) return
    setBusy(kind)
    try {
      const call = await withScopedApiRequestHeaders(buildOptimisticLockHeader(data.updatedAt), () =>
        apiCall<{ error?: string }>(`/api/itad/inbox/messages/${messageId}/${kind}`, { method: 'POST' }),
      )
      if (!call.ok) {
        flash(typeof call.result?.error === 'string' ? call.result.error : t('itad.inbox.errors.generic', 'Could not complete the action'), 'error')
      } else {
        flash(
          kind === 'draft'
            ? t('itad.inbox.draft.refreshed', 'Draft rebuilt from current data')
            : kind === 'close'
              ? t('itad.inbox.closed', 'Message closed')
              : t('itad.inbox.reprocessing', 'Reprocessing started'),
          'success',
        )
      }
    } catch (err) {
      if (!surfaceRecordConflict(err, t)) flash(t('itad.inbox.errors.generic', 'Could not complete the action'), 'error')
    } finally {
      setBusy(null)
      await queryClient.invalidateQueries({ queryKey: ['itad-inbox-message', messageId] })
    }
  }

  if (isLoading) return <Spinner className="h-6 w-6" />
  if (error || !data) {
    return (
      <Alert status="error">
        <AlertDescription>{t('itad.inbox.errors.loadMessage', 'Could not load the message')}</AlertDescription>
      </Alert>
    )
  }

  const executed = data.actions.some((action) => action.status === 'executed')
  const pendingCount = data.actions.filter((action) => action.status === 'pending').length
  const canReprocess = canManage && !executed && (data.status === 'failed' || data.stalled || data.status === 'proposed')
  const canClose = canManage && data.status === 'proposed' && pendingCount === 0
  return (
    <div className="space-y-6" data-testid="itad-inbox-detail">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h1 className="text-xl font-semibold">{data.subject}</h1>
          <p className="text-sm text-muted-foreground">
            {data.customerSender.name ? `${data.customerSender.name} <${data.customerSender.address}>` : data.customerSender.address}
            {' · '}
            {new Date(data.receivedAt).toLocaleString()}
            {data.forwardedByOrganizationUser ? ` · ${t('itad.inbox.forwardedBy', 'forwarded by {address}', { address: data.from.address })}` : ''}
            {data.source === 'manual' ? ` · ${t('itad.inbox.source.manual', 'added manually')}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <MatchStatusBadge status={data.matchStatus} />
          <MessageStatusBadge status={data.status} stalled={data.stalled} />
          {canClose ? (
            <Button type="button" variant="outline" size="sm" onClick={() => void run('close')} disabled={busy !== null} data-testid="itad-inbox-close">
              {t('itad.inbox.close', 'Close')}
            </Button>
          ) : null}
          {canReprocess ? (
            <Button type="button" variant="outline" size="sm" onClick={() => void run('reprocess')} disabled={busy !== null} data-testid="itad-inbox-reprocess">
              {busy === 'reprocess' ? <Spinner className="mr-2 h-4 w-4" /> : null}
              {t('itad.inbox.reprocess', 'Reprocess')}
            </Button>
          ) : null}
        </div>
      </div>

      {data.status === 'processing' && !data.stalled ? (
        <Alert status="information"><AlertDescription>{t('itad.inbox.processing', 'The email is being matched and interpreted…')}</AlertDescription></Alert>
      ) : null}
      {data.stalled ? (
        <Alert status="warning"><AlertDescription>{t('itad.inbox.stalledHint', 'Processing did not finish. Reprocess the message.')}</AlertDescription></Alert>
      ) : null}
      {data.processingError ? (
        <Alert status="error"><AlertDescription>{data.processingError.message}</AlertDescription></Alert>
      ) : null}

      <section aria-labelledby="itad-inbox-email">
        <SectionHeader title={t('itad.inbox.email', 'Email')} />
        <pre id="itad-inbox-email" className="mt-2 whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-3 font-sans text-sm">{data.currentText}</pre>
        {data.threadMessages.length ? (
          <details className="mt-2">
            <summary className="cursor-pointer text-sm text-muted-foreground">
              {t('itad.inbox.history', 'Earlier messages in the thread ({count})', { count: data.threadMessages.length })}
            </summary>
            {data.threadMessages.map((message, index) => (
              <pre key={index} className="mt-2 whitespace-pre-wrap break-words rounded-md border p-3 font-sans text-xs text-muted-foreground">
                {message.from ? `${message.from}\n` : ''}
                {message.body}
              </pre>
            ))}
          </details>
        ) : null}
      </section>

      {data.summary || data.intents.length ? (
        <section>
          <SectionHeader title={t('itad.inbox.summary', 'Summary')} />
          {data.summary ? <p className="mt-2 text-sm">{data.summary}</p> : null}
          <p className="mt-1 text-sm text-muted-foreground">
            {data.intents.length
              ? data.intents.map((intent) => t(`itad.inbox.intent.${intent}`, INTENT_LABELS[intent])).join(' · ')
              : t('itad.inbox.intent.other', 'Other')}
          </p>
        </section>
      ) : null}

      {data.match ? (
        <section>
          <div className="flex items-center justify-between gap-2">
            <SectionHeader title={t('itad.inbox.matchTitle', 'Match')} />
            {canManage && data.status === 'proposed' && pendingCount > 0 && !editingMatch ? (
              <Button type="button" variant="outline" size="sm" onClick={() => setEditingMatch(true)} data-testid="itad-inbox-change-match">
                {data.matchStatus === 'ambiguous' ? t('itad.inbox.match.choose', 'Choose the job') : t('itad.inbox.match.change', 'Change')}
              </Button>
            ) : null}
          </div>
          {editingMatch ? (
            <MatchEditor
              data={data}
              onCancel={() => setEditingMatch(false)}
              onDone={() => {
                setEditingMatch(false)
                refresh()
              }}
            />
          ) : null}
          <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
            <dt className="text-muted-foreground">{t('itad.inbox.target.customer', 'Customer')}</dt>
            <dd className="sm:col-span-2">{data.match.customer ? (isHidden(data.match.customer) ? <NoAccess /> : data.match.customer.name ?? data.match.customer.id) : <span className="text-muted-foreground">{t('itad.inbox.match.none', 'Not matched')}</span>}</dd>
            <dt className="text-muted-foreground">{t('itad.inbox.target.job', 'Job')}</dt>
            <dd className="sm:col-span-2"><JobLink job={data.match.job} /></dd>
          </dl>
          {data.match.jobCandidates.length > 1 || (!data.match.job && data.match.jobCandidates.length) ? (
            <div className="mt-3">
              <p className="text-sm font-medium">{t('itad.inbox.candidates', 'Candidates')}</p>
              <ul className="mt-1 space-y-2">
                {data.match.jobCandidates.map((candidate, index) => (
                  <li key={index}>
                    <JobLink job={candidate.job} />
                    <EvidenceList evidence={candidate.evidence} />
                  </li>
                ))}
              </ul>
            </div>
          ) : data.match.jobCandidates[0] ? (
            <EvidenceList evidence={data.match.jobCandidates[0].evidence} />
          ) : null}
        </section>
      ) : null}

      {data.actions.length ? (
        <section className="space-y-3">
          <SectionHeader title={t('itad.inbox.actions', 'Proposed actions')} />
          <p className="text-xs text-muted-foreground">{t('itad.inbox.actionsHint', 'Each action runs only when you accept it, with the same checks as in the job screens.')}</p>
          {data.actions.map((action) => <ActionCard key={`${action.id}:${action.updatedAt}`} action={action} canManage={canManage} onChanged={refresh} />)}
        </section>
      ) : null}

      {data.status !== 'processing' ? (
        <section>
          <SectionHeader title={t('itad.inbox.draft.title', 'Draft reply')} />
          {data.draftHidden ? (
            <p className="mt-2 text-sm text-muted-foreground">{t('itad.inbox.draft.hidden', 'The draft uses job data you cannot view.')}</p>
          ) : (
            <>
              <Textarea
                className="mt-2"
                rows={8}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                aria-label={t('itad.inbox.draft.title', 'Draft reply')}
                data-testid="itad-inbox-draft"
              />
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void navigator.clipboard?.writeText(draft)
                    flash(t('itad.inbox.copied', 'Copied'), 'success')
                  }}
                >
                  {t('itad.inbox.copy', 'Copy')}
                </Button>
                {canManage ? (
                  <Button type="button" variant="outline" size="sm" onClick={() => void run('draft')} disabled={busy !== null} data-testid="itad-inbox-refresh-draft">
                    {busy === 'draft' ? <Spinner className="mr-2 h-4 w-4" /> : null}
                    {t('itad.inbox.draft.refresh', 'Refresh draft')}
                  </Button>
                ) : null}
                <span className="text-xs text-muted-foreground">{t('itad.inbox.draft.neverSent', 'Never sent automatically; copy it into your email.')}</span>
              </div>
            </>
          )}
        </section>
      ) : null}
    </div>
  )
}

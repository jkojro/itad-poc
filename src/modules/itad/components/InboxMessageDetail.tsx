"use client"
import * as React from 'react'
import Link from 'next/link'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@open-mercato/ui/primitives/button'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
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
 * One customer email and its ITAD proposal (spec "UI/UX"). Phase 1 shows the actions;
 * deciding them (Accept / Edit / Reject) comes in phase 2. Details from ITAD records
 * the reader may not see arrive as `{ hidden: true }` and are shown as "No access".
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

function ActionCard({ action }: { action: MessageDetail['actions'][number] }) {
  const t = useT()
  const fields = Object.entries(action.payload)
  return (
    <section className="rounded-lg border p-4" aria-label={t(`itad.inbox.action.${action.type}`, ACTION_TYPE_LABELS[action.type])} data-testid="itad-inbox-action">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">{t(`itad.inbox.action.${action.type}`, ACTION_TYPE_LABELS[action.type])}</h3>
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
              {String(value)}
              {action.fieldSources[key] === 'operator' ? <span className="ml-2 text-xs text-muted-foreground">{t('itad.inbox.field.byOperator', '(edited)')}</span> : null}
            </dd>
          </React.Fragment>
        ))}
      </dl>
      {action.missingFields.length ? (
        <p className="mt-2 text-sm text-status-warning-text">
          {t('itad.inbox.missing', 'Missing: {fields}', {
            fields: action.missingFields.map((key) => t(`itad.inbox.field.${key}`, FIELD_LABELS[key] ?? key)).join(', '),
          })}
        </p>
      ) : null}
      <p className="mt-2 text-xs text-muted-foreground">{t('itad.inbox.decideLater', 'Accepting or rejecting actions comes in the next release; handle the change in the job for now.')}</p>
    </section>
  )
}

export function InboxMessageDetail({ messageId }: { messageId: string }) {
  const t = useT()
  const queryClient = useQueryClient()
  const { granted } = useGrantedFeatures(['itad.inbox.manage'])
  const canManage = granted.has('itad.inbox.manage')
  const [draft, setDraft] = React.useState('')
  const [busy, setBusy] = React.useState<'reprocess' | 'draft' | null>(null)

  const { data, isLoading, error } = useQuery<MessageDetail>({
    queryKey: ['itad-inbox-message', messageId],
    queryFn: async () => readApiResultOrThrow<MessageDetail>(`/api/itad/inbox/messages/${messageId}`),
    refetchInterval: (query) => (query.state.data?.status === 'processing' && !query.state.data.stalled ? 2500 : false),
  })

  React.useEffect(() => {
    setDraft(data?.draftReply ?? '')
  }, [data?.draftReply])

  const run = async (kind: 'reprocess' | 'draft') => {
    if (!data) return
    setBusy(kind)
    try {
      const call = await withScopedApiRequestHeaders(buildOptimisticLockHeader(data.updatedAt), () =>
        apiCall<{ error?: string }>(`/api/itad/inbox/messages/${messageId}/${kind}`, { method: 'POST' }),
      )
      if (!call.ok) {
        flash(typeof call.result?.error === 'string' ? call.result.error : t('itad.inbox.errors.generic', 'Could not complete the action'), 'error')
      } else {
        flash(kind === 'draft' ? t('itad.inbox.draft.refreshed', 'Draft rebuilt from current data') : t('itad.inbox.reprocessing', 'Reprocessing started'), 'success')
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

  const canReprocess = canManage && (data.status === 'failed' || data.stalled || data.status === 'proposed')
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
          <SectionHeader title={t('itad.inbox.matchTitle', 'Match')} />
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
          {data.actions.map((action) => <ActionCard key={action.id} action={action} />)}
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

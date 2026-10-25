"use client"
import * as React from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { INTENT_LABELS } from './inbox-ui'
import { MatchStatusBadge, MessageStatusBadge, type InboxRow } from './InboxTable'
import { useGrantedFeatures } from './use-granted-features'

/**
 * Customer emails about this job (Inbox Ops spec "UI/UX", job page): subject, intent and
 * status, linking to the Inbox detail. Shown only to Inbox readers, only when there is any.
 */
export function JobInboxSection({ jobId }: { jobId: string }) {
  const t = useT()
  const { granted, loading } = useGrantedFeatures(['itad.inbox.view'])
  const canView = granted.has('itad.inbox.view')
  const { data } = useQuery<InboxRow[]>({
    queryKey: ['itad-job-inbox', jobId],
    enabled: canView,
    queryFn: async () => {
      const call = await apiCall<{ items?: InboxRow[] }>(`/api/itad/inbox/messages?jobId=${jobId}&pageSize=10`)
      return call.ok ? call.result?.items ?? [] : []
    },
  })
  if (loading || !canView || !data?.length) return null
  return (
    <section className="rounded-lg border bg-card p-4" aria-label={t('itad.inbox.jobSection', 'Customer emails')} data-testid="itad-job-inbox">
      <h2 className="text-sm font-semibold">{t('itad.inbox.jobSection', 'Customer emails')}</h2>
      <ul className="mt-2 divide-y">
        {data.map((message) => (
          <li key={message.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
            <Link className="min-w-0 truncate underline" href={`/backend/itad/inbox/${message.id}`}>
              {message.subject}
            </Link>
            <span className="flex items-center gap-2">
              <span className="text-muted-foreground">
                {message.intents[0] ? t(`itad.inbox.intent.${message.intents[0]}`, INTENT_LABELS[message.intents[0]]) : t('itad.inbox.intent.other', 'Other')}
              </span>
              {message.pendingActions ? (
                <span className="text-xs text-muted-foreground">{t('itad.inbox.toDecide', '{count} to decide', { count: message.pendingActions })}</span>
              ) : null}
              <MatchStatusBadge status={message.matchStatus} />
              <MessageStatusBadge status={message.status} stalled={message.stalled} />
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

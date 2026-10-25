import type { EntityManager } from '@mikro-orm/postgresql'
import type { ItadJob } from '../data/entities'
import { customerSafeBlockers, type CustomerSafeBlocker } from '../domain/inbox-proposals'
import { buildJobOverviewCounters } from '../domain/job-overview'
import { composeCustomerStatus } from '../lib/ai-tool-compose'
import { loadJobOverviewSources } from './job-overview-reader'

/**
 * Job facts behind an Inbox reply draft (spec "Draft reply"): the customer status of the
 * job from the live counters, and the customer-safe blockers — categories and counts,
 * never notes, people or exception reasons. Read at generation time; Refresh draft
 * rebuilds them from current data.
 */

type Translate = (key: string, fallback: string, params?: Record<string, string | number>) => string

export type JobFacts = { reference: string; status: string; text: string; blockers: CustomerSafeBlocker[] }

const BLOCKER_TEXT: Record<CustomerSafeBlocker['key'], string> = {
  awaiting_devices: '{count} devices from the list have not arrived yet.',
  awaiting_erasure: '{count} devices are waiting for data erasure.',
  erasure_failed: '{count} devices need another data-erasure attempt.',
  awaiting_certificates: '{count} devices are waiting for their data-erasure certificate.',
}

export async function loadJobFacts(em: EntityManager, job: ItadJob, t: Translate): Promise<JobFacts> {
  const sources = await loadJobOverviewSources(em, job.tenantId, [job.id])
  const status = job.status === 'on_hold' && job.statusBeforeHold ? job.statusBeforeHold : job.status
  const counters = buildJobOverviewCounters(sources.get(job.id)!, status)
  const blockers = customerSafeBlockers(counters)
  const statusText = composeCustomerStatus(t, {
    reference: job.internalReference,
    customerReference: job.customerReference ?? null,
    statusLabel: t(`itad.jobs.status.${status}`, status),
    counters,
  })
  const blockerText = blockers.map((blocker) => t(`itad.inbox.blocker.${blocker.key}`, BLOCKER_TEXT[blocker.key], { count: blocker.count }))
  return { reference: job.internalReference, status, text: [statusText, ...blockerText].join('\n'), blockers }
}

/**
 * The reply the operator edits when the model gave none (fixture interpretation in tests,
 * or a refresh without the model): the job facts for a status inquiry, an acknowledgement
 * otherwise. In the operator's locale; never sent.
 */
export function factualDraft(t: Translate, input: { customerName: string | null; facts: JobFacts | null; statusInquiry: boolean }): string {
  const greeting = t('itad.inbox.draft.greeting', 'Hello {name},', { name: input.customerName ?? '' }).replace(' ,', ',')
  const body =
    input.statusInquiry && input.facts
      ? input.facts.text
      : t('itad.inbox.draft.acknowledge', 'Thank you for your message. We have received your request and will get back to you shortly.')
  const closing = t('itad.inbox.draft.closing', 'Kind regards')
  return [greeting, '', body, '', closing].join('\n')
}

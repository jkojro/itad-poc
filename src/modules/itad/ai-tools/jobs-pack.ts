import { z } from 'zod'
import type { AiToolDefinition } from '@open-mercato/ai-assistant/modules/ai_assistant/lib/types'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { ACTIVE_JOB_STATUSES, type JobOverviewCounters } from '../domain/job-overview'
import type { ItadJobListItem } from '../components/types'
import {
  bounded,
  composeCustomerStatus,
  hidden,
  jobHref,
  assetHref,
  lookupStatus,
  neededBlockingKinds,
  toFocusToday,
  toJobBlockers,
  toReconciliationSummary,
  untrusted,
  AI_BLOCKER_RECORD_LIMIT,
  type AssignedException,
  type AssignedLookup,
  type BlockingRecord,
  type BlockingRecordKind,
  type BlockingRecords,
  type FocusFilters,
  type OperationsItem,
  type TransitionsResponse,
} from '../lib/ai-tool-compose'
import { can, defineItadTool, isUuid, requireRouteData, routeData, runItadRoute, type ItadToolContext } from './_shared'

/**
 * Job tools of `itad.operations_assistant` (AI assistant spec, tool allowlist). Read only;
 * each one calls the ITAD job routes in process and maps the response with the pure
 * composers in `lib/ai-tool-compose.ts`.
 */

type OverviewResponse = {
  counters: JobOverviewCounters
  signals: Array<{ key: string; severity: string; count: number; href: string }>
  severity: string
  group: string
}
type JobsListResponse = { items: ItadJobListItem[]; total: number }
type ExceptionListResponse = {
  items: Array<{ id: string; type: string; serial: string; assetId: string | null; context?: { flaggedDifferentDevice?: boolean } }>
  total: number
}
type AssetListResponse = { items: Array<{ id: string; serial: string }>; total: number }
type SanitizationListResponse = { items: Array<{ id: string; serial: string; status: string }>; total: number }
type JobCertificatesResponse = { missingAssets: Array<{ id: string; serial: string }> }

/** Attention jobs whose assigned exceptions are read; more are reported as not all checked. */
const ASSIGNED_LOOKUP_JOB_LIMIT = 25

const jobIdInput = z.object({ jobId: z.string().uuid().describe('ITAD job id, from find_jobs or the page context.') })

async function loadJob(ctx: ItadToolContext, tool: AiToolDefinition, jobId: string): Promise<ItadJobListItem | null> {
  const response = await runItadRoute<JobsListResponse>(ctx, tool, { method: 'GET', path: '/jobs', query: { id: jobId, pageSize: 1 } })
  return routeData(response, 'Job lookup')?.items?.[0] ?? null
}

async function loadOverview(ctx: ItadToolContext, tool: AiToolDefinition, jobId: string): Promise<OverviewResponse> {
  const response = await runItadRoute<OverviewResponse>(ctx, tool, { method: 'GET', path: `/jobs/${jobId}/overview` })
  return requireRouteData(response, 'Job overview')
}

const notFound = (jobId: string) => ({ found: false as const, jobId })

// ─── find_jobs ───────────────────────────────────────────────────────────────

const findJobsTool: AiToolDefinition = defineItadTool({
  name: 'itad.find_jobs',
  displayName: 'Find ITAD jobs',
  description:
    'Find ITAD jobs by internal reference (ITAD-YYYY-NNNNN), customer reference or name. Returns { status: unique | ambiguous | none, candidates }. When ambiguous, ask the user which job they mean; never pick one yourself.',
  inputSchema: z.object({ query: z.string().trim().min(2).max(200).describe('Reference, customer reference or part of the job name.') }),
  requiredFeatures: ['itad.jobs.view'],
  isMutation: false,
  handler: async (input: { query: string }, ctx) => {
    const search = isUuid(input.query) ? { id: input.query, pageSize: 10 } : { search: input.query, pageSize: 10 }
    const response = await runItadRoute<JobsListResponse>(ctx, findJobsTool, { method: 'GET', path: '/jobs', query: search })
    const data = routeData(response, 'Job search') ?? { items: [], total: 0 }
    // Exact internal reference first, then exact customer reference, then the search results.
    const query = input.query.trim().toLowerCase()
    const byReference = data.items.filter((job) => job.internalReference.toLowerCase() === query)
    const byCustomerReference = data.items.filter((job) => job.customerReference?.toLowerCase() === query)
    const exact = byReference.length > 0 ? byReference : byCustomerReference
    const candidates = (exact.length > 0 ? exact : data.items).map((job) => ({
      jobId: job.id,
      reference: job.internalReference,
      customerReference: job.customerReference,
      name: job.name,
      customer: job.customerName,
      status: job.status,
      scheduledPickupAt: job.scheduledPickupAt,
      link: jobHref(job.id),
    }))
    return { status: lookupStatus(candidates.length), candidates: bounded(candidates, exact.length > 0 ? exact.length : data.total) }
  },
})

// ─── get_focus_today ─────────────────────────────────────────────────────────

const focusInput = z.object({
  filters: z
    .object({
      customerId: z.string().uuid().optional(),
      status: z.enum(ACTIVE_JOB_STATUSES).optional(),
      // Positive filters only, as in the operations endpoint: "jobs with failures", never "without".
      openExceptions: z.literal(true).optional(),
      missing: z.literal(true).optional(),
      failed: z.literal(true).optional(),
      missingCertificates: z.literal(true).optional(),
    })
    .optional()
    .describe('Only filters the user explicitly asked for. Omit to cover every active job.'),
})

const getFocusTodayTool: AiToolDefinition = defineItadTool({
  name: 'itad.get_focus_today',
  displayName: 'What needs attention today',
  description:
    'Active ITAD jobs that need attention (red first, then orange), each with the signals that explain why, plus open exceptions assigned to the caller. Covers every active job in scope unless the user asked for filters; the result echoes the filters applied.',
  inputSchema: focusInput,
  requiredFeatures: ['itad.jobs.view'],
  isMutation: false,
  handler: async (input: z.infer<typeof focusInput>, ctx) => {
    const filters: FocusFilters = input.filters ?? {}
    const query: Record<string, string> = {}
    if (filters.customerId) query.customerId = filters.customerId
    if (filters.status) query.status = filters.status
    for (const flag of ['openExceptions', 'missing', 'failed', 'missingCertificates'] as const) {
      if (filters[flag]) query[flag] = 'true'
    }
    const response = await runItadRoute<{ items: OperationsItem[]; truncated: boolean }>(ctx, getFocusTodayTool, {
      method: 'GET',
      path: '/operations',
      query,
    })
    const data = requireRouteData(response, 'Operations')
    const attention = data.items.filter((item) => item.severity !== 'none')
    const checked = attention.slice(0, ASSIGNED_LOOKUP_JOB_LIMIT)

    let assigned: AssignedLookup | ReturnType<typeof hidden>
    if (can(ctx, 'itad.exceptions.view')) {
      const items: AssignedException[] = []
      // TODO: one request per attention job (at most 25); replace with an aggregate read if
      // "what should I focus on" becomes a production hot path.
      for (const job of checked) {
        const list = routeData(
          await runItadRoute<ExceptionListResponse>(
            ctx,
            getFocusTodayTool,
            { method: 'GET', path: `/jobs/${job.id}/exceptions`, query: { status: 'open', assignedTo: 'me', pageSize: 25 } },
            ['itad.exceptions.view'],
          ),
          'Assigned exceptions',
        )
        for (const exception of list?.items ?? []) {
          items.push({
            exceptionId: exception.id,
            jobId: job.id,
            jobReference: job.internalReference,
            type: exception.type,
            serial: exception.serial,
            link: jobHref(job.id, `tab=exceptions&status=open&type=${exception.type}`),
          })
        }
      }
      assigned = { items, jobsChecked: checked.length, jobsNeedingAttention: attention.length }
    } else {
      assigned = hidden()
    }
    return toFocusToday({ items: data.items, truncated: data.truncated, appliedFilters: filters, assigned })
  },
})

// ─── get_job_summary ─────────────────────────────────────────────────────────

const getJobSummaryTool: AiToolDefinition = defineItadTool({
  name: 'itad.get_job_summary',
  displayName: 'Job summary',
  description: 'One ITAD job: status, customer, pickup, all overview counters and its attention signals.',
  inputSchema: jobIdInput,
  requiredFeatures: ['itad.jobs.view'],
  isMutation: false,
  handler: async (input: { jobId: string }, ctx) => {
    const job = await loadJob(ctx, getJobSummaryTool, input.jobId)
    if (!job) return notFound(input.jobId)
    const overview = await loadOverview(ctx, getJobSummaryTool, job.id)
    return {
      found: true,
      jobId: job.id,
      reference: job.internalReference,
      customerReference: job.customerReference,
      name: job.name,
      customer: job.customerName,
      status: job.status,
      statusBeforeHold: job.statusBeforeHold,
      scheduledPickupAt: job.scheduledPickupAt,
      // The pickup location may come from a customer email (Inbox Ops I1): untrusted text.
      ...untrusted({ holdReason: job.holdReason, pickupLocation: job.pickupLocation }),
      counters: overview.counters,
      severity: overview.severity,
      signals: overview.signals.map((signal) => ({ signal: signal.key, severity: signal.severity, count: signal.count, link: signal.href })),
      link: jobHref(job.id),
    }
  },
})

// ─── get_job_blockers ────────────────────────────────────────────────────────

const BLOCKING_FEATURE: Record<BlockingRecordKind, string> = {
  undecided_assets: 'itad.assets.view',
  duplicate_scans: 'itad.exceptions.view',
  unsanitized_assets: 'itad.sanitization.view',
  open_exceptions: 'itad.exceptions.view',
  missing_certificates: 'itad.certificates.view',
}

async function loadBlockingRecords(
  ctx: ItadToolContext,
  tool: AiToolDefinition,
  jobId: string,
  kind: BlockingRecordKind,
): Promise<BlockingRecord[]> {
  const feature = BLOCKING_FEATURE[kind]
  const limit = AI_BLOCKER_RECORD_LIMIT
  switch (kind) {
    case 'undecided_assets': {
      const data = routeData(
        await runItadRoute<AssetListResponse>(ctx, tool, { method: 'GET', path: `/jobs/${jobId}/assets`, query: { dataBearing: 'unknown', pageSize: limit } }, [feature]),
        'Undecided assets',
      )
      return (data?.items ?? []).map((asset) => ({ id: asset.id, label: asset.serial, link: assetHref(jobId, asset.id) }))
    }
    case 'duplicate_scans':
    case 'open_exceptions': {
      const query: Record<string, string | number> = { status: 'open', pageSize: limit }
      if (kind === 'duplicate_scans') query.type = 'duplicate_serial'
      const data = routeData(
        await runItadRoute<ExceptionListResponse>(ctx, tool, { method: 'GET', path: `/jobs/${jobId}/exceptions`, query }, [feature]),
        'Open exceptions',
      )
      // A duplicate flagged as a different device stays a DUPLICATE_SERIAL exception (the flag is on the scan).
      return (data?.items ?? []).map((exception) => ({
        id: exception.id,
        label: `${exception.type}: ${exception.serial}${exception.context?.flaggedDifferentDevice ? ' (flagged as a different device)' : ''}`,
        link: jobHref(jobId, `tab=exceptions&status=open&type=${exception.type}`),
      }))
    }
    case 'unsanitized_assets': {
      // Failed first (they need a decision), then in progress, then awaiting; each read is bounded.
      const records: BlockingRecord[] = []
      for (const status of ['review_required', 'sanitization_in_progress', 'sanitization_required']) {
        const data = routeData(
          await runItadRoute<SanitizationListResponse>(ctx, tool, { method: 'GET', path: `/jobs/${jobId}/sanitization`, query: { status, pageSize: limit } }, [feature]),
          'Sanitization',
        )
        for (const asset of data?.items ?? []) records.push({ id: asset.id, label: `${asset.serial} (${asset.status})`, link: assetHref(jobId, asset.id) })
        if (records.length >= limit) break
      }
      return records.slice(0, limit)
    }
    case 'missing_certificates': {
      // The certificates route returns every missing device; the composer bounds what the model gets.
      const data = routeData(
        await runItadRoute<JobCertificatesResponse>(ctx, tool, { method: 'GET', path: `/jobs/${jobId}/certificates` }, [feature]),
        'Certificates',
      )
      return (data?.missingAssets ?? []).map((asset) => ({ id: asset.id, label: asset.serial, link: assetHref(jobId, asset.id) }))
    }
  }
}

const getJobBlockersTool: AiToolDefinition = defineItadTool({
  name: 'itad.get_job_blockers',
  displayName: 'Why a job cannot move on',
  description:
    'Every gate of the job\'s next forward actions (including complete), met or not, with the records that block each unmet gate. A job is ready for an action only when that action has ready: true; never say it is ready otherwise. allowedForCaller only says whether the user may change the job\'s status at all; an unmet gate is never a permission problem.',
  inputSchema: jobIdInput,
  requiredFeatures: ['itad.jobs.view'],
  isMutation: false,
  handler: async (input: { jobId: string }, ctx) => {
    const job = await loadJob(ctx, getJobBlockersTool, input.jobId)
    if (!job) return notFound(input.jobId)
    const transitions = requireRouteData(
      await runItadRoute<TransitionsResponse>(ctx, getJobBlockersTool, { method: 'GET', path: `/jobs/${job.id}/transitions` }),
      'Job transitions',
    )
    const overview = await loadOverview(ctx, getJobBlockersTool, job.id)
    const records: BlockingRecords = {}
    for (const kind of neededBlockingKinds(transitions)) {
      records[kind] = can(ctx, BLOCKING_FEATURE[kind]) ? await loadBlockingRecords(ctx, getJobBlockersTool, job.id, kind) : 'hidden'
    }
    return { found: true, ...toJobBlockers({ jobId: job.id, reference: job.internalReference, transitions, counters: overview.counters, records }) }
  },
})

// ─── get_reconciliation_summary ──────────────────────────────────────────────

const getReconciliationSummaryTool: AiToolDefinition = defineItadTool({
  name: 'itad.get_reconciliation_summary',
  displayName: 'Reconciliation summary',
  description:
    'Expected, Received (matched to the manifest), Missing, Unexpected and Total intake of a job, with what they mean in its status, and the open missing / unexpected exceptions.',
  inputSchema: jobIdInput,
  requiredFeatures: ['itad.jobs.view'],
  isMutation: false,
  handler: async (input: { jobId: string }, ctx) => {
    const job = await loadJob(ctx, getReconciliationSummaryTool, input.jobId)
    if (!job) return notFound(input.jobId)
    const overview = await loadOverview(ctx, getReconciliationSummaryTool, job.id)
    let openExceptions: { missing: BlockingRecord[]; unexpected: BlockingRecord[] } | 'hidden' = 'hidden'
    if (can(ctx, 'itad.exceptions.view')) {
      const byType = async (type: string) => {
        const data = routeData(
          await runItadRoute<ExceptionListResponse>(
            ctx,
            getReconciliationSummaryTool,
            { method: 'GET', path: `/jobs/${job.id}/exceptions`, query: { status: 'open', type, pageSize: 25 } },
            ['itad.exceptions.view'],
          ),
          'Open exceptions',
        )
        return (data?.items ?? []).map((exception) => ({
          id: exception.id,
          label: exception.serial,
          link: jobHref(job.id, `tab=exceptions&status=open&type=${type}`),
        }))
      }
      openExceptions = { missing: await byType('missing_from_delivery'), unexpected: await byType('unexpected_asset') }
    }
    return {
      found: true,
      jobId: job.id,
      reference: job.internalReference,
      ...toReconciliationSummary({ status: job.status, statusBeforeHold: job.statusBeforeHold, counters: overview.counters, openExceptions }),
      link: jobHref(job.id, 'tab=receiving'),
    }
  },
})

// ─── generate_customer_status_summary ────────────────────────────────────────

const generateCustomerStatusSummaryTool: AiToolDefinition = defineItadTool({
  name: 'itad.generate_customer_status_summary',
  displayName: 'Draft a customer status update',
  description:
    'A short customer-facing status of a job built from live counters only (no internal reasons or exception details). It is a draft for the operator to review and send themselves; nothing is sent.',
  inputSchema: jobIdInput,
  requiredFeatures: ['itad.jobs.view'],
  isMutation: false,
  handler: async (input: { jobId: string }, ctx) => {
    const job = await loadJob(ctx, generateCustomerStatusSummaryTool, input.jobId)
    if (!job) return notFound(input.jobId)
    const overview = await loadOverview(ctx, generateCustomerStatusSummaryTool, job.id)
    const { translate } = await resolveTranslations()
    const status = job.status === 'on_hold' && job.statusBeforeHold ? job.statusBeforeHold : job.status
    const draft = composeCustomerStatus(translate, {
      reference: job.internalReference,
      customerReference: job.customerReference,
      statusLabel: translate(`itad.jobs.status.${status}`, status),
      counters: overview.counters,
    })
    return { found: true, jobId: job.id, reference: job.internalReference, draft, sent: false }
  },
})

export const jobsAiTools: AiToolDefinition[] = [
  findJobsTool,
  getFocusTodayTool,
  getJobSummaryTool,
  getJobBlockersTool,
  getReconciliationSummaryTool,
  generateCustomerStatusSummaryTool,
]

export default jobsAiTools

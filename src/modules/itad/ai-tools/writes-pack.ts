import { z } from 'zod'
import type { AiToolDefinition, AiToolLoadBeforeSingleRecord } from '@open-mercato/ai-assistant/modules/ai_assistant/lib/types'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import type { ItadExceptionStatus, ItadExceptionType } from '../domain/exceptions'
import type { ItadJobListItem } from '../components/types'
import { assetHref, jobHref } from '../lib/ai-tool-compose'
import { listOrganizationUsers } from '../module-integrations/users'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import { ITAD_EXCEPTION_TYPES, type ItadExceptionType as ExceptionType } from '../domain/exceptions'
import {
  approveRetryEligibility,
  ASSIGN_MAX_EXCEPTIONS,
  retryVersion,
  selectAssignable,
  type AssignCandidate,
  formatPickupTime,
  ineligibleVersion,
  isValidTimeZone,
  reschedulePickupEligibility,
  resolveExceptionEligibility,
  resolvePickupInstant,
  REASON_MAX_LENGTH,
  REASON_MIN_LENGTH,
  type WriteEligibility,
} from '../lib/ai-write-rules'
import { defineItadTool, ItadToolError, routeData, runItadRoute, type ItadToolContext } from './_shared'
import { isPendingProposal, requireApprovedAction, runApprovedWrite } from './_writes'

/**
 * Write tools of `itad.operations_assistant`, phase 2 (AI assistant spec, A2 and A4).
 * `loadBeforeRecord` builds the preview the operator confirms; the handler runs only for a
 * confirmed pending action and executes the existing ITAD command (see `_writes.ts`).
 */

type ExceptionDetail = {
  id: string
  type: ItadExceptionType
  status: ItadExceptionStatus
  serial: string
  assetId: string | null
  updatedAt: string
}

type Translate = Awaited<ReturnType<typeof resolveTranslations>>['translate']

const WRITE_MESSAGES: Record<string, string> = {
  not_found: 'Record not found',
  outcome_invalid: 'This outcome is not allowed for this exception type',
  reason_required: 'A reason of 3 to 1000 characters is required',
  resolve_through_domain_action: 'This exception type is resolved through its own action, not here',
  exception_resolved: 'The exception is no longer open',
  field_locked: 'The pickup can no longer be rescheduled in the current job status',
  time_invalid: 'The pickup time is not a valid date and time',
  time_in_past: 'The pickup time is in the past',
  time_in_past_now: 'The pickup time is in the past; it is now {now}',
  timezone_invalid: 'Unknown time zone',
  timezone_required: 'A local time needs its time zone (timeZone), or give the time with a UTC offset',
  job_not_processing: 'A retry can be approved only while the job is processing',
  asset_not_in_review: 'This device is not waiting for a retry decision (it must be in review after a failed wipe)',
  no_open_failure: 'This device has no open sanitization failure to approve a retry for',
  changed_since_preview: 'Changed since the preview; ask again for a fresh preview',
  exception_outside_filter: 'Some exceptions are not in this job or do not match the filter',
  nothing_to_assign: 'None of these exceptions is open and matching the filter now',
  assignee_invalid: 'The assignee is not an active user of this organization',
}

const message = (t: Translate, code: string, params?: Record<string, string>) => t(`itad.ai.write.${code}`, WRITE_MESSAGES[code] ?? code, params)

/**
 * Refuses a proposal the operator could not apply, so the model hears why (it never sees
 * the preview). At the confirm re-check — an action with this input is pending — a state
 * problem is returned as a blocked preview instead: a throw there becomes a 500 (see
 * `ai-write-rules.ts`). Returns whether the preview is blocked.
 */
async function refuseProposal(
  ctx: ItadToolContext,
  tool: AiToolDefinition,
  input: unknown,
  eligibility: WriteEligibility,
  refusal: (code: string) => ItadToolError,
): Promise<boolean> {
  if (eligibility.ok) return false
  if (eligibility.level === 'state' && (await isPendingProposal(ctx, tool, input))) return true
  throw refusal(eligibility.code)
}

async function loadJob(ctx: ItadToolContext, tool: AiToolDefinition, jobId: string): Promise<ItadJobListItem> {
  const response = await runItadRoute<{ items: ItadJobListItem[] }>(ctx, tool, { method: 'GET', path: '/jobs', query: { id: jobId, pageSize: 1 } }, [
    'itad.jobs.view',
  ])
  const job = routeData(response, 'Job lookup')?.items?.[0]
  if (!job) throw new ItadToolError('not_found', 'Job not found')
  return job
}

// ─── A2 resolve_exception ────────────────────────────────────────────────────

const resolveExceptionInput = z.object({
  jobId: z.string().uuid().describe('Job id, from a read tool.'),
  exceptionId: z.string().uuid().describe('Exception id, from list_open_exceptions or get_reconciliation_summary; never a serial.'),
  outcome: z
    .enum(['not_shipped', 'lost_in_transit', 'manifest_error', 'accepted_into_job'])
    .describe('missing_from_delivery: not_shipped | lost_in_transit | manifest_error; unexpected_asset: accepted_into_job.'),
  reason: z
    .string()
    .trim()
    .min(REASON_MIN_LENGTH)
    .max(REASON_MAX_LENGTH)
    .describe("The operator's own reason, from their words; ask for it when they gave none."),
})
type ResolveExceptionInput = z.infer<typeof resolveExceptionInput>

async function loadException(ctx: ItadToolContext, tool: AiToolDefinition, input: ResolveExceptionInput) {
  const job = await loadJob(ctx, tool, input.jobId)
  const response = await runItadRoute<ExceptionDetail>(
    ctx,
    tool,
    { method: 'GET', path: `/jobs/${input.jobId}/exceptions/${input.exceptionId}` },
    ['itad.exceptions.view'],
  )
  const exception = routeData(response, 'Exception lookup')
  if (!exception) throw new ItadToolError('not_found', 'Exception not found in this job')
  return { job, exception }
}

const resolveExceptionTool: AiToolDefinition = defineItadTool({
  name: 'itad.resolve_exception',
  displayName: 'Resolve exception',
  description:
    'Propose resolving one open MISSING_FROM_DELIVERY or UNEXPECTED_ASSET exception with an allowed outcome and the operator\'s reason. Creates a preview the operator must confirm; nothing changes before Confirm.',
  inputSchema: resolveExceptionInput,
  requiredFeatures: ['itad.exceptions.manage'],
  isMutation: true,
  loadBeforeRecord: async (rawInput: ResolveExceptionInput, ctx): Promise<AiToolLoadBeforeSingleRecord | null> => {
    const input = resolveExceptionInput.parse(rawInput)
    const { translate: t } = await resolveTranslations()
    const { job, exception } = await loadException(ctx, resolveExceptionTool, input)
    const eligibility = resolveExceptionEligibility({ type: exception.type, status: exception.status, outcome: input.outcome, reason: input.reason })
    await refuseProposal(ctx, resolveExceptionTool, input, eligibility, (code) => new ItadToolError(code, message(t, code)))
    const typeLabel = t(`itad.exceptions.type.${exception.type}`, exception.type)
    const outcomeLabel = t(`itad.exceptions.outcome.${input.outcome}`, input.outcome)
    return {
      recordId: exception.id,
      entityType: 'itad.exception',
      recordVersion: eligibility.ok ? exception.updatedAt : ineligibleVersion(eligibility.code),
      before: { status: exception.status, resolutionOutcome: null, resolutionReason: null, blocked: null },
      after: {
        status: 'resolved',
        resolutionOutcome: input.outcome,
        resolutionReason: input.reason,
        blocked: eligibility.ok ? null : eligibility.code,
      },
      display: {
        fieldLabels: {
          status: t('itad.ai.write.label.exceptionStatus', 'Exception {type} · {serial} · {reference}', {
            type: typeLabel,
            serial: exception.serial,
            reference: job.internalReference,
          }),
          resolutionOutcome: t('itad.ai.write.label.outcome', 'Outcome'),
          resolutionReason: t('itad.ai.write.label.reason', 'Reason'),
          blocked: t('itad.ai.write.label.blocked', 'Cannot be applied'),
        },
        before: { status: t(`itad.exceptions.status.${exception.status}`, exception.status) },
        after: {
          status: t('itad.exceptions.status.resolved', 'resolved'),
          resolutionOutcome: outcomeLabel,
          ...(eligibility.ok ? {} : { blocked: message(t, eligibility.code) }),
        },
      },
    }
  },
  handler: async (rawInput: ResolveExceptionInput, ctx) => {
    const input = resolveExceptionInput.parse(rawInput)
    const action = await requireApprovedAction(ctx, resolveExceptionTool)
    const { translate: t } = await resolveTranslations()
    const { job, exception } = await loadException(ctx, resolveExceptionTool, input)
    const eligibility = resolveExceptionEligibility({ type: exception.type, status: exception.status, outcome: input.outcome, reason: input.reason })
    if (!eligibility.ok) throw new ItadToolError(eligibility.code, message(t, eligibility.code))
    const result = await runApprovedWrite<Record<string, unknown>, { status: string; resolutionOutcome: string | null }>(ctx, resolveExceptionTool, {
      action,
      jobId: job.id,
      commandId: 'itad.exceptions.resolve',
      commandInput: { jobId: job.id, exceptionId: exception.id, outcome: input.outcome, reason: input.reason },
      resourceKind: 'itad.exception',
      resourceId: exception.id,
      current: { organizationId: job.organizationId, updatedAt: exception.updatedAt },
      what: 'Resolve exception',
    })
    // The framework keeps `recordId` and `commandName` on the pending action; the rest is for the chat turn.
    return {
      recordId: exception.id,
      commandName: 'itad.exceptions.resolve',
      done: true,
      exceptionId: exception.id,
      serial: exception.serial,
      status: result.status,
      outcome: result.resolutionOutcome,
      link: exception.assetId ? assetHref(job.id, exception.assetId) : jobHref(job.id, `tab=exceptions&type=${exception.type}`),
    }
  },
})

// ─── A4 reschedule_pickup ────────────────────────────────────────────────────

const reschedulePickupInput = z.object({
  jobId: z.string().uuid().describe('Job id, from find_jobs or the page context.'),
  scheduledPickupAt: z
    .string()
    .min(1)
    .max(40)
    .describe(
      'The new pickup time as the operator said it: a local date and time in timeZone (e.g. 2026-11-03T13:00), or ISO 8601 with an offset. Take the year from the current date; ask when the date or time is unclear.',
    ),
  timeZone: z.string().max(64).optional().describe('IANA time zone the operator meant, e.g. Europe/Warsaw; required with a local time, and used to show the time in the preview.'),
})
type ReschedulePickupInput = z.infer<typeof reschedulePickupInput>

function pickupInstant(t: Translate, input: ReschedulePickupInput): Date {
  const resolved = resolvePickupInstant(input.scheduledPickupAt, input.timeZone)
  if (!resolved.ok) throw new ItadToolError(resolved.code, message(t, resolved.code))
  return resolved.at
}

const reschedulePickupTool: AiToolDefinition = defineItadTool({
  name: 'itad.reschedule_pickup',
  displayName: 'Reschedule pickup',
  description:
    'Propose moving the scheduled pickup of a draft or scheduled job to a new future date and time. Creates a preview with the time and its time zone that the operator must confirm; nothing changes before Confirm.',
  inputSchema: reschedulePickupInput,
  requiredFeatures: ['itad.jobs.manage'],
  isMutation: true,
  loadBeforeRecord: async (rawInput: ReschedulePickupInput, ctx): Promise<AiToolLoadBeforeSingleRecord | null> => {
    const input = reschedulePickupInput.parse(rawInput)
    const { translate: t, locale } = await resolveTranslations()
    if (input.timeZone && !isValidTimeZone(input.timeZone)) throw new ItadToolError('timezone_invalid', message(t, 'timezone_invalid'))
    const at = pickupInstant(t, input)
    const job = await loadJob(ctx, reschedulePickupTool, input.jobId)
    const now = new Date()
    const zone = input.timeZone ?? 'UTC'
    const eligibility = reschedulePickupEligibility({ job, at, now })
    await refuseProposal(ctx, reschedulePickupTool, input, eligibility, (code) =>
      // A past time comes back with today's date, so the model can correct a wrong year or day.
      code === 'time_in_past'
        ? new ItadToolError(code, message(t, 'time_in_past_now', { now: formatPickupTime(now, zone, locale) }))
        : new ItadToolError(code, message(t, code)),
    )
    return {
      recordId: job.id,
      entityType: 'itad.job',
      recordVersion: eligibility.ok ? (job.updatedAt ?? null) : ineligibleVersion(eligibility.code),
      before: { scheduledPickupAt: job.scheduledPickupAt, blocked: null },
      after: { scheduledPickupAt: at.toISOString(), blocked: eligibility.ok ? null : eligibility.code },
      display: {
        fieldLabels: {
          scheduledPickupAt: t('itad.ai.write.label.pickup', 'Pickup · {reference}', { reference: job.internalReference }),
          blocked: t('itad.ai.write.label.blocked', 'Cannot be applied'),
        },
        before: { scheduledPickupAt: job.scheduledPickupAt ? formatPickupTime(new Date(job.scheduledPickupAt), zone, locale) : '—' },
        after: {
          scheduledPickupAt: formatPickupTime(at, zone, locale),
          ...(eligibility.ok ? {} : { blocked: message(t, eligibility.code) }),
        },
      },
    }
  },
  handler: async (rawInput: ReschedulePickupInput, ctx) => {
    const input = reschedulePickupInput.parse(rawInput)
    const action = await requireApprovedAction(ctx, reschedulePickupTool)
    const { translate: t, locale } = await resolveTranslations()
    const at = pickupInstant(t, input)
    const job = await loadJob(ctx, reschedulePickupTool, input.jobId)
    // Checked again here: time passes without changing the record version.
    const eligibility = reschedulePickupEligibility({ job, at, now: new Date() })
    if (!eligibility.ok) throw new ItadToolError(eligibility.code, message(t, eligibility.code))
    await runApprovedWrite<Record<string, unknown>, unknown>(ctx, reschedulePickupTool, {
      action,
      jobId: job.id,
      commandId: 'itad.jobs.update',
      commandInput: { id: job.id, scheduledPickupAt: at.toISOString() },
      resourceKind: 'itad.job',
      resourceId: job.id,
      current: { organizationId: job.organizationId, updatedAt: job.updatedAt ?? '' },
      what: 'Reschedule pickup',
    })
    return {
      recordId: job.id,
      commandName: 'itad.jobs.update',
      done: true,
      jobId: job.id,
      reference: job.internalReference,
      scheduledPickupAt: at.toISOString(),
      shown: formatPickupTime(at, input.timeZone ?? 'UTC', locale),
      link: jobHref(job.id),
    }
  },
})

// ─── A3 approve_sanitization_retry ───────────────────────────────────────────

type SanitizationHistory = {
  asset: { id: string; serial: string; status: ItadAssetStatusValue; updatedAt: string }
  runs: Array<{ id: string; method: string; result: 'PASS' | 'FAIL' | 'ABORTED' | null; startedAt: string; finishedAt: string | null }>
}
type ItadAssetStatusValue = Parameters<typeof approveRetryEligibility>[0]['assetStatus']
type ExceptionListResponse = { items: Array<ExceptionDetail & { assignedTo: { id: string; name: string | null } | null }>; total: number }

const approveRetryInput = z.object({
  jobId: z.string().uuid().describe('Job id, from a read tool or the page context.'),
  assetId: z.string().uuid().describe('Asset id of the device whose wipe failed, from find_asset or the page context; never a serial.'),
  reason: z
    .string()
    .trim()
    .min(REASON_MIN_LENGTH)
    .max(REASON_MAX_LENGTH)
    .describe("The operator's own reason for the retry, from their words; ask for it when they gave none."),
})
type ApproveRetryInput = z.infer<typeof approveRetryInput>

async function loadRetryState(ctx: ItadToolContext, tool: AiToolDefinition, input: ApproveRetryInput) {
  const job = await loadJob(ctx, tool, input.jobId)
  const history = routeData(
    await runItadRoute<SanitizationHistory>(ctx, tool, { method: 'GET', path: `/jobs/${input.jobId}/assets/${input.assetId}/sanitization` }, [
      'itad.sanitization.view',
    ]),
    'Sanitization history',
  )
  if (!history) throw new ItadToolError('not_found', 'Device not found in this job')
  const failures = routeData(
    await runItadRoute<ExceptionListResponse>(
      ctx,
      tool,
      { method: 'GET', path: `/jobs/${input.jobId}/exceptions`, query: { status: 'open', type: 'sanitization_failed', assetId: input.assetId, pageSize: 5 } },
      ['itad.exceptions.view'],
    ),
    'Exception lookup',
  )
  const failure = failures?.items?.[0] ?? null
  const finished = history.runs.filter((run) => run.result !== null)
  return { job, asset: history.asset, lastRun: history.runs[0] ?? null, attempts: finished.length, failure }
}

const approveRetryTool: AiToolDefinition = defineItadTool({
  name: 'itad.approve_sanitization_retry',
  displayName: 'Approve sanitization retry',
  description:
    'Propose approving another wipe attempt for one device whose sanitization failed (asset in review, open sanitization failure), with the operator\'s reason. The device goes back to sanitization required and the failure is resolved as retry approved; the failed run stays in the history. Creates a preview the operator must confirm; nothing changes before Confirm.',
  inputSchema: approveRetryInput,
  // The command also resolves the failure, so it keeps both requirements (spec "Users, permissions and scope").
  requiredFeatures: ['itad.sanitization.manage', 'itad.exceptions.manage'],
  isMutation: true,
  loadBeforeRecord: async (rawInput: ApproveRetryInput, ctx): Promise<AiToolLoadBeforeSingleRecord | null> => {
    const input = approveRetryInput.parse(rawInput)
    const { translate: t, locale } = await resolveTranslations()
    const { job, asset, lastRun, attempts, failure } = await loadRetryState(ctx, approveRetryTool, input)
    const eligibility = approveRetryEligibility({ jobStatus: job.status, assetStatus: asset.status, hasOpenFailure: Boolean(failure), reason: input.reason })
    await refuseProposal(ctx, approveRetryTool, input, eligibility, (code) => new ItadToolError(code, message(t, code)))
    const statusLabel = (status: string) => t(`itad.assets.status.${status}`, status)
    const run = lastRun
      ? t('itad.ai.write.label.lastRun', 'last run {method} {result}, {finishedAt}; attempts {attempts}', {
          method: t(`itad.sanitization.method.${lastRun.method}`, lastRun.method),
          result: lastRun.result ?? '—',
          finishedAt: lastRun.finishedAt ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(lastRun.finishedAt)) : '—',
          attempts: String(attempts),
        })
      : t('itad.ai.write.label.noRuns', 'no runs yet')
    return {
      recordId: asset.id,
      entityType: 'itad.asset',
      recordVersion: eligibility.ok && failure ? retryVersion(asset.updatedAt, failure) : ineligibleVersion(eligibility.ok ? 'no_open_failure' : eligibility.code),
      before: { status: asset.status, failure: failure ? 'open' : null, reason: null, blocked: null },
      after: {
        status: 'sanitization_required',
        failure: failure ? 'retry_approved' : null,
        reason: input.reason,
        blocked: eligibility.ok ? null : eligibility.code,
      },
      display: {
        fieldLabels: {
          status: t('itad.ai.write.label.retryDevice', 'Device {serial} · {reference} · {run}', { serial: asset.serial, reference: job.internalReference, run }),
          failure: t('itad.ai.write.label.failure', 'Sanitization failure'),
          reason: t('itad.ai.write.label.reason', 'Reason'),
          blocked: t('itad.ai.write.label.blocked', 'Cannot be applied'),
        },
        before: { status: statusLabel(asset.status), failure: failure ? t('itad.exceptions.status.open', 'open') : '—' },
        after: {
          status: statusLabel('sanitization_required'),
          failure: failure ? t('itad.exceptions.outcome.retry_approved', 'retry approved') : '—',
          ...(eligibility.ok ? {} : { blocked: message(t, eligibility.code) }),
        },
      },
    }
  },
  handler: async (rawInput: ApproveRetryInput, ctx) => {
    const input = approveRetryInput.parse(rawInput)
    const action = await requireApprovedAction(ctx, approveRetryTool)
    const { translate: t } = await resolveTranslations()
    const { job, asset, failure } = await loadRetryState(ctx, approveRetryTool, input)
    const eligibility = approveRetryEligibility({ jobStatus: job.status, assetStatus: asset.status, hasOpenFailure: Boolean(failure), reason: input.reason })
    if (!eligibility.ok) throw new ItadToolError(eligibility.code, message(t, eligibility.code))
    // The failure is part of the previewed version: closed or changed since → nothing is written.
    if (!failure || retryVersion(asset.updatedAt, failure) !== action.recordVersion) {
      throw new ItadToolError('conflict', message(t, 'changed_since_preview'))
    }
    const result = await runApprovedWrite<Record<string, unknown>, { assetStatus: string }>(ctx, approveRetryTool, {
      action,
      jobId: job.id,
      commandId: 'itad.sanitization.approve_retry',
      commandInput: { jobId: job.id, assetId: asset.id, reason: input.reason },
      resourceKind: 'itad.asset',
      resourceId: asset.id,
      current: { organizationId: job.organizationId, updatedAt: asset.updatedAt },
      expectedVersion: asset.updatedAt,
      what: 'Approve sanitization retry',
    })
    return {
      recordId: asset.id,
      commandName: 'itad.sanitization.approve_retry',
      done: true,
      assetId: asset.id,
      serial: asset.serial,
      assetStatus: result.assetStatus,
      resolvedExceptionId: failure.id,
      link: assetHref(job.id, asset.id),
    }
  },
})

// ─── A1 assign_exceptions ────────────────────────────────────────────────────

const assignExceptionsInput = z.object({
  jobId: z.string().uuid().describe('The one job whose exceptions are assigned.'),
  filter: z
    .object({
      type: z.enum(ITAD_EXCEPTION_TYPES).optional().describe('Exception type the operator named, e.g. sanitization_failed; omit for every type.'),
      assignee: z
        .union([z.enum(['unassigned', 'any']), z.string().uuid()])
        .describe('Which current assignee the operator meant: unassigned, any, or a user id.'),
    })
    .describe('The selection the operator asked for; the server re-checks every id against it.'),
  exceptionIds: z
    .array(z.string().uuid())
    .min(1)
    .max(ASSIGN_MAX_EXCEPTIONS)
    .describe(`Open exception ids matching the filter, from list_open_exceptions; at most ${ASSIGN_MAX_EXCEPTIONS} — ask to narrow when there are more.`),
  assignedToUserId: z.union([z.literal('me'), z.string().uuid()]).describe('New assignee: me (the operator) or a user id.'),
})
type AssignExceptionsInput = z.infer<typeof assignExceptionsInput>
type JobException = ExceptionListResponse['items'][number]

const EXCEPTION_PAGE_SIZE = 100
const EXCEPTION_PAGES = 10

async function loadJobExceptions(ctx: ItadToolContext, tool: AiToolDefinition, jobId: string, type: ExceptionType | undefined): Promise<JobException[]> {
  const items: JobException[] = []
  for (let page = 1; page <= EXCEPTION_PAGES; page += 1) {
    const response = routeData(
      await runItadRoute<ExceptionListResponse>(
        ctx,
        tool,
        { method: 'GET', path: `/jobs/${jobId}/exceptions`, query: { ...(type ? { type } : {}), page, pageSize: EXCEPTION_PAGE_SIZE } },
        ['itad.exceptions.view'],
      ),
      'Exception lookup',
    )
    const batch = response?.items ?? []
    items.push(...batch)
    if (batch.length < EXCEPTION_PAGE_SIZE) break
  }
  return items
}

async function assignmentState(ctx: ItadToolContext, tool: AiToolDefinition, input: AssignExceptionsInput) {
  const job = await loadJob(ctx, tool, input.jobId)
  const exceptions = await loadJobExceptions(ctx, tool, job.id, input.filter.type)
  const candidates: AssignCandidate[] = exceptions.map((exception) => ({
    id: exception.id,
    type: exception.type,
    status: exception.status,
    assignedToUserId: exception.assignedTo?.id ?? null,
  }))
  const selection = selectAssignable({ requestedIds: input.exceptionIds, filter: input.filter, jobExceptions: candidates })
  const byId = new Map(exceptions.map((exception) => [exception.id, exception]))
  return { job, selection, byId }
}

const assignExceptionsTool: AiToolDefinition = defineItadTool({
  name: 'itad.assign_exceptions',
  displayName: 'Assign exceptions',
  description: `Propose assigning open exceptions of ONE job to one person, e.g. "all open sanitization failures on this job to me" — the only batch change, at most ${ASSIGN_MAX_EXCEPTIONS}. Pass the filter the operator stated and the matching ids from list_open_exceptions. Each exception is assigned separately; ones changed since the preview are skipped and reported. Creates a preview the operator must confirm; nothing changes before Confirm.`,
  inputSchema: assignExceptionsInput,
  requiredFeatures: ['itad.exceptions.manage'],
  isMutation: true,
  isBulk: true,
  loadBeforeRecords: async (rawInput: AssignExceptionsInput, ctx) => {
    const input = assignExceptionsInput.parse(rawInput)
    const { translate: t } = await resolveTranslations()
    const { job, selection, byId } = await assignmentState(ctx, assignExceptionsTool, input)
    // An id that never belonged to this selection is a wrong proposal, at prepare and at confirm alike.
    if (selection.outside.length > 0) throw new ItadToolError('exception_outside_filter', message(t, 'exception_outside_filter'))
    const assigneeId = input.assignedToUserId === 'me' ? ctx.userId! : input.assignedToUserId
    const queryEngine = ctx.container.resolve<QueryEngine>('queryEngine')
    const [assignee] = await listOrganizationUsers(queryEngine, { tenantId: ctx.tenantId!, organizationId: job.organizationId }, { ids: [assigneeId], limit: 1 })
    const blocked = !assignee ? 'assignee_invalid' : selection.selected.length === 0 ? 'nothing_to_assign' : null
    if (blocked) {
      // At the confirm re-check every record then reads as changed (stale), never a 500.
      await refuseProposal(ctx, assignExceptionsTool, input, { ok: false, level: 'state', code: blocked }, (code) => new ItadToolError(code, message(t, code)))
      return []
    }
    const assigneeName = assignee!.name ?? assignee!.email ?? assignee!.id
    return selection.selected.map((id) => {
      const exception = byId.get(id)!
      const typeLabel = t(`itad.exceptions.type.${exception.type}`, exception.type)
      return {
        recordId: exception.id,
        entityType: 'itad.exception',
        label: `${typeLabel} · ${exception.serial} · ${job.internalReference}`,
        recordVersion: exception.updatedAt,
        before: { assignedToUserId: exception.assignedTo?.id ?? null },
        after: { assignedToUserId: assigneeId },
        display: {
          fieldLabels: { assignedToUserId: t('itad.ai.write.label.assignee', 'Assignee') },
          before: { assignedToUserId: exception.assignedTo?.name ?? t('itad.ai.write.unassigned', 'unassigned') },
          after: { assignedToUserId: assigneeName },
        },
      }
    })
  },
  handler: async (rawInput: AssignExceptionsInput, ctx) => {
    const input = assignExceptionsInput.parse(rawInput)
    const action = await requireApprovedAction(ctx, assignExceptionsTool)
    const { translate: t } = await resolveTranslations()
    const { job, selection, byId } = await assignmentState(ctx, assignExceptionsTool, input)
    const assigneeId = input.assignedToUserId === 'me' ? ctx.userId! : input.assignedToUserId
    const selected = new Set(selection.selected)
    type RecordResult = { recordId: string; serial: string | null; status: 'updated' | 'conflict' | 'refused'; error?: { code: string; message: string } }
    const records: RecordResult[] = []
    // Non-atomic by design (spec "A1 scope"): each exception is attempted on its own.
    for (const previewed of action.records) {
      const exception = byId.get(previewed.recordId)
      if (!exception || !selected.has(exception.id) || exception.updatedAt !== previewed.recordVersion) {
        records.push({
          recordId: previewed.recordId,
          serial: exception?.serial ?? null,
          status: 'conflict',
          error: { code: 'stale_version', message: message(t, 'changed_since_preview') },
        })
        continue
      }
      try {
        await runApprovedWrite<Record<string, unknown>, unknown>(ctx, assignExceptionsTool, {
          action,
          jobId: job.id,
          commandId: 'itad.exceptions.assign',
          commandInput: { jobId: job.id, exceptionId: exception.id, assignedToUserId: assigneeId },
          resourceKind: 'itad.exception',
          resourceId: exception.id,
          current: { organizationId: job.organizationId, updatedAt: exception.updatedAt },
          expectedVersion: previewed.recordVersion,
          what: 'Assign exception',
        })
        records.push({ recordId: exception.id, serial: exception.serial, status: 'updated' })
      } catch (err) {
        const error = err instanceof ItadToolError ? err : new ItadToolError('route_failed', 'Assign exception failed')
        records.push({
          recordId: exception.id,
          serial: exception.serial,
          status: error.code === 'conflict' || error.code === 'stale_version' || error.code === 'exception_resolved' ? 'conflict' : 'refused',
          error: { code: error.code, message: error.message },
        })
      }
    }
    const assigned = records.filter((record) => record.status === 'updated').length
    return {
      commandName: 'itad.exceptions.assign',
      done: assigned > 0,
      assigned,
      notAssigned: records.length - assigned,
      records,
      failedRecordIds: records.filter((record) => record.status !== 'updated').map((record) => record.recordId),
      link: jobHref(job.id, `tab=exceptions${input.filter.type ? `&type=${input.filter.type}` : ''}`),
    }
  },
})

export const writesAiTools: AiToolDefinition[] = [resolveExceptionTool, reschedulePickupTool, approveRetryTool, assignExceptionsTool]

export default writesAiTools

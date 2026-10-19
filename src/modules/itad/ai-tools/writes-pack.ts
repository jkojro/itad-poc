import { z } from 'zod'
import type { AiToolDefinition, AiToolLoadBeforeSingleRecord } from '@open-mercato/ai-assistant/modules/ai_assistant/lib/types'
import { resolveAiPendingActionTtlSeconds } from '@open-mercato/ai-assistant/modules/ai_assistant/lib/pending-action-types'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import type { ItadExceptionStatus, ItadExceptionType } from '../domain/exceptions'
import type { ItadJobListItem } from '../components/types'
import { assetHref, jobHref } from '../lib/ai-tool-compose'
import {
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
import { requireApprovedAction, runApprovedWrite } from './_writes'

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
}

const message = (t: Translate, code: string, params?: Record<string, string>) => t(`itad.ai.write.${code}`, WRITE_MESSAGES[code] ?? code, params)

/** Input problems refuse the preview; state problems are shown as blocked (see `ai-write-rules.ts`). */
function refuseInputProblem(t: Translate, eligibility: WriteEligibility): void {
  if (!eligibility.ok && eligibility.level === 'input') throw new ItadToolError(eligibility.code, message(t, eligibility.code))
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
    refuseInputProblem(t, eligibility)
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

/** A past time older than any pending action cannot have been valid at preview: refused at prepare (see `ai-write-rules.ts`). */
const refuseBeforeMs = () => (resolveAiPendingActionTtlSeconds() + 300) * 1000

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
    const eligibility = reschedulePickupEligibility({ job, at, now, refuseBeforeMs: refuseBeforeMs() })
    // Tells the model today's date, so it can correct a wrong year or day and propose again.
    if (!eligibility.ok && eligibility.level === 'input' && eligibility.code === 'time_in_past') {
      throw new ItadToolError('time_in_past', message(t, 'time_in_past_now', { now: formatPickupTime(now, zone, locale) }))
    }
    refuseInputProblem(t, eligibility)
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

export const writesAiTools: AiToolDefinition[] = [resolveExceptionTool, reschedulePickupTool]

export default writesAiTools

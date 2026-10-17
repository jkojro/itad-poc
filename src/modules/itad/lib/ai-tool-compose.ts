import type { ItadJobStatus } from '../domain/job-types'
import type { AttentionSeverity, AttentionSignalKey, JobOverviewCounters, JobSeverity } from '../domain/job-overview'

/**
 * Pure mappers behind the ITAD AI tools (AI assistant spec, "Tool rules"). They turn ITAD
 * route responses into bounded, structured tool results: facts and codes for the model
 * to phrase, record free text only inside `untrustedText`, and record details replaced
 * by `{ hidden: 'no_permission', count }` where the caller lacks the data type's feature.
 * No framework, database or model access here.
 */

/** Lists returned to the model are capped (spec "Bounded output"). */
export const AI_LIST_LIMIT = 25
/** Records named per blocking gate. */
export const AI_BLOCKER_RECORD_LIMIT = 10
/** Record free text (reasons, notes) is truncated before it reaches the model. */
export const AI_TEXT_LIMIT = 500

export type Hidden = { hidden: 'no_permission'; count: number }
export type Bounded<T> = { items: T[]; total: number; truncated: boolean }

export const hidden = (count: number): Hidden => ({ hidden: 'no_permission', count })

export function bounded<T>(items: readonly T[], total = items.length, limit = AI_LIST_LIMIT): Bounded<T> {
  const kept = items.slice(0, limit)
  return { items: kept, total, truncated: total > kept.length }
}

/**
 * Record free text as delimited, labelled data (spec "Untrusted text"). Returns `null`
 * when there is no text, so callers can omit the field.
 */
export function untrusted(fields: Record<string, string | null | undefined>): { untrustedText: Record<string, string> } | null {
  const kept: Record<string, string> = {}
  for (const [key, value] of Object.entries(fields)) {
    const text = typeof value === 'string' ? value.trim() : ''
    if (text) kept[key] = text.length > AI_TEXT_LIMIT ? `${text.slice(0, AI_TEXT_LIMIT)}…` : text
  }
  return Object.keys(kept).length ? { untrustedText: kept } : null
}

export type LookupStatus = 'unique' | 'ambiguous' | 'none'

/** No guessing (spec): one candidate is unique, several are ambiguous. */
export function lookupStatus(count: number): LookupStatus {
  if (count === 0) return 'none'
  return count === 1 ? 'unique' : 'ambiguous'
}

export const jobHref = (jobId: string, query?: string) =>
  `/backend/itad/jobs/${encodeURIComponent(jobId)}${query ? `?${query}` : ''}`
export const assetHref = (jobId: string, assetId: string) =>
  `/backend/itad/jobs/${encodeURIComponent(jobId)}/assets/${encodeURIComponent(assetId)}`

// ─── Focus today (US-AI-01) ──────────────────────────────────────────────────

export type OperationsItem = {
  id: string
  internalReference: string
  name: string
  status: ItadJobStatus
  statusBeforeHold: ItadJobStatus | null
  customer: { id: string; name: string | null }
  scheduledPickupAt: string | null
  signals: Array<{ key: AttentionSignalKey; severity: AttentionSeverity; count: number; href: string }>
  severity: JobSeverity
}

export type FocusFilters = {
  customerId?: string
  status?: ItadJobStatus
  openExceptions?: boolean
  missing?: boolean
  failed?: boolean
  missingCertificates?: boolean
}

export type AssignedException = { exceptionId: string; jobId: string; jobReference: string; type: string; serial: string; link: string }

/**
 * Jobs that need attention, in the operations order (red, then orange), each with its
 * signals as the reason. `assigned` is `null` when the caller may not see exceptions.
 */
export function toFocusToday(input: {
  items: readonly OperationsItem[]
  truncated: boolean
  appliedFilters: FocusFilters
  assigned: readonly AssignedException[] | Hidden
}) {
  const attention = input.items.filter((item) => item.severity !== 'none')
  return {
    appliedFilters: input.appliedFilters,
    activeJobsConsidered: input.items.length,
    sourceTruncated: input.truncated,
    jobs: bounded(
      attention.map((item) => ({
        jobId: item.id,
        reference: item.internalReference,
        name: item.name,
        customer: item.customer.name,
        status: item.status,
        statusBeforeHold: item.statusBeforeHold,
        severity: item.severity,
        reasons: item.signals.map((signal) => ({ signal: signal.key, severity: signal.severity, count: signal.count, link: signal.href })),
        link: jobHref(item.id),
      })),
    ),
    assignedToMe: Array.isArray(input.assigned) ? bounded(input.assigned) : input.assigned,
  }
}

// ─── Job blockers (US-AI-02) ─────────────────────────────────────────────────

/** Forward actions whose gates explain why a job cannot move on; hold, cancel and step-backs are excluded. */
export const FORWARD_ACTIONS = ['schedule', 'dispatch', 'start_receiving', 'start_processing', 'start_closeout', 'complete', 'resume'] as const

export type TransitionsResponse = {
  status: ItadJobStatus
  statusBeforeHold: ItadJobStatus | null
  actions: Array<{
    id: string
    to: ItadJobStatus
    allowed: boolean
    conditions: Array<{
      key: string
      state: 'met' | 'unmet' | 'confirmation_required'
      canConfirm: boolean
      detailKey: string | null
      detailParams: Record<string, unknown> | null
    }>
  }>
}

export type BlockingRecordKind = 'undecided_assets' | 'duplicate_scans' | 'unsanitized_assets' | 'open_exceptions' | 'missing_certificates'
export type BlockingRecord = { id: string; label: string; link: string }
export type BlockingRecords = Partial<Record<BlockingRecordKind, readonly BlockingRecord[] | 'hidden'>>

/** Which records explain an unmet gate, and the job counter that counts them. */
export function blockingKind(conditionKey: string, detailKey: string | null): BlockingRecordKind | null {
  const detail = detailKey?.split('.').pop() ?? null
  if (conditionKey === 'receivingComplete') {
    if (detail === 'dataBearingUndecided') return 'undecided_assets'
    if (detail === 'duplicatesPending' || detail === 'differentDeviceUnresolved') return 'duplicate_scans'
    return null
  }
  if (conditionKey === 'allAssetsProcessed') return detail === 'sanitizationPending' ? 'unsanitized_assets' : null
  if (conditionKey === 'noBlockingExceptions') return 'open_exceptions'
  if (conditionKey === 'requiredDocumentsComplete') return 'missing_certificates'
  return null
}

export function blockingCount(kind: BlockingRecordKind, counters: JobOverviewCounters): number {
  switch (kind) {
    case 'undecided_assets':
      return counters.dataBearingUnknown
    case 'duplicate_scans':
      return counters.unresolvedDuplicates
    case 'unsanitized_assets':
      return counters.awaitingWipe + counters.failed
    case 'open_exceptions':
      return counters.openExceptions
    case 'missing_certificates':
      return counters.certificatesMissing
  }
}

/** The record kinds a blockers answer needs, so the tool fetches only those. */
export function neededBlockingKinds(transitions: TransitionsResponse): BlockingRecordKind[] {
  const kinds = new Set<BlockingRecordKind>()
  for (const action of transitions.actions) {
    if (!(FORWARD_ACTIONS as readonly string[]).includes(action.id)) continue
    for (const condition of action.conditions) {
      if (condition.state === 'met') continue
      const kind = blockingKind(condition.key, condition.detailKey)
      if (kind) kinds.add(kind)
    }
  }
  return [...kinds]
}

/**
 * Every gate of the job's forward actions, met or not, with the records that block it.
 * `ready` is true only when an action's every gate is met (a manual confirmation is not
 * "met"), so the assistant never calls a job ready while a gate is open (AI-REQ-04).
 */
export function toJobBlockers(input: {
  jobId: string
  reference: string
  transitions: TransitionsResponse
  counters: JobOverviewCounters
  records: BlockingRecords
}) {
  const actions = input.transitions.actions
    .filter((action) => (FORWARD_ACTIONS as readonly string[]).includes(action.id))
    .map((action) => ({
      action: action.id,
      to: action.to,
      ready: action.conditions.every((condition) => condition.state === 'met'),
      allowedForCaller: action.allowed,
      gates: action.conditions.map((condition) => {
        const kind = condition.state === 'met' ? null : blockingKind(condition.key, condition.detailKey)
        const records = kind ? input.records[kind] : undefined
        const count = kind ? blockingCount(kind, input.counters) : 0
        return {
          gate: condition.key,
          state: condition.state,
          detail: condition.detailKey,
          detailParams: condition.detailParams,
          ...(kind
            ? {
                blocking:
                  records === 'hidden' || records === undefined
                    ? hidden(count)
                    : bounded(records, Math.max(count, records.length), AI_BLOCKER_RECORD_LIMIT),
              }
            : {}),
        }
      }),
    }))
  return {
    jobId: input.jobId,
    reference: input.reference,
    status: input.transitions.status,
    statusBeforeHold: input.transitions.statusBeforeHold,
    actions,
    link: jobHref(input.jobId),
  }
}

// ─── Reconciliation and sanitization summaries ───────────────────────────────

/**
 * Reconciliation facts with their meaning as flags (operations dashboard D7, D9): while
 * receiving, missing devices are progress; after receiving only open exceptions need action.
 */
export function toReconciliationSummary(input: {
  status: ItadJobStatus
  statusBeforeHold: ItadJobStatus | null
  counters: JobOverviewCounters
  openExceptions: { missing: readonly BlockingRecord[]; unexpected: readonly BlockingRecord[] } | 'hidden'
}) {
  const effective = input.status === 'on_hold' ? input.statusBeforeHold ?? 'on_hold' : input.status
  const { counters } = input
  return {
    status: input.status,
    expected: counters.expected,
    received: counters.received,
    missing: counters.missing,
    unexpected: counters.unexpected,
    totalIntake: counters.totalIntake,
    meaning: {
      receivedIsMatched: true,
      missingIsReceivingProgress: effective === 'receiving',
      attentionFromOpenExceptionsOnly: effective === 'processing' || effective === 'closeout_review',
    },
    openMissingExceptions:
      input.openExceptions === 'hidden' ? hidden(counters.openMissingExceptions) : bounded(input.openExceptions.missing, counters.openMissingExceptions),
    openUnexpectedExceptions:
      input.openExceptions === 'hidden'
        ? hidden(counters.openUnexpectedExceptions)
        : bounded(input.openExceptions.unexpected, counters.openUnexpectedExceptions),
  }
}

export type SanitizationCounts = { required: number; inProgress: number; sanitized: number; reviewRequired: number }

/**
 * Sanitization picture of a job. `notDataBearing` and `undecided` need the job overview
 * (`itad.jobs.view`); without it they are hidden.
 */
export function toSanitizationSummary(input: { counts: SanitizationCounts; counters: JobOverviewCounters | null }) {
  const { counts, counters } = input
  const dataBearing = counts.required + counts.inProgress + counts.sanitized + counts.reviewRequired
  return {
    awaitingWipe: counts.required,
    inProgress: counts.inProgress,
    sanitized: counts.sanitized,
    failedNeedsReview: counts.reviewRequired,
    dataBearingInScope: dataBearing,
    undecided: counters ? counters.dataBearingUnknown : hidden(0),
    notDataBearing: counters ? Math.max(0, counters.totalIntake - dataBearing - counters.dataBearingUnknown) : hidden(0),
  }
}

// ─── Customer status draft ───────────────────────────────────────────────────

export type Translate = (key: string, fallback: string, params?: Record<string, string | number>) => string

/**
 * A short customer-facing status built only from live job facts (no internal reasons,
 * no exception details). Returned to the operator as a draft; nothing is sent.
 */
export function composeCustomerStatus(
  t: Translate,
  input: { reference: string; customerReference: string | null; statusLabel: string; counters: JobOverviewCounters },
): string {
  const { counters } = input
  const reference = input.customerReference ? `${input.reference} (${input.customerReference})` : input.reference
  const lines = [t('itad.ai.status.heading', 'Status of {reference}: {status}.', { reference, status: input.statusLabel })]
  if (counters.expected > 0 || counters.totalIntake > 0) {
    lines.push(
      t('itad.ai.status.received', 'Received {received} of {expected} expected devices.', {
        received: counters.received,
        expected: counters.expected,
      }),
    )
  }
  if (counters.unexpected > 0) {
    lines.push(t('itad.ai.status.unexpected', '{count} devices arrived that were not on the manifest.', { count: counters.unexpected }))
  }
  if (counters.sanitizationScope > 0) {
    lines.push(
      t('itad.ai.status.sanitized', 'Data erasure completed for {sanitized} of {scope} data-bearing devices.', {
        sanitized: counters.sanitized,
        scope: counters.sanitizationScope,
      }),
    )
  }
  if (counters.certificatesRequired > 0) {
    lines.push(
      t('itad.ai.status.certificates', '{issued} of {required} erasure certificates issued.', {
        issued: counters.certificatesIssued,
        required: counters.certificatesRequired,
      }),
    )
  }
  return lines.join(' ')
}

import type { ItadJobStatus } from './job-types'

/**
 * Operations overview of jobs (operations dashboard spec, Epic 7). Pure: counters are
 * computed from source counts at read time and never stored (REQ-701, REQ-719).
 * Counters state facts; attention states problems (D9): a resolved missing or accepted
 * unexpected device stays in its reconciliation counter but needs no action.
 */

/** Source counts of one job, read from manifest, assets, scans, exceptions and certificates. */
export type JobOverviewSource = {
  activeManifestItems: number
  /** Active manifest items with an active asset of the same normalized serial. */
  matched: number
  activeAssets: number
  awaitingWipe: number
  sanitized: number
  failed: number
  dataBearingUnknown: number
  unresolvedDuplicates: number
  openExceptions: number
  openMissingExceptions: number
  openUnexpectedExceptions: number
  /** Active data-bearing sanitized assets that have an `issued` certificate. */
  certifiedSanitized: number
}

export type JobOverviewCounters = {
  expected: number
  received: number
  missing: number
  unexpected: number
  totalIntake: number
  awaitingWipe: number
  sanitized: number
  failed: number
  sanitizationScope: number
  dataBearingUnknown: number
  unresolvedDuplicates: number
  openExceptions: number
  openMissingExceptions: number
  openUnexpectedExceptions: number
  certificatesRequired: number
  certificatesIssued: number
  certificatesMissing: number
}

export const EMPTY_JOB_OVERVIEW_SOURCE: JobOverviewSource = {
  activeManifestItems: 0,
  matched: 0,
  activeAssets: 0,
  awaitingWipe: 0,
  sanitized: 0,
  failed: 0,
  dataBearingUnknown: 0,
  unresolvedDuplicates: 0,
  openExceptions: 0,
  openMissingExceptions: 0,
  openUnexpectedExceptions: 0,
  certifiedSanitized: 0,
}

/**
 * Spec "Domain vocabulary and counters": Received is matched (Expected = Received +
 * Missing), Unexpected is separate, Total intake is every active asset. A cancelled job
 * requires no certificate (certificates spec REQ-615).
 */
export function buildJobOverviewCounters(source: JobOverviewSource, jobStatus: ItadJobStatus): JobOverviewCounters {
  const required = jobStatus === 'cancelled' ? 0 : source.sanitized
  const issued = jobStatus === 'cancelled' ? 0 : Math.min(source.certifiedSanitized, required)
  return {
    expected: source.activeManifestItems,
    received: source.matched,
    missing: Math.max(0, source.activeManifestItems - source.matched),
    unexpected: Math.max(0, source.activeAssets - source.matched),
    totalIntake: source.activeAssets,
    awaitingWipe: source.awaitingWipe,
    sanitized: source.sanitized,
    failed: source.failed,
    sanitizationScope: source.awaitingWipe + source.sanitized + source.failed,
    dataBearingUnknown: source.dataBearingUnknown,
    unresolvedDuplicates: source.unresolvedDuplicates,
    openExceptions: source.openExceptions,
    openMissingExceptions: source.openMissingExceptions,
    openUnexpectedExceptions: source.openUnexpectedExceptions,
    certificatesRequired: required,
    certificatesIssued: issued,
    certificatesMissing: required - issued,
  }
}

// ─── Attention model (spec "Attention model", Q4, D7, D8, D9) ───────────────

export const ATTENTION_SIGNAL_KEYS = [
  'failed',
  'unresolved_duplicates',
  'unexpected',
  'missing_exceptions',
  'unexpected_exceptions',
  'data_bearing_unknown',
  'certificates_missing',
] as const
export type AttentionSignalKey = (typeof ATTENTION_SIGNAL_KEYS)[number]

export type AttentionSeverity = 'red' | 'orange'
export type JobSeverity = AttentionSeverity | 'none'

export type AttentionSignal = { key: AttentionSignalKey; severity: AttentionSeverity; count: number }

export type OverviewJob = { status: ItadJobStatus; statusBeforeHold?: ItadJobStatus | null }

/** The status a job is evaluated in: an on-hold job counts as its pre-hold status. */
export function effectiveStatus(job: OverviewJob): ItadJobStatus {
  return job.status === 'on_hold' ? job.statusBeforeHold ?? 'on_hold' : job.status
}

/**
 * What needs action now. Severity comes from the kind of problem, never from the bare
 * number of open exceptions (Q4). Missing while receiving is progress (D7); after
 * receiving, missing and unexpected need action only while their exception is open
 * (D9); missing certificates block only closeout (D8).
 */
export function attentionSignals(job: OverviewJob, counters: JobOverviewCounters): AttentionSignal[] {
  const status = effectiveStatus(job)
  const afterReceiving = status === 'processing' || status === 'closeout_review'
  const signals: AttentionSignal[] = []
  const add = (key: AttentionSignalKey, severity: AttentionSeverity, count: number) => {
    if (count > 0) signals.push({ key, severity, count })
  }
  add('failed', 'red', counters.failed)
  add('unresolved_duplicates', 'red', counters.unresolvedDuplicates)
  if (status === 'receiving') add('unexpected', 'orange', counters.unexpected)
  if (afterReceiving) {
    add('missing_exceptions', 'orange', counters.openMissingExceptions)
    add('unexpected_exceptions', 'orange', counters.openUnexpectedExceptions)
  }
  add('data_bearing_unknown', 'orange', counters.dataBearingUnknown)
  if (status === 'closeout_review') add('certificates_missing', 'orange', counters.certificatesMissing)
  return signals
}

export function jobSeverity(signals: readonly AttentionSignal[]): JobSeverity {
  if (signals.some((signal) => signal.severity === 'red')) return 'red'
  if (signals.length > 0) return 'orange'
  return 'none'
}

// ─── Groups and order (spec "Groups and order", REQ-721) ────────────────────

export const JOB_OVERVIEW_GROUPS = ['attention_red', 'attention_orange', 'in_progress', 'upcoming', 'draft'] as const
export type JobOverviewGroup = (typeof JOB_OVERVIEW_GROUPS)[number]

/** Attention first (red, orange); otherwise by the (pre-hold) status. */
export function jobOverviewGroup(job: OverviewJob, severity: JobSeverity): JobOverviewGroup {
  if (severity === 'red') return 'attention_red'
  if (severity === 'orange') return 'attention_orange'
  const status = effectiveStatus(job)
  if (status === 'draft') return 'draft'
  if (status === 'scheduled') return 'upcoming'
  return 'in_progress'
}

export type OrderedOverviewJob = { group: JobOverviewGroup; scheduledPickupAt: Date | null; internalReference: string }

/** Group order, then scheduled pickup ascending (no date last), then job reference. */
export function compareOverviewJobs(a: OrderedOverviewJob, b: OrderedOverviewJob): number {
  const group = JOB_OVERVIEW_GROUPS.indexOf(a.group) - JOB_OVERVIEW_GROUPS.indexOf(b.group)
  if (group !== 0) return group
  const aTime = a.scheduledPickupAt ? a.scheduledPickupAt.getTime() : Number.POSITIVE_INFINITY
  const bTime = b.scheduledPickupAt ? b.scheduledPickupAt.getTime() : Number.POSITIVE_INFINITY
  if (aTime !== bTime) return aTime < bTime ? -1 : 1
  return a.internalReference.localeCompare(b.internalReference)
}

export type JobOverview = {
  counters: JobOverviewCounters
  signals: AttentionSignal[]
  severity: JobSeverity
  group: JobOverviewGroup
}

/** Counters, attention and group of one job. */
export function buildJobOverview(job: OverviewJob, source: JobOverviewSource): JobOverview {
  const counters = buildJobOverviewCounters(source, job.status)
  const signals = attentionSignals(job, counters)
  const severity = jobSeverity(signals)
  return { counters, signals, severity, group: jobOverviewGroup(job, severity) }
}

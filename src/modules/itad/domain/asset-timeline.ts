import type { ItadDataBearingSource } from './data-bearing'
import type { ItadExceptionEventKind, ItadExceptionOutcome, ItadExceptionType } from './exceptions'
import type { ItadAssetHistoryStatus, ItadAssetTransitionAction, ItadScanResult } from './job-types'
import type { ItadSanitizationMethod } from './sanitization-state-machine'

/**
 * Business timeline of one device (exceptions spec "Business timeline", E4-050 … E4-054).
 * Pure: the reader passes rows the module already stores; this merges them into business
 * events, never technical audit rows, sorted chronologically with a stable tie-break, and
 * filtered by what the viewer may see. Reading never writes anything.
 */
export type TimelineCategory = 'receiving' | 'data_bearing' | 'sanitization' | 'exception' | 'job'

export type TimelineKind =
  | 'received'
  | 'scanned_again'
  | 'duplicate_same_device'
  | 'duplicate_flagged'
  | 'duplicate_set_aside'
  | 'voided'
  | 'data_bearing_decided'
  | 'data_bearing_changed'
  | 'sanitization_started'
  | 'sanitization_passed'
  | 'sanitization_failed'
  | 'sanitization_aborted'
  | 'retry_approved'
  | 'exception_opened'
  | 'exception_assigned'
  | 'exception_unassigned'
  | 'exception_resolved'
  | 'reconciled'
  | 'job_completed'
  | 'job_cancelled'

export type TimelineEntry = {
  at: string
  kind: TimelineKind
  category: TimelineCategory
  /** `null` = the system. */
  actorUserId: string | null
  details: {
    scanResult?: ItadScanResult
    dataBearingFrom?: boolean | null
    dataBearingTo?: boolean | null
    dataBearingSource?: ItadDataBearingSource | null
    method?: ItadSanitizationMethod | null
    tool?: string | null
    exceptionType?: ItadExceptionType
    outcome?: ItadExceptionOutcome | null
    assignedToUserId?: string | null
    reason?: string | null
  }
}

/** Source rows (already scoped to the tenant, organization, job and asset). */
export type TimelineSources = {
  asset: {
    receivedAt: Date
    receivedByUserId: string
    firstScanResult: ItadScanResult | null
    dataBearingSource: ItadDataBearingSource | null
    deletedAt: Date | null
    deletedByUserId: string | null
    deleteReason: string | null
  }
  /** Repeated (duplicate) scans of the asset's serial in this job. */
  duplicateScans: Array<{
    scannedAt: Date
    scannedByUserId: string
    resolution: string | null
    resolutionNote: string | null
    resolvedAt: Date | null
    resolvedByUserId: string | null
    flaggedAt: Date | null
    flaggedByUserId: string | null
    flaggedNote: string | null
  }>
  transitions: Array<{
    createdAt: Date
    action: ItadAssetTransitionAction
    fromStatus: ItadAssetHistoryStatus | null
    toStatus: ItadAssetHistoryStatus
    dataBearingFrom: boolean | null
    dataBearingTo: boolean | null
    reason: string | null
    actorUserId: string | null
    runMethod: ItadSanitizationMethod | null
    runTool: string | null
  }>
  exceptionEvents: Array<{
    createdAt: Date
    kind: ItadExceptionEventKind
    exceptionType: ItadExceptionType
    assignedToUserId: string | null
    outcome: ItadExceptionOutcome | null
    reason: string | null
    actorUserId: string | null
  }>
  jobTransitions: Array<{ createdAt: Date; action: string; reason: string | null; actorUserId: string }>
}

export type TimelineVisibility = { sanitization: boolean; exceptions: boolean }

/** Tie-break for entries at the same instant: the order a person would tell the story. */
const KIND_ORDER: TimelineKind[] = [
  'received',
  'data_bearing_decided',
  'scanned_again',
  'duplicate_flagged',
  'duplicate_same_device',
  'duplicate_set_aside',
  'voided',
  'data_bearing_changed',
  'reconciled',
  'sanitization_started',
  'sanitization_aborted',
  'sanitization_passed',
  'sanitization_failed',
  'exception_opened',
  'exception_assigned',
  'exception_unassigned',
  'retry_approved',
  'exception_resolved',
  'job_completed',
  'job_cancelled',
]

const iso = (value: Date) => value.toISOString()

function fromTransition(row: TimelineSources['transitions'][number]): TimelineEntry | null {
  const base = { at: iso(row.createdAt), actorUserId: row.actorUserId }
  switch (row.action) {
    case 'classify':
      return row.fromStatus === null
        ? {
            ...base,
            kind: 'data_bearing_decided',
            category: 'data_bearing',
            details: { dataBearingTo: row.dataBearingTo },
          }
        : {
            ...base,
            kind: 'data_bearing_changed',
            category: 'data_bearing',
            details: { dataBearingFrom: row.dataBearingFrom, dataBearingTo: row.dataBearingTo, reason: row.reason },
          }
    case 'start_run':
      return { ...base, kind: 'sanitization_started', category: 'sanitization', details: { method: row.runMethod, tool: row.runTool } }
    case 'record_pass':
      return { ...base, kind: 'sanitization_passed', category: 'sanitization', details: { method: row.runMethod, tool: row.runTool } }
    case 'record_fail':
      // A FAIL records two steps; the business event is the first one.
      return row.toStatus === 'sanitization_failed'
        ? { ...base, kind: 'sanitization_failed', category: 'sanitization', details: { tool: row.runTool, reason: row.reason } }
        : null
    case 'abort_run':
      return { ...base, kind: 'sanitization_aborted', category: 'sanitization', details: { reason: row.reason } }
    case 'approve_retry':
      return { ...base, kind: 'retry_approved', category: 'sanitization', details: { reason: row.reason } }
  }
}

const EXCEPTION_KIND: Record<ItadExceptionEventKind, TimelineKind> = {
  created: 'exception_opened',
  assigned: 'exception_assigned',
  unassigned: 'exception_unassigned',
  resolved: 'exception_resolved',
}

const JOB_KIND: Record<string, TimelineKind> = {
  start_processing: 'reconciled',
  complete: 'job_completed',
  cancel: 'job_cancelled',
}

export function buildAssetTimeline(sources: TimelineSources, visibility: TimelineVisibility): TimelineEntry[] {
  const entries: TimelineEntry[] = []
  const { asset } = sources
  entries.push({
    at: iso(asset.receivedAt),
    kind: 'received',
    category: 'receiving',
    actorUserId: asset.receivedByUserId,
    details: { scanResult: asset.firstScanResult ?? undefined },
  })
  for (const scan of sources.duplicateScans) {
    entries.push({ at: iso(scan.scannedAt), kind: 'scanned_again', category: 'receiving', actorUserId: scan.scannedByUserId, details: {} })
    if (scan.flaggedAt) {
      entries.push({
        at: iso(scan.flaggedAt),
        kind: 'duplicate_flagged',
        category: 'receiving',
        actorUserId: scan.flaggedByUserId,
        details: { reason: scan.flaggedNote },
      })
    }
    if (scan.resolvedAt) {
      entries.push({
        at: iso(scan.resolvedAt),
        kind: scan.resolution === 'different_device_set_aside' ? 'duplicate_set_aside' : 'duplicate_same_device',
        category: 'receiving',
        actorUserId: scan.resolvedByUserId,
        details: { reason: scan.resolutionNote },
      })
    }
  }
  if (asset.deletedAt) {
    entries.push({
      at: iso(asset.deletedAt),
      kind: 'voided',
      category: 'receiving',
      actorUserId: asset.deletedByUserId,
      details: { reason: asset.deleteReason },
    })
  }
  for (const row of sources.transitions) {
    const entry = fromTransition(row)
    if (!entry) continue
    if (entry.kind === 'data_bearing_decided') entry.details.dataBearingSource = asset.dataBearingSource
    entries.push(entry)
  }
  for (const event of sources.exceptionEvents) {
    entries.push({
      at: iso(event.createdAt),
      kind: EXCEPTION_KIND[event.kind],
      category: 'exception',
      actorUserId: event.actorUserId,
      details: {
        exceptionType: event.exceptionType,
        outcome: event.outcome,
        assignedToUserId: event.assignedToUserId,
        reason: event.reason,
      },
    })
  }
  for (const row of sources.jobTransitions) {
    const kind = JOB_KIND[row.action]
    // Job milestones only after the device was received (E4-054: "reconciled" = leaving receiving).
    if (!kind || row.createdAt < asset.receivedAt) continue
    entries.push({ at: iso(row.createdAt), kind, category: 'job', actorUserId: row.actorUserId, details: { reason: row.reason } })
  }

  const visible = entries.filter(
    (entry) =>
      (entry.category !== 'sanitization' || visibility.sanitization) && (entry.category !== 'exception' || visibility.exceptions),
  )
  return visible
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      if (a.entry.at !== b.entry.at) return a.entry.at < b.entry.at ? -1 : 1
      const byKind = KIND_ORDER.indexOf(a.entry.kind) - KIND_ORDER.indexOf(b.entry.kind)
      return byKind !== 0 ? byKind : a.index - b.index
    })
    .map(({ entry }) => entry)
}

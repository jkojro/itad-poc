import type { AttentionSignalKey } from '../domain/job-overview'

/**
 * Where each attention signal is resolved (operations dashboard spec "Attention model"):
 * the job tab and the filter it opens with. The panels read these filters from the URL.
 */
const SIGNAL_QUERIES: Record<AttentionSignalKey, string> = {
  failed: 'tab=sanitization&status=review_required',
  unresolved_duplicates: 'tab=exceptions&status=open&type=duplicate_serial',
  unexpected: 'tab=receiving&reconciliation=unexpected',
  missing_exceptions: 'tab=exceptions&status=open&type=missing_from_delivery',
  unexpected_exceptions: 'tab=exceptions&status=open&type=unexpected_asset',
  data_bearing_unknown: 'tab=receiving&dataBearing=unknown',
  certificates_missing: 'tab=documents',
}

export function jobHref(jobId: string, query?: string): string {
  const base = `/backend/itad/jobs/${encodeURIComponent(jobId)}`
  return query ? `${base}?${query}` : base
}

export function attentionSignalHref(jobId: string, key: AttentionSignalKey): string {
  return jobHref(jobId, SIGNAL_QUERIES[key])
}

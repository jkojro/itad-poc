import type { StatusMap } from '@open-mercato/ui/primitives/status-badge'
import { ITAD_JOB_STATUSES, type ItadJobStatus } from '../data/entities'

/** Semantic variants only — never hard-coded colors. */
export const ITAD_JOB_STATUS_VARIANTS: StatusMap<ItadJobStatus> = {
  draft: 'neutral',
  scheduled: 'info',
  in_transit: 'info',
  receiving: 'info',
  processing: 'info',
  closeout_review: 'warning',
  completed: 'success',
  on_hold: 'warning',
  cancelled: 'error',
}

export const ITAD_JOB_STATUS_FALLBACK_LABELS: Record<ItadJobStatus, string> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  in_transit: 'In transit',
  receiving: 'Receiving',
  processing: 'Processing',
  closeout_review: 'Closeout review',
  completed: 'Completed',
  on_hold: 'On hold',
  cancelled: 'Cancelled',
}

export function itadJobStatusLabelKey(status: ItadJobStatus): string {
  return `itad.jobs.status.${status}`
}

export { ITAD_JOB_STATUSES }

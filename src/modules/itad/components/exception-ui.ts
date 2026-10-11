import type { useT } from '@open-mercato/shared/lib/i18n/context'
import type { StatusBadgeVariant } from '@open-mercato/ui/primitives/status-badge'
import type { ItadExceptionEventKind, ItadExceptionOutcome, ItadExceptionStatus, ItadExceptionType } from '../domain/exceptions'

type Translate = ReturnType<typeof useT>

const TYPE_LABELS: Record<ItadExceptionType, string> = {
  missing_from_delivery: 'Missing from delivery',
  unexpected_asset: 'Unexpected device',
  duplicate_serial: 'Duplicate serial',
  sanitization_failed: 'Sanitization failed',
}

const STATUS_LABELS: Record<ItadExceptionStatus, string> = { open: 'Open', resolved: 'Resolved' }

/** Semantic variants only — never hard-coded colors. */
export const EXCEPTION_STATUS_VARIANTS: Record<ItadExceptionStatus, StatusBadgeVariant> = { open: 'warning', resolved: 'success' }

const OUTCOME_LABELS: Record<ItadExceptionOutcome, string> = {
  not_shipped: 'Not shipped by the customer',
  lost_in_transit: 'Lost in transit',
  manifest_error: 'Manifest error',
  accepted_into_job: 'Accepted into the job',
  same_device: 'Same device',
  second_device_set_aside: 'Second device set aside',
  retry_approved: 'Retry approved',
  not_data_bearing: 'Not data-bearing',
  job_cancelled: 'Job cancelled',
}

const EVENT_LABELS: Record<ItadExceptionEventKind, string> = {
  created: 'Opened by the system',
  assigned: 'Assigned',
  unassigned: 'Unassigned',
  resolved: 'Resolved',
}

export function exceptionTypeLabel(t: Translate, type: ItadExceptionType): string {
  return t(`itad.exceptions.type.${type}`, TYPE_LABELS[type])
}

export function exceptionStatusLabel(t: Translate, status: ItadExceptionStatus): string {
  return t(`itad.exceptions.status.${status}`, STATUS_LABELS[status])
}

export function exceptionOutcomeLabel(t: Translate, outcome: ItadExceptionOutcome): string {
  return t(`itad.exceptions.outcome.${outcome}`, OUTCOME_LABELS[outcome])
}

export function exceptionEventLabel(t: Translate, kind: ItadExceptionEventKind): string {
  return t(`itad.exceptions.event.${kind}`, EVENT_LABELS[kind])
}

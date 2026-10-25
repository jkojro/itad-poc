import type { StatusBadgeVariant } from '@open-mercato/ui/primitives/status-badge'
import type { InboxActionStatus, InboxActionType, InboxIntent, InboxMessageStatus, MatchStatus } from '../domain/inbox'

/** Labels and badge variants of ITAD Inbox Ops; badges always carry their text, never colour alone. */

export const INTENT_LABELS: Record<InboxIntent, string> = {
  new_pickup: 'New pickup request',
  pickup_date_change: 'Pickup date change',
  exception_clarification: 'Missing / unexpected device',
  status_inquiry: 'Status inquiry',
}

export const MESSAGE_STATUS_LABELS: Record<InboxMessageStatus, string> = {
  processing: 'Processing',
  proposed: 'Proposed',
  failed: 'Failed',
  closed: 'Closed',
}

export const MESSAGE_STATUS_VARIANTS: Record<InboxMessageStatus, StatusBadgeVariant> = {
  processing: 'info',
  proposed: 'warning',
  failed: 'error',
  closed: 'neutral',
}

export const MATCH_STATUS_LABELS: Record<MatchStatus, string> = {
  high: 'High',
  needs_review: 'Needs review',
  ambiguous: 'Ambiguous',
}

export const MATCH_STATUS_VARIANTS: Record<MatchStatus, StatusBadgeVariant> = {
  high: 'success',
  needs_review: 'warning',
  ambiguous: 'error',
}

export const ACTION_TYPE_LABELS: Record<InboxActionType, string> = {
  create_job: 'Create ITAD job',
  update_pickup: 'Change pickup date',
  resolve_exception: 'Resolve exception',
}

export const ACTION_STATUS_LABELS: Record<InboxActionStatus, string> = {
  pending: 'Pending',
  executed: 'Executed',
  rejected: 'Rejected',
  failed: 'Failed',
  superseded: 'Superseded',
}

export const FIELD_LABELS: Record<string, string> = {
  name: 'Job name',
  customerReference: 'Customer reference',
  expectedAssetEstimate: 'Expected devices',
  scheduledPickupAt: 'Pickup',
  timeZone: 'Time zone',
  pickupLocation: 'Pickup location',
  outcome: 'Outcome',
  reason: 'Reason',
}

export type Hidden = { hidden: true }
export const isHidden = (value: unknown): value is Hidden => typeof value === 'object' && value !== null && (value as Hidden).hidden === true

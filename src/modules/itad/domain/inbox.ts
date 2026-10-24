/**
 * Vocabulary of ITAD Inbox Ops (spec 2026-10-24-itad-inbox-ops): a customer email becomes
 * a proposal — intents, a match with evidence, typed actions the operator decides. Pure:
 * no framework, no database.
 */

export const INBOX_INTENTS = ['new_pickup', 'pickup_date_change', 'exception_clarification', 'status_inquiry'] as const
export type InboxIntent = (typeof INBOX_INTENTS)[number]

/** Lifecycle only; the quality of the match is the separate, derived `MatchStatus`. */
export const INBOX_MESSAGE_STATUSES = ['processing', 'proposed', 'failed', 'closed'] as const
export type InboxMessageStatus = (typeof INBOX_MESSAGE_STATUSES)[number]

export const INBOX_MESSAGE_SOURCES = ['email', 'manual'] as const
export type InboxMessageSource = (typeof INBOX_MESSAGE_SOURCES)[number]

export const INBOX_ACTION_TYPES = ['create_job', 'update_pickup', 'resolve_exception'] as const
export type InboxActionType = (typeof INBOX_ACTION_TYPES)[number]

export const INBOX_ACTION_STATUSES = ['pending', 'executed', 'rejected', 'failed', 'superseded'] as const
export type InboxActionStatus = (typeof INBOX_ACTION_STATUSES)[number]

/** An undecided action; `superseded` ones were replaced before any decision. */
export const isUndecided = (status: InboxActionStatus) => status === 'pending'

export const MATCH_STATUSES = ['high', 'needs_review', 'ambiguous'] as const
export type MatchStatus = (typeof MATCH_STATUSES)[number]

const MATCH_RANK: Record<MatchStatus, number> = { high: 0, needs_review: 1, ambiguous: 2 }

/** The message shows the worst of its parts (spec "Match status"). */
export function worstMatchStatus(statuses: MatchStatus[], fallback: MatchStatus = 'needs_review'): MatchStatus {
  if (statuses.length === 0) return fallback
  return statuses.reduce((worst, status) => (MATCH_RANK[status] > MATCH_RANK[worst] ? status : worst))
}

/** Where a piece of match evidence was found, strongest first (spec: current text > subject > history). */
export const EVIDENCE_SOURCES = ['current', 'subject', 'history', 'sender', 'forwarded_sender'] as const
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number]

/** Evidence strong enough for `high` on its own: an explicit reference in the current text or the subject. */
export const isExplicitSource = (source: EvidenceSource) => source === 'current' || source === 'subject'

export type EvidenceKind = 'job_reference' | 'customer_reference' | 'sender_email' | 'serial'

export type MatchEvidence = { kind: EvidenceKind; source: EvidenceSource; value: string }

export type Candidate = { id: string; evidence: MatchEvidence[] }

/** Provenance of an action field: the model (quote-checked), the matched record, or the operator. */
export type FieldSource = 'model' | 'match' | 'operator'

/** A model value with the text it was read from; kept only when the quote is in the email. */
export type QuotedValue<T = string> = { value: T; quote: string }

/** Executed fields need their quote in the current text, not only in the thread history. */
export const EXECUTED_FIELDS = ['scheduledPickupAt', 'expectedAssetEstimate', 'pickupLocation', 'customerReference', 'outcome', 'reason'] as const

/** A message `processing` longer than this is shown as stalled and may be reprocessed. */
export const INBOX_STALL_MS = 10 * 60 * 1000

export function isStalled(status: InboxMessageStatus, processingStartedAt: Date | null, now: Date): boolean {
  return status === 'processing' && processingStartedAt !== null && now.getTime() - processingStartedAt.getTime() > INBOX_STALL_MS
}

/** Same cap as `inbox_ops` (`INBOX_OPS_MAX_TEXT_SIZE` default). */
export const INBOX_TEXT_MAX = 204_800

export const JOB_REFERENCE_IN_TEXT = /\bITAD-\d{4}-\d{5,}\b/gi

/** The message's match: chosen customer / job, the candidates per level, and whether the operator chose. */
export type InboxMatch = {
  customerId: string | null
  customerStatus: MatchStatus
  jobId: string | null
  jobStatus: MatchStatus
  customers: Candidate[]
  jobs: Candidate[]
  overridden: boolean
}

/** What an action applies to, taken from the match; never changed by editing the action. */
export type ActionTarget = { customerId?: string; jobId?: string; exceptionId?: string }

/** One intent as the model read it: every value carries its quote from the email. */
export type ExtractedIntent = {
  intent: InboxIntent
  confidence: 'high' | 'low'
  /** Serials the customer named (I3), each with its quote. */
  serials?: QuotedValue[]
  scheduledPickup?: QuotedValue<{ localDateTime: string; timeZone: string | null }>
  expectedAssetEstimate?: QuotedValue<number>
  pickupLocation?: QuotedValue
  customerReference?: QuotedValue
  /** I1 label suggested by the model; not quote-checked, shown as a suggestion. */
  suggestedName?: string
  /** I3: `not_shipped` / `lost_in_transit` / `manifest_error` / `accepted_into_job`. */
  outcome?: QuotedValue
  reason?: QuotedValue
}

/** The model's interpretation as stored, so actions can be rebuilt without calling it again. */
export type InboxExtraction = {
  intents: ExtractedIntent[]
  summary: string
  language: string | null
}

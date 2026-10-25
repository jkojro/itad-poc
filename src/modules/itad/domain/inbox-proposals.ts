import { manualOutcomes, type ItadExceptionStatus, type ItadExceptionType } from './exceptions'
import type { JobOverviewCounters } from './job-overview'
import { normalizeSerial } from './serial'
import {
  worstMatchStatus,
  type ActionTarget,
  type ExtractedIntent,
  type FieldSource,
  type InboxActionType,
  type InboxExtraction,
  type InboxIntent,
  type MatchStatus,
  type QuotedValue,
} from './inbox'
import type { EmailParts } from './inbox-matching'

/**
 * From the model's reading of an email to typed actions (spec "Validate and propose",
 * "Intents and actions"). Code, not the model, decides what is kept: a model value
 * survives only when its quote is in the email, and a value an action would execute only
 * when its quote is in the current text. Pure.
 */

const squash = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase()

/** Where a model quote occurs: the current text, only the history, or nowhere. */
export function quoteSource(parts: EmailParts, quote: string | undefined | null): 'current' | 'history' | null {
  if (!quote) return null
  const needle = squash(quote)
  if (needle.length === 0) return null
  if (squash(parts.currentText).includes(needle) || squash(parts.subject).includes(needle)) return 'current'
  if (parts.history.some((message) => squash(message).includes(needle))) return 'history'
  return null
}

/** A value an action executes: kept only with its quote in the current text (or subject). */
function executedValue<T>(parts: EmailParts, quoted: QuotedValue<T> | undefined): { value: T | null; onlyInHistory: boolean } {
  if (!quoted) return { value: null, onlyInHistory: false }
  const source = quoteSource(parts, quoted.quote)
  if (source === 'current') return { value: quoted.value, onlyInHistory: false }
  return { value: null, onlyInHistory: source === 'history' }
}

export type JobContext = {
  id: string
  updatedAt: string
  /** Open missing / unexpected exceptions of the job, the only ones I3 may resolve. */
  exceptions: Array<{ id: string; type: ItadExceptionType; status: ItadExceptionStatus; serial: string; updatedAt: string }>
}

export type MatchLevels = {
  customer: { id: string | null; status: MatchStatus }
  job: { id: string | null; status: MatchStatus }
  jobContext: JobContext | null
}

export type ProposedAction = {
  type: InboxActionType
  target: ActionTarget
  payload: Record<string, unknown>
  fieldSources: Record<string, FieldSource>
  missingFields: string[]
  matchStatus: MatchStatus
  targetVersion: string | null
}

const REQUIRED: Record<InboxActionType, string[]> = {
  create_job: ['customerId', 'name'],
  update_pickup: ['jobId', 'scheduledPickupAt'],
  resolve_exception: ['jobId', 'exceptionId', 'outcome', 'reason'],
}

function finish(
  type: InboxActionType,
  target: ActionTarget,
  fields: Record<string, { value: unknown; source: FieldSource }>,
  levels: MatchStatus[],
  flags: { lowConfidence: boolean; historyOnly: boolean },
  targetVersion: string | null,
): ProposedAction {
  const payload: Record<string, unknown> = {}
  const fieldSources: Record<string, FieldSource> = {}
  for (const [key, field] of Object.entries(fields)) {
    if (field.value === null || field.value === undefined || field.value === '') continue
    payload[key] = field.value
    fieldSources[key] = field.source
  }
  const present = { ...target, ...payload } as Record<string, unknown>
  const missingFields = REQUIRED[type].filter((key) => present[key] === undefined || present[key] === null || present[key] === '')
  const quality: MatchStatus[] = [...levels]
  if (missingFields.length > 0 || flags.lowConfidence || flags.historyOnly) quality.push('needs_review')
  return { type, target, payload, fieldSources, missingFields, matchStatus: worstMatchStatus(quality, 'high'), targetVersion }
}

function createJobAction(parts: EmailParts, intent: ExtractedIntent, levels: MatchLevels): ProposedAction {
  const reference = executedValue(parts, intent.customerReference)
  const estimate = executedValue(parts, intent.expectedAssetEstimate)
  const location = executedValue(parts, intent.pickupLocation)
  const pickup = executedValue(parts, intent.scheduledPickup)
  return finish(
    'create_job',
    levels.customer.id ? { customerId: levels.customer.id } : {},
    {
      name: { value: intent.suggestedName?.trim() || null, source: 'model' },
      customerReference: { value: reference.value, source: 'model' },
      expectedAssetEstimate: { value: estimate.value, source: 'model' },
      pickupLocation: { value: location.value, source: 'model' },
      scheduledPickupAt: { value: pickup.value?.localDateTime ?? null, source: 'model' },
      timeZone: { value: pickup.value?.timeZone ?? null, source: 'model' },
    },
    [levels.customer.status],
    {
      lowConfidence: intent.confidence === 'low',
      historyOnly: [reference, estimate, location, pickup].some((value) => value.onlyInHistory),
    },
    null,
  )
}

function updatePickupAction(parts: EmailParts, intent: ExtractedIntent, levels: MatchLevels): ProposedAction {
  const pickup = executedValue(parts, intent.scheduledPickup)
  return finish(
    'update_pickup',
    levels.job.id ? { jobId: levels.job.id } : {},
    {
      scheduledPickupAt: { value: pickup.value?.localDateTime ?? null, source: 'model' },
      timeZone: { value: pickup.value?.timeZone ?? null, source: 'model' },
    },
    [levels.job.status],
    { lowConfidence: intent.confidence === 'low', historyOnly: pickup.onlyInHistory },
    levels.jobContext?.updatedAt ?? null,
  )
}

/**
 * I3: one action per open missing / unexpected exception the customer named by serial.
 * A serial quoted in the current text pins its exception (high when the job is high);
 * a serial matching several exceptions, or none, leaves the exception for the operator.
 */
function resolveExceptionActions(parts: EmailParts, intent: ExtractedIntent, levels: MatchLevels): ProposedAction[] {
  const outcome = executedValue(parts, intent.outcome)
  const reason = executedValue(parts, intent.reason)
  const open = (levels.jobContext?.exceptions ?? []).filter(
    (exception) => exception.status === 'open' && (exception.type === 'missing_from_delivery' || exception.type === 'unexpected_asset'),
  )
  const named = (intent.serials ?? [])
    .map((serial) => ({ serial, source: quoteSource(parts, serial.quote) }))
    .filter((entry) => entry.source !== null)
  const targets = named.length > 0 ? named : [{ serial: null, source: null }]
  const seen = new Set<string>()
  const actions: ProposedAction[] = []
  for (const entry of targets) {
    const matches = entry.serial ? open.filter((exception) => normalizeSerial(exception.serial) === normalizeSerial(entry.serial!.value)) : []
    const exception = matches.length === 1 ? matches[0] : null
    if (exception && seen.has(exception.id)) continue
    if (exception) seen.add(exception.id)
    const exceptionStatus: MatchStatus =
      matches.length > 1 ? 'ambiguous' : exception && entry.source === 'current' ? 'high' : 'needs_review'
    const allowed = exception ? (manualOutcomes(exception.type) as readonly string[]).includes(String(outcome.value ?? '')) : true
    actions.push(
      finish(
        'resolve_exception',
        { ...(levels.job.id ? { jobId: levels.job.id } : {}), ...(exception ? { exceptionId: exception.id } : {}) },
        {
          outcome: { value: allowed ? outcome.value : null, source: 'model' },
          reason: { value: reason.value, source: 'model' },
        },
        [levels.job.status, exceptionStatus],
        { lowConfidence: intent.confidence === 'low', historyOnly: outcome.onlyInHistory || reason.onlyInHistory },
        exception?.updatedAt ?? null,
      ),
    )
  }
  return actions
}

/** The actions an extraction proposes, in the model's order of intents; I4 proposes none. */
export function buildActions(parts: EmailParts, extraction: InboxExtraction, levels: MatchLevels): ProposedAction[] {
  const actions: ProposedAction[] = []
  for (const intent of extraction.intents) {
    if (intent.intent === 'new_pickup') actions.push(createJobAction(parts, intent, levels))
    else if (intent.intent === 'pickup_date_change') actions.push(updatePickupAction(parts, intent, levels))
    else if (intent.intent === 'exception_clarification') actions.push(...resolveExceptionActions(parts, intent, levels))
  }
  return actions
}

/** Intents in the model's order, without duplicates. */
export function orderedIntents(extraction: InboxExtraction): InboxIntent[] {
  return Array.from(new Set(extraction.intents.map((intent) => intent.intent)))
}

/** The message's match status: the worst of its actions, or of its customer / job match when it has none. */
export function messageMatchStatus(actions: Array<{ matchStatus: MatchStatus }>, levels: Pick<MatchLevels, 'customer' | 'job'>): MatchStatus {
  if (actions.length > 0) return worstMatchStatus(actions.map((action) => action.matchStatus))
  // A chosen job — or several candidate jobs — decide; only without any job evidence does the customer.
  return levels.job.id || levels.job.status === 'ambiguous' ? levels.job.status : levels.customer.status
}

/**
 * What a customer may read about why their job is not finished (spec "Draft reply"):
 * categories and counts from the job's counters, never notes, people or exception reasons.
 */
export type CustomerSafeBlocker = { key: 'awaiting_devices' | 'awaiting_erasure' | 'erasure_failed' | 'awaiting_certificates'; count: number }

export function customerSafeBlockers(counters: JobOverviewCounters): CustomerSafeBlocker[] {
  const blockers: CustomerSafeBlocker[] = []
  if (counters.missing > 0) blockers.push({ key: 'awaiting_devices', count: counters.missing })
  if (counters.awaitingWipe > 0) blockers.push({ key: 'awaiting_erasure', count: counters.awaitingWipe })
  if (counters.failed > 0) blockers.push({ key: 'erasure_failed', count: counters.failed })
  if (counters.certificatesMissing > 0) blockers.push({ key: 'awaiting_certificates', count: counters.certificatesMissing })
  return blockers
}

/** Required values still missing for an action, from its target and fields. */
export function missingFieldsOf(type: InboxActionType, target: ActionTarget, payload: Record<string, unknown>): string[] {
  const present = { ...target, ...payload } as Record<string, unknown>
  return REQUIRED[type].filter((key) => present[key] === undefined || present[key] === null || present[key] === '')
}

/** Target keys never change through an edit (spec "Target vs fields"); only the Match panel moves them. */
export const TARGET_KEYS = ['customerId', 'jobId', 'exceptionId'] as const

export type PreviousAction = { type: InboxActionType; payload: Record<string, unknown>; fieldSources: Record<string, FieldSource> }

/**
 * Actions rebuilt after the operator chose the match (spec "Match status", Match panel):
 * the stored extraction with the new levels — no model call — keeping the fields the
 * operator edited on the action of the same type and position. A target the operator
 * picked explicitly (an exception for an I3 action) is taken as confirmed: high.
 */
export function rebuildActions(
  parts: EmailParts,
  extraction: InboxExtraction,
  levels: MatchLevels,
  previous: PreviousAction[],
  chosenExceptions: Array<string | null> = [],
): ProposedAction[] {
  const rebuilt = buildActions(parts, extraction, levels)
  const seenByType = new Map<InboxActionType, number>()
  return rebuilt.map((action) => {
    const index = seenByType.get(action.type) ?? 0
    seenByType.set(action.type, index + 1)
    const before = previous.filter((entry) => entry.type === action.type)[index]
    const payload = { ...action.payload }
    const fieldSources = { ...action.fieldSources }
    if (before) {
      for (const [key, source] of Object.entries(before.fieldSources)) {
        if (source !== 'operator') continue
        payload[key] = before.payload[key]
        fieldSources[key] = 'operator'
      }
    }
    let target = action.target
    let matchStatus = action.matchStatus
    let targetVersion = action.targetVersion
    if (action.type === 'resolve_exception') {
      const chosen = chosenExceptions[index]
      const exception = chosen ? levels.jobContext?.exceptions.find((entry) => entry.id === chosen && entry.status === 'open') : null
      if (exception) {
        target = { ...target, exceptionId: exception.id }
        targetVersion = exception.updatedAt
        matchStatus = levels.job.status
      }
    }
    const missingFields = missingFieldsOf(action.type, target, payload)
    return {
      ...action,
      target,
      payload,
      fieldSources,
      missingFields,
      targetVersion,
      matchStatus: missingFields.length > 0 && matchStatus === 'high' ? 'needs_review' : matchStatus,
    }
  })
}

/** A message is closed once it has actions and every live one is decided. */
export function isFullyDecided(statuses: Array<'pending' | 'executed' | 'rejected' | 'failed' | 'superseded'>): boolean {
  const live = statuses.filter((status) => status !== 'superseded')
  return live.length > 0 && live.every((status) => status !== 'pending')
}

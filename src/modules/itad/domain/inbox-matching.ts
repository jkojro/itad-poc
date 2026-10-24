import {
  JOB_REFERENCE_IN_TEXT,
  isExplicitSource,
  type Candidate,
  type EvidenceSource,
  type MatchEvidence,
  type MatchStatus,
} from './inbox'

/**
 * Deterministic matching of ITAD Inbox Ops (spec "Match", "Match status"): evidence comes
 * from the email in a fixed rank — current text > subject > quoted history — and from the
 * sender. The model never decides a match. Pure.
 */

export type EmailParts = { currentText: string; subject: string; history: string[] }

/** Job references (`ITAD-YYYY-NNNNN`) with where each was found, strongest source first, de-duplicated. */
export function findJobReferences(parts: EmailParts): Array<{ reference: string; source: EvidenceSource }> {
  const seen = new Map<string, EvidenceSource>()
  const scan = (text: string, source: EvidenceSource) => {
    for (const match of text.matchAll(JOB_REFERENCE_IN_TEXT)) {
      const reference = match[0].toUpperCase()
      if (!seen.has(reference)) seen.set(reference, source)
    }
  }
  scan(parts.currentText, 'current')
  scan(parts.subject, 'subject')
  for (const message of parts.history) scan(message, 'history')
  return Array.from(seen, ([reference, source]) => ({ reference, source }))
}

/** Where a literal value (a customer reference, a serial) occurs, strongest source first; null when nowhere. */
export function locateValue(parts: EmailParts, value: string): EvidenceSource | null {
  const needle = value.trim().toLowerCase()
  if (needle.length < 3) return null
  if (parts.currentText.toLowerCase().includes(needle)) return 'current'
  if (parts.subject.toLowerCase().includes(needle)) return 'subject'
  if (parts.history.some((message) => message.toLowerCase().includes(needle))) return 'history'
  return null
}

export type ThreadEntry = { from: string | null; fromName: string | null; body: string; isForwarded: boolean }

/**
 * The customer sender (spec "Forwarded mail"): only a forward made by a recognized user of
 * the organization replaces the envelope sender with the forwarded message's sender (and
 * its body becomes the request). Any other forward keeps the envelope sender; the forwarded
 * sender is then only evidence.
 */
export function resolveCustomerSender(input: {
  envelope: { address: string; name: string | null }
  currentText: string
  thread: ThreadEntry[]
  envelopeIsOrganizationUser: boolean
}): {
  customer: { address: string; name: string | null }
  currentText: string
  forwardedByOrganizationUser: boolean
  forwardedSender: { address: string; name: string | null } | null
  /** Thread entries other than the current message and the one used as the request. */
  history: ThreadEntry[]
} {
  const forwardedIndex = input.thread.findIndex((entry) => entry.isForwarded && entry.from)
  const forwarded = forwardedIndex >= 0 ? input.thread[forwardedIndex] : null
  const forwardedSender = forwarded?.from ? { address: forwarded.from.toLowerCase(), name: forwarded.fromName } : null
  // The first thread entry is the current message itself; the rest is history.
  if (forwarded && forwardedSender && input.envelopeIsOrganizationUser) {
    const history = input.thread.filter((_, index) => index !== 0 && index !== forwardedIndex)
    return { customer: forwardedSender, currentText: forwarded.body, forwardedByOrganizationUser: true, forwardedSender, history }
  }
  // A forward from outside the organization stays in the history (with its flag): evidence only.
  const history = input.thread.filter((_, index) => index !== 0)
  return {
    customer: { address: input.envelope.address.toLowerCase(), name: input.envelope.name },
    currentText: input.currentText,
    forwardedByOrganizationUser: false,
    forwardedSender,
    history,
  }
}

/** Merges evidence per record id, keeping every piece. */
export function mergeCandidates(entries: Array<{ id: string; evidence: MatchEvidence }>): Candidate[] {
  const byId = new Map<string, MatchEvidence[]>()
  for (const entry of entries) byId.set(entry.id, [...(byId.get(entry.id) ?? []), entry.evidence])
  return Array.from(byId, ([id, evidence]) => ({ id, evidence }))
}

const isStrong = (candidate: Candidate) =>
  candidate.evidence.some(
    (evidence) => (evidence.kind === 'job_reference' || evidence.kind === 'customer_reference' || evidence.kind === 'serial') && isExplicitSource(evidence.source),
  )

/**
 * One level of a match (customer, job, exception): which record it is, and how sure.
 * - one candidate backed by an explicit reference in the current text or subject → high;
 * - one candidate backed only by heuristics (sender, quoted history, forwarded sender) → needs review;
 * - several candidates → ambiguous, unless exactly one of them has explicit evidence
 *   (an explicit reference wins over heuristics);
 * - none → needs review with no record.
 */
export function decideLevel(candidates: Candidate[]): { id: string | null; status: MatchStatus } {
  if (candidates.length === 0) return { id: null, status: 'needs_review' }
  const strong = candidates.filter(isStrong)
  if (strong.length === 1) return { id: strong[0].id, status: 'high' }
  if (strong.length > 1) return { id: null, status: 'ambiguous' }
  if (candidates.length === 1) return { id: candidates[0].id, status: 'needs_review' }
  return { id: null, status: 'ambiguous' }
}

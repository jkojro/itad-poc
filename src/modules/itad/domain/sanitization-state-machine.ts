import type { ItadAssetHistoryStatus, ItadAssetStatus, ItadJobStatus } from './job-types'

/**
 * Sanitization lifecycle of one data-bearing asset (sanitization spec "Transitions",
 * Q3–Q8). Pure. Classification lives in `data-bearing.ts`; this file owns the run
 * actions. Every run action needs the job in `processing` (Q5): a held job keeps its
 * open runs until it resumes.
 */

/** NIST SP 800-88 sanitization levels (Q6). */
export const ITAD_SANITIZATION_METHODS = ['clear', 'purge', 'destroy'] as const
export type ItadSanitizationMethod = (typeof ITAD_SANITIZATION_METHODS)[number]

/** How the result was verified (Q7). */
export const ITAD_VERIFICATION_METHODS = ['full_verification', 'sample_verification', 'visual_inspection', 'none'] as const
export type ItadVerificationMethod = (typeof ITAD_VERIFICATION_METHODS)[number]

/** Result of a finished run; `null` on the row while the run is open. */
export const ITAD_RUN_RESULTS = ['PASS', 'FAIL', 'ABORTED'] as const
export type ItadRunResult = (typeof ITAD_RUN_RESULTS)[number]

/** Abort reason code written when the job is cancelled with an open run (localized in the UI). */
export const JOB_CANCELLED_ABORT_REASON = 'job_cancelled'

export type RunAction = 'start_run' | 'record_pass' | 'record_fail' | 'abort_run' | 'approve_retry'

type Step = { from: ItadAssetHistoryStatus; to: ItadAssetHistoryStatus }

/**
 * The asset status steps an action records, in order. FAIL records two steps in one
 * transaction (`sanitization_failed` is a transition state, never stored on the asset).
 */
const STEPS: Record<RunAction, { from: ItadAssetStatus; steps: Step[] }> = {
  start_run: { from: 'sanitization_required', steps: [{ from: 'sanitization_required', to: 'sanitization_in_progress' }] },
  record_pass: { from: 'sanitization_in_progress', steps: [{ from: 'sanitization_in_progress', to: 'sanitized' }] },
  record_fail: {
    from: 'sanitization_in_progress',
    steps: [
      { from: 'sanitization_in_progress', to: 'sanitization_failed' },
      { from: 'sanitization_failed', to: 'review_required' },
    ],
  },
  abort_run: { from: 'sanitization_in_progress', steps: [{ from: 'sanitization_in_progress', to: 'sanitization_required' }] },
  approve_retry: { from: 'review_required', steps: [{ from: 'review_required', to: 'sanitization_required' }] },
}

export type RunActionRefusal = 'processing_required' | 'asset_transition_not_allowed'

export type RunActionDecision =
  | { ok: true; steps: Step[]; toStatus: ItadAssetStatus }
  | { ok: false; code: RunActionRefusal }

/** Whether `action` may run for an asset in `assetStatus` while the job is in `jobStatus`. */
export function decideRunAction(input: {
  jobStatus: ItadJobStatus
  assetStatus: ItadAssetStatus
  action: RunAction
}): RunActionDecision {
  if (input.jobStatus !== 'processing') return { ok: false, code: 'processing_required' }
  const rule = STEPS[input.action]
  if (input.assetStatus !== rule.from) return { ok: false, code: 'asset_transition_not_allowed' }
  const last = rule.steps[rule.steps.length - 1].to
  return { ok: true, steps: rule.steps, toStatus: last as ItadAssetStatus }
}

export const SANITIZATION_TEXT_LIMITS = {
  tool: 200,
  toolVersion: 100,
  methodDetail: 500,
  verificationNotes: 2000,
} as const

/** Verification notes are required for FAIL (Q7) and optional for PASS. */
export function verificationNotesRequired(result: Exclude<ItadRunResult, 'ABORTED'>): boolean {
  return result === 'FAIL'
}

/**
 * Evidence may be linked to started or finished runs while the job is not terminal
 * (append-only; a finished run is otherwise immutable).
 */
export function canAttachEvidence(jobStatus: ItadJobStatus): boolean {
  return jobStatus !== 'completed' && jobStatus !== 'cancelled'
}

import type { useT } from '@open-mercato/shared/lib/i18n/context'
import type { StatusBadgeVariant } from '@open-mercato/ui/primitives/status-badge'
import type { ItadAssetHistoryStatus, ItadAssetTransitionAction } from '../domain/job-types'
import {
  JOB_CANCELLED_ABORT_REASON,
  type ItadRunResult,
  type ItadSanitizationMethod,
  type ItadVerificationMethod,
} from '../domain/sanitization-state-machine'
import { assetStatusLabel } from './data-bearing-ui'

type Translate = ReturnType<typeof useT>

const METHOD_LABELS: Record<ItadSanitizationMethod, string> = {
  clear: 'Clear (NIST 800-88)',
  purge: 'Purge (NIST 800-88)',
  destroy: 'Destroy (NIST 800-88)',
}

const VERIFICATION_LABELS: Record<ItadVerificationMethod, string> = {
  full_verification: 'Full verification',
  sample_verification: 'Sample verification',
  visual_inspection: 'Visual inspection',
  none: 'No verification',
}

const RESULT_LABELS: Record<ItadRunResult | 'OPEN', string> = {
  PASS: 'Passed',
  FAIL: 'Failed',
  ABORTED: 'Aborted',
  OPEN: 'In progress',
}

/** Semantic variants only — never hard-coded colors. */
export const RUN_RESULT_VARIANTS: Record<ItadRunResult | 'OPEN', StatusBadgeVariant> = {
  PASS: 'success',
  FAIL: 'error',
  ABORTED: 'neutral',
  OPEN: 'info',
}

const ACTION_LABELS: Record<ItadAssetTransitionAction, string> = {
  classify: 'Classification',
  start_run: 'Run started',
  record_pass: 'Passed',
  record_fail: 'Failed',
  abort_run: 'Run aborted',
  approve_retry: 'Retry approved',
}

export function methodLabel(t: Translate, method: ItadSanitizationMethod): string {
  return t(`itad.sanitization.method.${method}`, METHOD_LABELS[method])
}

export function verificationLabel(t: Translate, method: ItadVerificationMethod): string {
  return t(`itad.sanitization.verification.${method}`, VERIFICATION_LABELS[method])
}

export function runResultLabel(t: Translate, result: ItadRunResult | null): string {
  const key = result ?? 'OPEN'
  return t(`itad.sanitization.result.${key}`, RESULT_LABELS[key])
}

export function historyActionLabel(t: Translate, action: ItadAssetTransitionAction): string {
  return t(`itad.sanitization.historyAction.${action}`, ACTION_LABELS[action])
}

/** History statuses include the transition state `sanitization_failed`. */
export function historyStatusLabel(t: Translate, status: ItadAssetHistoryStatus): string {
  if (status === 'sanitization_failed') return t('itad.assets.status.sanitization_failed', 'Sanitization failed')
  return assetStatusLabel(t, status)
}

/** The system abort reason is a code; anything else is the operator's text. */
export function abortReasonLabel(t: Translate, reason: string | null): string | null {
  if (!reason) return null
  return reason === JOB_CANCELLED_ABORT_REASON ? t('itad.sanitization.abortReason.job_cancelled', 'Job cancelled') : reason
}

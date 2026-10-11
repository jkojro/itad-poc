import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { itadSanitizationError, type ItadSanitizationErrorCode } from './errors'

/** Translated sanitization errors (`itad.sanitization.errors.*`) shared by routes and commands. */
const SANITIZATION_ERROR_MESSAGES: Record<ItadSanitizationErrorCode, string> = {
  processing_required: 'Sanitization runs are possible only while the job is in processing',
  asset_transition_not_allowed: 'This action is not possible in the current status of the device',
  run_closed: 'This sanitization run is already finished',
  verification_notes_required: 'Describe what failed in the verification notes',
  reason_required: 'Enter a reason (3–1000 characters)',
  job_terminal: 'Evidence cannot be added to a completed or cancelled job',
  evidence_file_required: 'Choose a file to attach',
  runs_not_found: 'Some selected sanitization runs no longer exist in this job. Refresh the list',
  forbidden: 'You do not have permission for this action',
}

export async function sanitizationError(
  status: 400 | 403 | 409,
  code: ItadSanitizationErrorCode,
  details?: Record<string, unknown>,
): Promise<never> {
  const { translate } = await resolveTranslations()
  throw itadSanitizationError(status, code, translate(`itad.sanitization.errors.${code}`, SANITIZATION_ERROR_MESSAGES[code]), details)
}

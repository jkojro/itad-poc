import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { itadExceptionError, type ItadExceptionErrorCode } from './errors'

/** Translated exception errors (`itad.exceptions.errors.*`) shared by routes and commands. */
const EXCEPTION_ERROR_MESSAGES: Record<ItadExceptionErrorCode, string> = {
  exception_resolved: 'This exception is already resolved',
  resolve_through_domain_action: 'This exception is resolved by its own action (same device, set aside, or retry)',
  outcome_invalid: 'Choose an outcome allowed for this exception type',
  reason_required: 'Enter a reason (3–1000 characters)',
  assignee_invalid: 'Choose an active user of this organization',
}

export async function exceptionError(status: 400 | 409, code: ItadExceptionErrorCode): Promise<never> {
  const { translate } = await resolveTranslations()
  throw itadExceptionError(status, code, translate(`itad.exceptions.errors.${code}`, EXCEPTION_ERROR_MESSAGES[code]))
}

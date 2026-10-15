import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { itadCertificateError, type ItadCertificateErrorCode } from './errors'

/** Translated certificate errors (`itad.certificates.errors.*`) shared by routes and commands. */
const CERTIFICATE_ERROR_MESSAGES: Record<ItadCertificateErrorCode, string> = {
  certificate_not_eligible: 'A certificate cannot be issued for this device now',
  certificate_already_issued: 'This device already has a valid certificate. Reissue it to correct it',
  certificate_unprintable_characters: 'Some values contain characters the certificate cannot print. Nothing was issued',
  certificate_not_found: 'Certificate not found',
  locale_invalid: 'Choose the certificate language',
  media_identifiers_invalid: 'Enter at most 10 media identifiers of up to 100 characters each',
}

const STATUS: Record<ItadCertificateErrorCode, 400 | 404 | 409 | 422> = {
  certificate_not_eligible: 409,
  certificate_already_issued: 409,
  certificate_unprintable_characters: 422,
  certificate_not_found: 404,
  locale_invalid: 400,
  media_identifiers_invalid: 400,
}

export async function certificateError(code: ItadCertificateErrorCode, details?: Record<string, unknown>): Promise<never> {
  const { translate } = await resolveTranslations()
  throw itadCertificateError(STATUS[code], code, translate(`itad.certificates.errors.${code}`, CERTIFICATE_ERROR_MESSAGES[code]), details)
}

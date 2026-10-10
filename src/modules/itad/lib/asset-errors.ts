import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { itadAssetError, type ItadAssetErrorCode } from './errors'

/** Translated receiving/asset errors (`itad.assets.errors.*`) shared by asset routes and commands. */
const ASSET_ERROR_MESSAGES: Record<ItadAssetErrorCode, string> = {
  receiving_not_active: 'Scanning and duplicate handling are possible only while the job is in receiving',
  assets_locked: 'Assets can be changed only while the job is in receiving',
  serial_missing: 'Enter or scan a serial number',
  serial_too_long: 'The serial number is longer than 100 characters',
  serial_conflict: 'This serial was just registered by another scan. Scan it again',
  scan_not_resolvable: 'This scan is not a pending duplicate',
  note_required: 'Enter a note (3–1000 characters) saying where the device is',
  reason_required: 'Enter a reason (3–1000 characters)',
  field_not_writable: 'The serial number and status cannot be changed; remove the asset and scan again',
  serial_too_short: 'Enter at least 3 characters of the serial number',
  sanitization_in_progress: 'A sanitization run is in progress for this device; finish or abort it first',
  sanitization_not_possible: 'In closeout review a device can no longer be marked as carrying data, because sanitization is possible only in processing',
  data_bearing_cannot_be_unset: 'Once decided, "Carries data" can be changed to Yes or No, not back to Not determined',
  assets_not_found: 'Some selected assets no longer exist in this job. Refresh the list',
}

export async function assetError(
  status: 400 | 409,
  code: ItadAssetErrorCode,
  fieldErrors?: Record<string, string>,
  details?: Record<string, unknown>,
): Promise<never> {
  const { translate } = await resolveTranslations()
  throw itadAssetError(status, code, translate(`itad.assets.errors.${code}`, ASSET_ERROR_MESSAGES[code]), fieldErrors, details)
}

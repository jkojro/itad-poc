import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { canChangeManifest, type ManifestRulesJob } from '../domain/manifest-rules'
import { itadManifestError, type ItadManifestErrorCode } from './errors'

/** Translated manifest errors (`itad.manifest.errors.*`) shared by manifest routes and commands. */
const MANIFEST_ERROR_MESSAGES: Record<ItadManifestErrorCode, string> = {
  manifest_locked: 'The manifest can no longer be changed in the current job status',
  file_required: 'Choose a CSV or XLSX file to import',
  file_unreadable: 'The file could not be read',
  file_type_unsupported: 'Only CSV and XLSX files are supported',
  sheet_not_found: 'The selected sheet is not in the workbook',
  file_too_large: 'The file is larger than 10 MB',
  file_empty: 'The file has no data rows',
  too_many_rows: 'The file has more than 5,000 data rows',
  too_many_columns: 'The file has more than 100 columns',
  file_changed: 'The file changed since the preview. Preview it again',
  mapping_invalid: 'Map the serial number column to a column of the file',
  manifest_rows_invalid: 'Some rows are invalid. Fix the file and import it again',
  warnings_not_accepted: 'Review and accept the warnings before importing',
  manifest_already_imported: 'This file has already been imported into this job',
  reason_required: 'Enter a reason (3–1000 characters); it is required while the job is in receiving',
}

export async function manifestError(
  status: 400 | 409,
  code: ItadManifestErrorCode,
  extra?: Record<string, unknown>,
): Promise<never> {
  const { translate } = await resolveTranslations()
  throw itadManifestError(status, code, translate(`itad.manifest.errors.${code}`, MANIFEST_ERROR_MESSAGES[code]), extra)
}

export async function assertManifestEditable(job: ManifestRulesJob): Promise<void> {
  if (!canChangeManifest(job)) await manifestError(409, 'manifest_locked')
}


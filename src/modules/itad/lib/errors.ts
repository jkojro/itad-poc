import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'

export const ITAD_JOB_ERROR_PREFIX = 'itad.jobs.errors.'

export type ItadJobErrorCode =
  | 'organization_required'
  | 'tenant_required'
  | 'not_found'
  | 'delete_not_draft'
  | 'terminal'
  | 'field_not_writable'
  | 'field_locked'
  | 'customer_invalid'
  | 'customer_reference_taken'
  | 'reference_conflict'
  | 'transition_not_allowed'
  | 'reason_required'
  | 'comment_required'
  | 'confirmation_duplicate'
  | 'confirmation_not_allowed'
  | 'confirmation_not_required'
  | 'condition_unmet'

/**
 * Builds the module's coded error. The body keeps the platform `{ error }` shape and
 * adds a stable `code` (the translation key) plus optional `fieldErrors`, which the
 * shared `CrudForm` server-error adapter maps onto the matching inputs.
 *
 * Plain 404s still go through the shared `notFound` helper; this is only for errors
 * the spec's error catalog gives a code.
 */
export function itadJobError(
  status: 400 | 409,
  code: ItadJobErrorCode,
  message: string,
  fieldErrors?: Record<string, string>,
  extra?: Record<string, unknown>,
): CrudHttpError {
  return new CrudHttpError(status, {
    error: message,
    code: `${ITAD_JOB_ERROR_PREFIX}${code}`,
    ...(fieldErrors ? { fieldErrors } : {}),
    ...(extra ?? {}),
  })
}

export const ITAD_MANIFEST_ERROR_PREFIX = 'itad.manifest.errors.'

export type ItadManifestErrorCode =
  | 'manifest_locked'
  | 'file_required'
  | 'file_unreadable'
  | 'file_type_unsupported'
  | 'file_too_large'
  | 'file_empty'
  | 'sheet_not_found'
  | 'too_many_rows'
  | 'too_many_columns'
  | 'file_changed'
  | 'mapping_invalid'
  | 'manifest_rows_invalid'
  | 'warnings_not_accepted'
  | 'manifest_already_imported'
  | 'reason_required'

/** Coded manifest error; same body shape as `itadJobError`, with the manifest key prefix. */
export function itadManifestError(
  status: 400 | 409,
  code: ItadManifestErrorCode,
  message: string,
  extra?: Record<string, unknown>,
): CrudHttpError {
  return new CrudHttpError(status, {
    error: message,
    code: `${ITAD_MANIFEST_ERROR_PREFIX}${code}`,
    ...(extra ?? {}),
  })
}

export const ITAD_ASSET_ERROR_PREFIX = 'itad.assets.errors.'

export type ItadAssetErrorCode =
  | 'receiving_not_active'
  | 'assets_locked'
  | 'serial_missing'
  | 'serial_too_long'
  | 'serial_conflict'
  | 'scan_not_resolvable'
  | 'note_required'
  | 'reason_required'
  | 'field_not_writable'
  | 'serial_too_short'
  | 'sanitization_in_progress'
  | 'sanitization_not_possible'
  | 'data_bearing_cannot_be_unset'
  | 'assets_not_found'

/** Coded receiving/asset error; same body shape as `itadJobError`, with the asset key prefix. */
export function itadAssetError(
  status: 400 | 409,
  code: ItadAssetErrorCode,
  message: string,
  fieldErrors?: Record<string, string>,
  /** Extra body fields, e.g. `assetIds` blocking a bulk request. */
  details?: Record<string, unknown>,
): CrudHttpError {
  return new CrudHttpError(status, {
    ...(details ?? {}),
    error: message,
    code: `${ITAD_ASSET_ERROR_PREFIX}${code}`,
    ...(fieldErrors ? { fieldErrors } : {}),
  })
}

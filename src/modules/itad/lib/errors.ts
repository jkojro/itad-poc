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
): CrudHttpError {
  return new CrudHttpError(status, {
    error: message,
    code: `${ITAD_JOB_ERROR_PREFIX}${code}`,
    ...(fieldErrors ? { fieldErrors } : {}),
  })
}

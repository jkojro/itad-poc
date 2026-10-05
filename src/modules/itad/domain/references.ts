/**
 * Business format of ITAD references. Pure — no database or framework access; the
 * number itself is issued by `services/job-reference-generator.ts`.
 */
export const JOB_REFERENCE_PREFIX = 'ITAD'
const MIN_DIGITS = 5

/** `ITAD-2026-00042`; numbers above 99999 widen instead of wrapping. */
export function formatJobReference(year: number, value: number): string {
  return `${JOB_REFERENCE_PREFIX}-${year}-${String(value).padStart(MIN_DIGITS, '0')}`
}

/** Reference year is the UTC year of the same instant written to `created_at`. */
export function referenceYearOf(at: Date): number {
  return at.getUTCFullYear()
}

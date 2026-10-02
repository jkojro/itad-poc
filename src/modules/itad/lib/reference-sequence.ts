import type { EntityManager } from '@mikro-orm/postgresql'

export const JOB_REFERENCE_PREFIX = 'ITAD'
export const JOB_REFERENCE_KIND = 'job'
const MIN_DIGITS = 5

/** `ITAD-2026-00042`; numbers above 99999 widen instead of wrapping. */
export function formatJobReference(year: number, value: number): string {
  return `${JOB_REFERENCE_PREFIX}-${year}-${String(value).padStart(MIN_DIGITS, '0')}`
}

/** Reference year is the UTC year of the same instant written to `created_at`. */
export function referenceYearOf(at: Date): number {
  return at.getUTCFullYear()
}

type SequenceRow = { last_value: number | string }

/**
 * Atomically issues the next number for `(tenant, organization, kind, year)`.
 *
 * MUST run on the EntityManager that holds the job-create transaction: the upsert
 * takes a row lock until commit, so concurrent creates in one organization
 * serialize here, and a rolled-back create rolls the increment back with it.
 * `em.execute` runs inside that EntityManager's transaction context.
 */
export async function allocateSequenceValue(
  em: EntityManager,
  scope: { tenantId: string; organizationId: string },
  kind: string,
  year: number,
): Promise<number> {
  const row = await em.execute<SequenceRow>(
    `insert into "itad_reference_sequences" ("id", "tenant_id", "organization_id", "kind", "year", "last_value", "updated_at")
     values (gen_random_uuid(), ?, ?, ?, ?, 1, now())
     on conflict ("tenant_id", "organization_id", "kind", "year")
     do update set "last_value" = "itad_reference_sequences"."last_value" + 1, "updated_at" = now()
     returning "last_value"`,
    [scope.tenantId, scope.organizationId, kind, year],
    'get',
  )
  const value = Number(row?.last_value)
  if (!Number.isInteger(value) || value < 1) {
    throw new Error('[internal] ITAD reference sequence returned no value')
  }
  return value
}

export async function allocateJobReference(
  em: EntityManager,
  scope: { tenantId: string; organizationId: string },
  at: Date,
): Promise<string> {
  const year = referenceYearOf(at)
  const value = await allocateSequenceValue(em, scope, JOB_REFERENCE_KIND, year)
  return formatJobReference(year, value)
}

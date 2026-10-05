import type { EntityManager } from '@mikro-orm/postgresql'
import { formatJobReference, referenceYearOf } from '../domain/references'

/** Sequence kind for job references (room for later document numbering). */
export const JOB_REFERENCE_KIND = 'job'

type SequenceRow = { last_value: number | string }

/**
 * Atomically issues the next number for `(tenant, organization, kind, year)`.
 *
 * Transaction contract: `em` MUST be the EntityManager of the calling command's open
 * transaction (inside `withAtomicFlush(..., { transaction: true })`). The generator never
 * resolves an EntityManager itself — it is deliberately not a DI service — so the
 * sequence increment and the INSERT that consumes the number can never end up in two
 * transactions. The upsert holds the sequence row lock until commit; a rolled-back
 * create rolls the increment back with it, so an issued number is never handed out twice.
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

/** Issues the next `ITAD-{YYYY}-{NNNNN}` reference; same transaction contract as above. */
export async function allocateJobReference(
  em: EntityManager,
  scope: { tenantId: string; organizationId: string },
  at: Date,
): Promise<string> {
  const year = referenceYearOf(at)
  const value = await allocateSequenceValue(em, scope, JOB_REFERENCE_KIND, year)
  return formatJobReference(year, value)
}

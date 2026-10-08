import type { ItadJobStatus } from './job-types'

/**
 * When a job's manifest may change (spec "Where changes are allowed"). Pure.
 *
 * A held job counts as the status it was held from, so a job put on hold during
 * receiving still accepts manifest corrections, while one held during processing does not.
 */
export const MANIFEST_EDITABLE_STATUSES: readonly ItadJobStatus[] = ['draft', 'scheduled', 'in_transit', 'receiving']

export type ManifestRulesJob = { status: ItadJobStatus; statusBeforeHold?: ItadJobStatus | null }

export function effectiveJobStatus(job: ManifestRulesJob): ItadJobStatus {
  return job.status === 'on_hold' && job.statusBeforeHold ? job.statusBeforeHold : job.status
}

export function canChangeManifest(job: ManifestRulesJob): boolean {
  return MANIFEST_EDITABLE_STATUSES.includes(effectiveJobStatus(job))
}

export const MANIFEST_DELETE_REASON_MIN = 3
export const MANIFEST_DELETE_REASON_MAX = 1000

/**
 * Reason for removing a manifest item (spec Q6): required while the job is (or was
 * held in) `receiving`, optional before. A given reason is trimmed and kept either way.
 */
export function resolveItemDeleteReason(
  job: ManifestRulesJob,
  reason: string | null | undefined,
): { ok: true; reason: string | null } | { ok: false } {
  const trimmed = typeof reason === 'string' ? reason.trim() : ''
  if (trimmed.length > MANIFEST_DELETE_REASON_MAX) return { ok: false }
  if (effectiveJobStatus(job) === 'receiving' && trimmed.length < MANIFEST_DELETE_REASON_MIN) return { ok: false }
  if (trimmed.length > 0 && trimmed.length < MANIFEST_DELETE_REASON_MIN) return { ok: false }
  return { ok: true, reason: trimmed.length ? trimmed : null }
}

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

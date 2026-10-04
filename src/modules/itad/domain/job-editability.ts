import type { ItadJobStatus } from './job-types'

export const ITAD_JOB_EDITABLE_FIELDS = [
  'customerId',
  'name',
  'customerReference',
  'scheduledPickupAt',
  'expectedAssetEstimate',
] as const

export type ItadJobEditableField = (typeof ITAD_JOB_EDITABLE_FIELDS)[number]

export const TERMINAL_STATUSES = ['completed', 'cancelled'] as const

export type TerminalStatus = (typeof TERMINAL_STATUSES)[number]

export function isTerminalStatus(status: ItadJobStatus): status is TerminalStatus {
  return (TERMINAL_STATUSES as readonly ItadJobStatus[]).includes(status)
}

type OperationalStatus = Exclude<ItadJobStatus, 'on_hold' | 'completed' | 'cancelled'>

/** Spec "Field editability by status". `on_hold` uses the column of its pre-hold status. */
const EDITABLE_BY_STATUS: Record<OperationalStatus, readonly ItadJobEditableField[]> = {
  draft: ['customerId', 'name', 'customerReference', 'scheduledPickupAt', 'expectedAssetEstimate'],
  scheduled: ['name', 'customerReference', 'scheduledPickupAt', 'expectedAssetEstimate'],
  in_transit: ['name', 'customerReference', 'expectedAssetEstimate'],
  receiving: ['name', 'customerReference'],
  processing: ['name', 'customerReference'],
  closeout_review: ['name', 'customerReference'],
}

/** `scheduledPickupAt` may be cleared only while the job is still a draft. */
const CLEARABLE_BY_STATUS: Partial<Record<OperationalStatus, readonly ItadJobEditableField[]>> = {
  draft: ['customerReference', 'scheduledPickupAt', 'expectedAssetEstimate'],
  scheduled: ['customerReference', 'expectedAssetEstimate'],
  in_transit: ['customerReference', 'expectedAssetEstimate'],
  receiving: ['customerReference'],
  processing: ['customerReference'],
  closeout_review: ['customerReference'],
}

export type EditabilityJob = {
  status: ItadJobStatus
  statusBeforeHold?: ItadJobStatus | null
}

function effectiveStatus(job: EditabilityJob): OperationalStatus | null {
  const status = job.status === 'on_hold' ? job.statusBeforeHold ?? null : job.status
  if (!status || status === 'on_hold' || isTerminalStatus(status)) return null
  return status
}

export function getEditableFields(job: EditabilityJob): ItadJobEditableField[] {
  const status = effectiveStatus(job)
  return status ? [...EDITABLE_BY_STATUS[status]] : []
}

function isClearable(job: EditabilityJob, field: ItadJobEditableField): boolean {
  const status = effectiveStatus(job)
  return status ? (CLEARABLE_BY_STATUS[status] ?? []).includes(field) : false
}

export type JobFieldValues = {
  customerId: string
  name: string
  customerReference: string | null
  scheduledPickupAt: Date | null
  expectedAssetEstimate: number | null
}

function sameValue(field: ItadJobEditableField, current: JobFieldValues, next: unknown): boolean {
  const before = current[field]
  if (field === 'scheduledPickupAt') {
    const beforeMs = before instanceof Date ? before.getTime() : null
    const nextMs = next instanceof Date ? next.getTime() : null
    return beforeMs === nextMs
  }
  return (before ?? null) === (next ?? null)
}

export type EditabilityViolation = { field: ItadJobEditableField; reason: 'locked' | 'not_clearable' }

/**
 * Returns the first field the update may not change, or `null` when every change is
 * allowed. Unchanged values are always accepted: `CrudForm` submits the whole form,
 * including read-only fields, so only an actual change counts as a write.
 */
export function findEditabilityViolation(
  job: EditabilityJob,
  current: JobFieldValues,
  changes: Partial<JobFieldValues>,
): EditabilityViolation | null {
  const editable = getEditableFields(job)
  for (const field of ITAD_JOB_EDITABLE_FIELDS) {
    if (!(field in changes)) continue
    const next = changes[field]
    if (sameValue(field, current, next)) continue
    if (!editable.includes(field)) return { field, reason: 'locked' }
    if (next === null && !isClearable(job, field)) return { field, reason: 'not_clearable' }
  }
  return null
}

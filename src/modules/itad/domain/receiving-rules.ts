import type { ItadJobStatus, ItadScanResult } from './job-types'

/**
 * Receiving rules (manifest spec "Receiving scan", "Duplicate resolution", "Where
 * changes are allowed"). Pure.
 *
 * Scans, duplicate actions and asset edits/removals need the job in `receiving` itself
 * — a job held from receiving is paused, so nothing is received until it resumes.
 */
export function isReceivingActive(job: { status: ItadJobStatus }): boolean {
  return job.status === 'receiving'
}

/**
 * Outcome of one scan given the facts in the job: a serial that already has an active
 * asset is a duplicate (no new asset); otherwise a new asset is matched or unexpected
 * depending on whether an active manifest item carries the serial.
 */
export function decideScanResult(facts: { activeAssetExists: boolean; manifestItemExists: boolean }): ItadScanResult {
  if (facts.activeAssetExists) return 'duplicate'
  return facts.manifestItemExists ? 'matched' : 'unexpected'
}

export const RECEIVING_NOTE_MIN = 3
export const RECEIVING_NOTE_MAX = 1000

/**
 * Validates a note or reason: trimmed, 3–1000 characters when given; required ones must
 * be given. Returns the trimmed text, `null` for an omitted optional note, or `false`.
 */
export function resolveNote(value: string | null | undefined, required: boolean): string | null | false {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (!trimmed) return required ? false : null
  if (trimmed.length < RECEIVING_NOTE_MIN || trimmed.length > RECEIVING_NOTE_MAX) return false
  return trimmed
}

export type DuplicateScanState = {
  result: ItadScanResult
  resolvedAt?: Date | null
  flaggedDifferentDeviceAt?: Date | null
}

/** Only a pending duplicate can be resolved as the same device (also after a mistaken flag). */
export function canResolveAsSameDevice(scan: DuplicateScanState): boolean {
  return scan.result === 'duplicate' && !scan.resolvedAt
}

/** Only a pending, not yet flagged duplicate can be flagged as a different device. */
export function canFlagDifferentDevice(scan: DuplicateScanState): boolean {
  return scan.result === 'duplicate' && !scan.resolvedAt && !scan.flaggedDifferentDeviceAt
}

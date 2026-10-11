import type { ItadAssetStatus, ItadJobStatus } from './job-types'

/**
 * `dataBearing` rules (sanitization spec "Domain rules"). Pure.
 *
 * The value is tri-state: `true`, `false` or `null` (not determined). At the scan it is
 * resolved once from the matched manifest item, else the job default, else it stays
 * `null`, and copied onto the asset (snapshot rule): later manifest or job changes never
 * touch an already received asset; only asset classification does.
 */
export const ITAD_DATA_BEARING_SOURCES = ['manifest', 'job_default', 'manual', 'bulk'] as const
export type ItadDataBearingSource = (typeof ITAD_DATA_BEARING_SOURCES)[number]

export type DataBearingResolution = {
  dataBearing: boolean | null
  source: ItadDataBearingSource | null
}

/** Precedence: manifest item value → job default → not determined. */
export function resolveDataBearing(input: {
  manifestValue: boolean | null | undefined
  jobDefault: boolean | null | undefined
}): DataBearingResolution {
  if (typeof input.manifestValue === 'boolean') return { dataBearing: input.manifestValue, source: 'manifest' }
  if (typeof input.jobDefault === 'boolean') return { dataBearing: input.jobDefault, source: 'job_default' }
  return { dataBearing: null, source: null }
}

const TRUE_VALUES = new Set(['true', 'yes', 'y', '1', 'tak', 't'])
const FALSE_VALUES = new Set(['false', 'no', 'n', '0', 'nie'])

export type ParsedDataBearing = { ok: true; value: boolean | null } | { ok: false }

/**
 * Parses a manifest cell (case-insensitive, trimmed). An empty cell is "no value";
 * anything not recognized is `{ ok: false }`, reported as a row warning and treated as
 * no value.
 */
export function parseDataBearingValue(raw: string | null | undefined): ParsedDataBearing {
  const value = (raw ?? '').trim().toLocaleLowerCase('en-US')
  if (value === '') return { ok: true, value: null }
  if (TRUE_VALUES.has(value)) return { ok: true, value: true }
  if (FALSE_VALUES.has(value)) return { ok: true, value: false }
  return { ok: false }
}

export type ClassificationAssetState = {
  status: ItadAssetStatus
  dataBearing: boolean | null
}

export type ClassificationDecision =
  | { kind: 'noop' }
  | { kind: 'change'; toStatus: ItadAssetStatus }
  | { kind: 'refused'; code: 'sanitization_in_progress' | 'sanitization_not_possible' | 'assets_locked' }

/**
 * Classification of one asset to `dataBearing = target` (spec "Transitions" and
 * "Classification changes"). Who may classify in which job status is checked by the
 * caller; this decides the asset outcome:
 * - the value the asset already has is a no-op;
 * - an open run refuses any change;
 * - `→ true` from `received` requires sanitization; in `closeout_review` it is refused,
 *   because runs need `processing` and the job cannot go back;
 * - `→ false` always returns the asset to `received` (runs stay in history).
 */
export function decideClassification(input: {
  jobStatus: ItadJobStatus
  asset: ClassificationAssetState
  target: boolean
}): ClassificationDecision {
  const { jobStatus, asset, target } = input
  if (!CLASSIFIABLE_JOB_STATUSES.has(jobStatus)) return { kind: 'refused', code: 'assets_locked' }
  if (asset.status === 'sanitization_in_progress') return { kind: 'refused', code: 'sanitization_in_progress' }
  if (asset.dataBearing === target) return { kind: 'noop' }
  if (target) {
    if (jobStatus === 'closeout_review') return { kind: 'refused', code: 'sanitization_not_possible' }
    // A received asset enters sanitization; one already in it keeps its status.
    return { kind: 'change', toStatus: asset.status === 'received' ? 'sanitization_required' : asset.status }
  }
  return { kind: 'change', toStatus: 'received' }
}

const CLASSIFIABLE_JOB_STATUSES: ReadonlySet<ItadJobStatus> = new Set(['receiving', 'processing', 'closeout_review'])

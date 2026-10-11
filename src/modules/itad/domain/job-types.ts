/**
 * ITAD job vocabulary owned by the domain. `data/entities.ts` persists these values;
 * it depends on this file, never the other way round.
 */
export const ITAD_JOB_STATUSES = [
  'draft',
  'scheduled',
  'in_transit',
  'receiving',
  'processing',
  'closeout_review',
  'completed',
  'on_hold',
  'cancelled',
] as const

export type ItadJobStatus = (typeof ITAD_JOB_STATUSES)[number]

/**
 * Asset statuses stored on `itad_assets.status` (sanitization spec Q2). `received` is the
 * normal path (`dataBearing` false or not determined); the others are the sanitization
 * lifecycle of a data-bearing asset.
 */
export const ITAD_ASSET_STATUSES = [
  'received',
  'sanitization_required',
  'sanitization_in_progress',
  'sanitized',
  'review_required',
] as const
export type ItadAssetStatus = (typeof ITAD_ASSET_STATUSES)[number]

/**
 * Statuses allowed in the asset status history only. `sanitization_failed` is a
 * transition state (Q3): a FAIL records `in_progress → sanitization_failed → review_required`
 * and the asset never rests in it, so it is never a valid `ItadAssetStatus`.
 */
export const ITAD_ASSET_HISTORY_STATUSES = [...ITAD_ASSET_STATUSES, 'sanitization_failed'] as const
export type ItadAssetHistoryStatus = (typeof ITAD_ASSET_HISTORY_STATUSES)[number]

/** Actions recorded in the asset status history; the sanitization actions arrive with runs. */
export const ITAD_ASSET_TRANSITION_ACTIONS = [
  'classify',
  'start_run',
  'record_pass',
  'record_fail',
  'abort_run',
  'approve_retry',
] as const
export type ItadAssetTransitionAction = (typeof ITAD_ASSET_TRANSITION_ACTIONS)[number]

/** Outcome a receiving scan showed to the operator; kept as history on the intake scan. */
export const ITAD_SCAN_RESULTS = ['matched', 'unexpected', 'duplicate'] as const
export type ItadScanResult = (typeof ITAD_SCAN_RESULTS)[number]

/** Resolving outcomes of a duplicate scan in Epic 2; the exceptions epic adds its own. */
export const ITAD_SCAN_RESOLUTIONS = ['same_device'] as const
export type ItadScanResolution = (typeof ITAD_SCAN_RESOLUTIONS)[number]

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

/** Asset lifecycle (manifest spec Q9): only `received` in Epic 2; later epics extend it. */
export const ITAD_ASSET_STATUSES = ['received'] as const
export type ItadAssetStatus = (typeof ITAD_ASSET_STATUSES)[number]

/** Outcome a receiving scan showed to the operator; kept as history on the intake scan. */
export const ITAD_SCAN_RESULTS = ['matched', 'unexpected', 'duplicate'] as const
export type ItadScanResult = (typeof ITAD_SCAN_RESULTS)[number]

/** Resolving outcomes of a duplicate scan in Epic 2; the exceptions epic adds its own. */
export const ITAD_SCAN_RESOLUTIONS = ['same_device'] as const
export type ItadScanResolution = (typeof ITAD_SCAN_RESOLUTIONS)[number]

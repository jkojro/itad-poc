/**
 * Reconciliation of a job's manifest with what was received (manifest spec
 * "Reconciliation"). Pure. Everything here is derived at read time from active
 * manifest items, active assets and intake scans; nothing is stored.
 *
 * Items and assets are matched on the shared normalized serial (`domain/serial.ts`).
 * Serials are unique per job among active items and among active assets, so every item
 * and asset falls into exactly one state.
 */
export const MANIFEST_ITEM_RECONCILIATION = ['matched', 'missing'] as const
export type ManifestItemReconciliation = (typeof MANIFEST_ITEM_RECONCILIATION)[number]

export const ASSET_RECONCILIATION = ['matched', 'unexpected'] as const
export type AssetReconciliation = (typeof ASSET_RECONCILIATION)[number]

export function classifyManifestItem(hasActiveAsset: boolean): ManifestItemReconciliation {
  return hasActiveAsset ? 'matched' : 'missing'
}

export function classifyAsset(hasActiveManifestItem: boolean): AssetReconciliation {
  return hasActiveManifestItem ? 'matched' : 'unexpected'
}

/** Facts the `receivingComplete` condition needs; computed by `services/reconciliation-reader.ts`. */
export type ReceivingFacts = {
  activeManifestItems: number
  /** Unresolved duplicate scans not flagged as a different device. */
  pendingDuplicates: number
  /** Unresolved duplicate scans flagged as a different device (wait for the exceptions mechanism). */
  differentDeviceUnresolved: number
  /** Active assets whose `dataBearing` is not determined yet (sanitization spec REQ-305). */
  dataBearingUndecided: number
}

export type ReceivingCompleteBlocker =
  | 'manifestMissing'
  | 'differentDeviceUnresolved'
  | 'duplicatesPending'
  | 'dataBearingUndecided'

/**
 * Why receiving cannot be completed yet, or `null` when it can (spec "receivingComplete").
 * MISSING and UNEXPECTED never block: the `start_processing` request is the operator's
 * "receiving finished" signal, made with the counts in view.
 */
export function receivingCompleteBlocker(facts: ReceivingFacts): ReceivingCompleteBlocker | null {
  if (facts.activeManifestItems <= 0) return 'manifestMissing'
  if (facts.differentDeviceUnresolved > 0) return 'differentDeviceUnresolved'
  if (facts.pendingDuplicates > 0) return 'duplicatesPending'
  if (facts.dataBearingUndecided > 0) return 'dataBearingUndecided'
  return null
}

export type ReconciliationSummary = {
  expectedAssetCount: number
  receivedAssetCount: number
  matched: number
  missing: number
  unexpected: number
  pendingDuplicates: number
  differentDeviceUnresolved: number
  dataBearingUndecided: number
  hasManifest: boolean
}

/**
 * Builds the job summary from counts. `matched` is counted once: it is both the number
 * of items with an asset and the number of assets with an item (serials are unique).
 */
export function summarizeReconciliation(counts: {
  activeManifestItems: number
  activeAssets: number
  matched: number
  pendingDuplicates: number
  differentDeviceUnresolved: number
  dataBearingUndecided: number
}): ReconciliationSummary {
  return {
    expectedAssetCount: counts.activeManifestItems,
    receivedAssetCount: counts.activeAssets,
    matched: counts.matched,
    missing: counts.activeManifestItems - counts.matched,
    unexpected: counts.activeAssets - counts.matched,
    pendingDuplicates: counts.pendingDuplicates,
    differentDeviceUnresolved: counts.differentDeviceUnresolved,
    dataBearingUndecided: counts.dataBearingUndecided,
    hasManifest: counts.activeManifestItems > 0,
  }
}

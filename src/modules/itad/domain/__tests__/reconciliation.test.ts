import { describe, expect, it } from '@jest/globals'
import { classifyAsset, classifyManifestItem, receivingCompleteBlocker, summarizeReconciliation } from '../reconciliation'

describe('reconciliation (manifest spec TEST-104)', () => {
  it('classifies items and assets by the shared serial match', () => {
    expect([classifyManifestItem(true), classifyManifestItem(false)]).toEqual(['matched', 'missing'])
    expect([classifyAsset(true), classifyAsset(false)]).toEqual(['matched', 'unexpected'])
  })

  it('summarizes the acceptance scenario: 10 expected, 9 matched, 1 missing, 1 unexpected', () => {
    expect(
      summarizeReconciliation({ activeManifestItems: 10, activeAssets: 10, matched: 9, pendingDuplicates: 0, differentDeviceUnresolved: 0 }),
    ).toEqual({
      expectedAssetCount: 10,
      receivedAssetCount: 10,
      matched: 9,
      missing: 1,
      unexpected: 1,
      pendingDuplicates: 0,
      differentDeviceUnresolved: 0,
      hasManifest: true,
    })
  })

  it('names what blocks receiving completion, most fundamental first', () => {
    expect(receivingCompleteBlocker({ activeManifestItems: 0, pendingDuplicates: 2, differentDeviceUnresolved: 1 })).toBe('manifestMissing')
    expect(receivingCompleteBlocker({ activeManifestItems: 5, pendingDuplicates: 2, differentDeviceUnresolved: 1 })).toBe('differentDeviceUnresolved')
    expect(receivingCompleteBlocker({ activeManifestItems: 5, pendingDuplicates: 2, differentDeviceUnresolved: 0 })).toBe('duplicatesPending')
    expect(receivingCompleteBlocker({ activeManifestItems: 5, pendingDuplicates: 0, differentDeviceUnresolved: 0 })).toBeNull()
  })
})

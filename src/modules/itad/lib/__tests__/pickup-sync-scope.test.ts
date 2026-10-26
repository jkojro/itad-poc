import { describe, expect, it, jest } from '@jest/globals'

/**
 * The app bundles API routes separately, so `lib/pickup-sync-scope.ts` can be loaded more
 * than once in one process. The sync (one copy) and the pickup task guard (another copy)
 * must still share the marker, or the guard rejects the sync's own calendar writes.
 */
describe('pickup sync scope', () => {
  it('is shared between separately loaded copies of the module', async () => {
    const first = await import('../pickup-sync-scope')
    let second: typeof first | undefined
    jest.isolateModules(() => {
      second = jest.requireActual<typeof first>('../pickup-sync-scope')
    })
    expect(second).toBeDefined()
    expect(second).not.toBe(first)
    await first.runAsPickupSync(async () => {
      expect(second!.isPickupSyncActive()).toBe(true)
    })
    await second!.runAsPickupSync(async () => {
      expect(first.isPickupSyncActive()).toBe(true)
    })
  })

  it('is inactive outside the sync, and after it returns', async () => {
    const scope = await import('../pickup-sync-scope')
    expect(scope.isPickupSyncActive()).toBe(false)
    await scope.runAsPickupSync(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1))
      expect(scope.isPickupSyncActive()).toBe(true)
    })
    expect(scope.isPickupSyncActive()).toBe(false)
  })
})

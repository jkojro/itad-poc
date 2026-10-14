import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Trusted marker for the `itad` pickup task sync (pickup calendar spec TODO-501).
 *
 * The pickup task guard (`commands/interceptors.ts`) lets the `customers.interactions.*`
 * commands through only for the sync. The command interceptor context carries no
 * framework "trusted system" flag, and `auth: null` can be built by any in-process caller,
 * so the sync marks its own calls with an async-local scope instead. Request input cannot
 * reach this store, so an HTTP caller can never claim to be the sync.
 */
const pickupSyncScope = new AsyncLocalStorage<true>()

export function runAsPickupSync<T>(run: () => Promise<T>): Promise<T> {
  return pickupSyncScope.run(true, run)
}

export function isPickupSyncActive(): boolean {
  return pickupSyncScope.getStore() === true
}

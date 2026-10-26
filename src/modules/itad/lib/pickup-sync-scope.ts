import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Trusted marker for the `itad` pickup task sync (pickup calendar spec TODO-501).
 *
 * The pickup task guard (`commands/interceptors.ts`) lets the `customers.interactions.*`
 * commands through only for the sync. The command interceptor context carries no
 * framework "trusted system" flag, and `auth: null` can be built by any in-process caller,
 * so the sync marks its own calls with an async-local scope instead. Request input cannot
 * reach this store, so an HTTP caller can never claim to be the sync.
 *
 * The store lives on `globalThis` under a registry symbol: the app bundles each API route
 * separately, so this module can be loaded more than once in one process. A module-local
 * store would give the sync (running inside, say, the transitions route) and the guard
 * (registered from another bundle) two different stores, and the guard would reject the
 * sync's own writes as "reserved type". One shared instance keeps them in the same scope.
 */
const PICKUP_SYNC_SCOPE = Symbol.for('open-mercato.itad.pickup-sync-scope')

type PickupSyncScopeGlobal = typeof globalThis & { [PICKUP_SYNC_SCOPE]?: AsyncLocalStorage<true> }

function pickupSyncScope(): AsyncLocalStorage<true> {
  const root = globalThis as PickupSyncScopeGlobal
  if (!root[PICKUP_SYNC_SCOPE]) root[PICKUP_SYNC_SCOPE] = new AsyncLocalStorage<true>()
  return root[PICKUP_SYNC_SCOPE]
}

export function runAsPickupSync<T>(run: () => Promise<T>): Promise<T> {
  return pickupSyncScope().run(true, run)
}

export function isPickupSyncActive(): boolean {
  return pickupSyncScope().getStore() === true
}

import { handleAssetSearchEvent } from '../lib/asset-search-events'

/** Keeps the asset's global search projection current after `itad.sanitization.run_aborted` (operations dashboard spec "Global search"). */
export const metadata = { event: 'itad.sanitization.run_aborted', persistent: false, id: 'itad:asset-search-run-aborted' }

export default async function handle(payload: unknown, ctx: { resolve: <T = unknown>(name: string) => T }) {
  await handleAssetSearchEvent(payload, ctx)
}

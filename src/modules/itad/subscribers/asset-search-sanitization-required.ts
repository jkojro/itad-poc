import { handleAssetSearchEvent } from '../lib/asset-search-events'

/** Keeps the asset's global search projection current after `itad.asset.sanitization_required` (operations dashboard spec "Global search"). */
export const metadata = { event: 'itad.asset.sanitization_required', persistent: false, id: 'itad:asset-search-sanitization-required' }

export default async function handle(payload: unknown, ctx: { resolve: <T = unknown>(name: string) => T }) {
  await handleAssetSearchEvent(payload, ctx)
}

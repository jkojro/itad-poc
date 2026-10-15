import { createLogger } from '@open-mercato/shared/lib/logger'
import { refreshAssetSearchIndex } from '../services/asset-search-index'

const logger = createLogger('itad').child({ component: 'asset-search-index' })

type AssetEventPayload = { assetId?: unknown; tenantId?: unknown }

/**
 * Shared handler of the asset events that change what the global search projects
 * (receive, edit, removal, classification, sanitization). Runs after commit; a failure
 * is logged and never affects the workflow write.
 */
export async function handleAssetSearchEvent(
  payload: unknown,
  ctx: { resolve: <T = unknown>(name: string) => T },
  crudAction?: 'created' | 'updated',
): Promise<void> {
  const data = (payload ?? {}) as AssetEventPayload
  const assetId = typeof data.assetId === 'string' && data.assetId ? data.assetId : null
  const tenantId = typeof data.tenantId === 'string' && data.tenantId ? data.tenantId : null
  if (!assetId || !tenantId) return
  try {
    await refreshAssetSearchIndex(ctx, { assetId, tenantId, crudAction })
  } catch (err) {
    logger.warn('Asset search index refresh failed', { assetId, err })
  }
}

import type {
  SearchBuildContext,
  SearchModuleConfig,
  SearchResultLink,
  SearchResultPresenter,
} from '@open-mercato/shared/modules/search'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { ITAD_ASSET_ENTITY_ID, ITAD_JOB_ENTITY_ID } from './lib/constants'
import { loadCompanyNames } from './module-integrations/customers'

/**
 * ITAD assets in the platform's global search (operations dashboard spec Q6, REQ-722).
 *
 * - Token strategy only: the asset row is projected by `query_index` from asset events
 *   (`services/asset-search-index.ts`), tokenizing serial, tag, manufacturer, model and
 *   job reference — never the status.
 * - The presenter is computed at search time from the projection plus a live read of the
 *   job and the customer, so names are never stale. No status is shown here; the asset
 *   page and the ITAD Assets results show it live.
 */
type IndexDoc = Record<string, unknown>

const text = (record: IndexDoc, ...keys: string[]): string | null => {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return null
}

const assetHref = (record: IndexDoc): string | null => {
  const id = text(record, 'id')
  const jobId = text(record, 'job_id', 'jobId')
  return id && jobId ? `/backend/itad/jobs/${encodeURIComponent(jobId)}/assets/${encodeURIComponent(id)}` : null
}

async function loadJobContext(ctx: SearchBuildContext): Promise<{ reference: string | null; customerName: string | null }> {
  const record = ctx.record as IndexDoc
  const jobId = text(record, 'job_id', 'jobId')
  const organizationId = text(record, 'organization_id', 'organizationId') ?? ctx.organizationId ?? null
  const queryEngine = ctx.queryEngine as QueryEngine | undefined
  if (!jobId || !queryEngine || !ctx.tenantId || !organizationId) return { reference: null, customerName: null }
  try {
    const result = await queryEngine.query(ITAD_JOB_ENTITY_ID, {
      tenantId: ctx.tenantId,
      organizationId,
      filters: { id: jobId },
      page: { page: 1, pageSize: 1 },
    })
    const job = (result.items[0] ?? {}) as IndexDoc
    const customerId = text(job, 'customer_id', 'customerId')
    const names = customerId ? await loadCompanyNames(queryEngine, { tenantId: ctx.tenantId, organizationId }, [customerId]) : new Map()
    return {
      reference: text(job, 'internal_reference', 'internalReference'),
      customerName: customerId ? names.get(customerId) ?? null : null,
    }
  } catch {
    return { reference: null, customerName: null }
  }
}

export const searchConfig: SearchModuleConfig = {
  entities: [
    {
      entityId: ITAD_ASSET_ENTITY_ID,
      enabled: true,
      priority: 6,
      strategies: ['tokens'],
      aclFeatures: ['itad.assets.view'],
      fieldPolicy: {
        searchable: ['serial', 'serial_normalized', 'customer_asset_tag', 'manufacturer', 'model', 'job_reference'],
      },
      formatResult: async (ctx: SearchBuildContext): Promise<SearchResultPresenter | null> => {
        const record = ctx.record as IndexDoc
        const serial = text(record, 'serial')
        if (!serial) return null
        const { translate } = await resolveTranslations()
        const job = await loadJobContext(ctx)
        const device = [text(record, 'manufacturer'), text(record, 'model')].filter(Boolean).join(' ')
        const subtitle = [text(record, 'customer_asset_tag', 'customerAssetTag'), device || null, job.customerName, job.reference]
          .filter(Boolean)
          .join(' · ')
        return {
          title: serial,
          subtitle: subtitle || undefined,
          icon: 'package',
          badge: translate('itad.search.badge', 'ITAD asset'),
        }
      },
      resolveUrl: async (ctx: SearchBuildContext) => assetHref(ctx.record as IndexDoc),
      resolveLinks: async (ctx: SearchBuildContext): Promise<SearchResultLink[] | null> => {
        const record = ctx.record as IndexDoc
        const href = assetHref(record)
        const serial = text(record, 'serial')
        if (!href || !serial) return null
        const { translate } = await resolveTranslations()
        return [
          { href, label: translate('itad.search.openAsset', 'Open asset'), kind: 'primary' },
          {
            href: `/backend/itad/assets?q=${encodeURIComponent(serial)}`,
            label: translate('itad.search.allMatches', 'All matches for this serial'),
            kind: 'secondary',
          },
        ]
      },
    },
  ],
}

export default searchConfig

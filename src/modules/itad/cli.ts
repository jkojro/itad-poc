import type { ModuleCli } from '@open-mercato/shared/modules/registry'
import { getModules } from '@open-mercato/shared/lib/modules/registry'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { listAssetIdsForSearch, refreshAssetSearchIndex } from './services/asset-search-index'

function readArg(argv: string[], name: string): string | null {
  const index = argv.findIndex((arg) => arg === `--${name}`)
  if (index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--')) return argv[index + 1]
  const inline = argv.find((arg) => arg.startsWith(`--${name}=`))
  return inline ? inline.slice(name.length + 3) : null
}

/**
 * Backfills the global search projection of ITAD assets (operations dashboard spec
 * "Global search"): every active asset of the tenant is re-projected with the same
 * identifiers-only token document the asset events use. Safe to re-run.
 */
const searchReindexAssets: ModuleCli = {
  command: 'search-reindex-assets',
  async run(argv) {
    const tenantId = readArg(argv, 'tenant')
    const organizationId = readArg(argv, 'org')
    if (!tenantId) {
      console.error('Usage: mercato itad search-reindex-assets --tenant <tenantId> [--org <organizationId>]')
      return
    }
    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()
    const assetIds = await listAssetIdsForSearch(em, tenantId, organizationId)
    for (const assetId of assetIds) await refreshAssetSearchIndex(container, { assetId, tenantId })
    console.log(`Re-indexed ${assetIds.length} ITAD assets for global search (tenant ${tenantId}${organizationId ? `, organization ${organizationId}` : ''}).`)
  },
}

/**
 * Gives existing organizations an inbound email address for ITAD Inbox Ops (spec
 * 2026-10-24-itad-inbox-ops, phase 1 step 1). The installed `inbox_ops` creates its inbox
 * settings only when a tenant is created; this runs that module's own (idempotent)
 * `onTenantCreated` hook for an organization that already exists. ITAD never writes
 * `inbox_ops` tables itself. Organization ids: `yarn mercato auth list-orgs`.
 */
const inboxEnsureAddress: ModuleCli = {
  command: 'inbox-ensure-address',
  async run(argv) {
    const tenantId = readArg(argv, 'tenant')
    const organizationId = readArg(argv, 'org')
    if (!tenantId || !organizationId) {
      console.error('Usage: mercato itad inbox-ensure-address --tenant <tenantId> --org <organizationId>')
      return
    }
    const inboxOps = getModules().find((module) => module.id === 'inbox_ops')
    const hook = inboxOps?.setup?.onTenantCreated
    if (!hook) {
      console.error('The inbox_ops module is not enabled; enable it in src/modules.ts first.')
      return
    }
    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()
    await hook({ em, tenantId, organizationId })
    console.log(`Inbound address ensured for organization ${organizationId} (tenant ${tenantId}); see Settings → Inbox Ops.`)
  },
}

const itadCli: ModuleCli[] = [searchReindexAssets, inboxEnsureAddress]

export default itadCli

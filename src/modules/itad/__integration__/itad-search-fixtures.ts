import { expect, type APIRequestContext } from '@playwright/test'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { advanceToReceiving, createSchedulableJob } from './itad-job-fixtures'
import { csv, importManifestOk } from './itad-manifest-fixtures'
import { scanOk } from './itad-receiving-fixtures'

export type AssetSearchItem = {
  id: string
  serial: string
  customerAssetTag: string | null
  manufacturer: string | null
  model: string | null
  status: string
  matchedOn: 'serial' | 'customerAssetTag'
  exactMatch: boolean
  jobId: string
  jobReference: string
  jobName: string
  customerName: string | null
}

/** `GET /api/itad/assets` (operations dashboard spec "Asset search"); `selectedOrgId` switches the organization scope. */
export async function searchAssets(request: APIRequestContext, token: string, query: string, selectedOrgId?: string) {
  return request.fetch(`/api/itad/assets?${query}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(selectedOrgId ? { Cookie: `om_selected_org=${selectedOrgId}` } : {}) },
  })
}

export async function searchAssetsOk(request: APIRequestContext, token: string, query: string, selectedOrgId?: string) {
  const response = await searchAssets(request, token, query, selectedOrgId)
  const body = await readJsonSafe<{ items: AssetSearchItem[]; total: number }>(response)
  expect(response.status(), `asset search failed: ${JSON.stringify(body)}`).toBe(200)
  return body!
}

export type GlobalSearchResult = {
  entityId: string
  recordId: string
  presenter?: { title?: string; subtitle?: string; badge?: string }
  url?: string
  links?: Array<{ href: string; label: string }>
}

/** The platform's header search (`/api/search/search/global`), limited to ITAD assets. */
export async function globalAssetSearch(request: APIRequestContext, token: string, q: string): Promise<GlobalSearchResult[]> {
  const response = await request.fetch(`/api/search/search/global?q=${encodeURIComponent(q)}&entityTypes=itad:itad_asset`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(response.status()).toBe(200)
  return (await readJsonSafe<{ results: GlobalSearchResult[] }>(response))?.results ?? []
}

/** A job in receiving whose devices came from a manifest with tag, make and model. */
export async function receivedJobWithDevices(
  request: APIRequestContext,
  token: string,
  companyId: string,
  name: string,
  devices: Array<{ serial: string; tag: string; make: string; model: string }>,
) {
  const job = await createSchedulableJob(request, token, companyId, name)
  await importManifestOk(
    request,
    token,
    job.id,
    {
      name: `search-${devices[0].serial}.csv`,
      content: csv([['Serial', 'Tag', 'Make', 'Model'], ...devices.map((device) => [device.serial, device.tag, device.make, device.model])]),
    },
    { serial: 'Serial', customerAssetTag: 'Tag', manufacturer: 'Make', model: 'Model' },
  )
  await advanceToReceiving(request, token, job.id)
  const assets = []
  for (const device of devices) assets.push((await scanOk(request, token, job.id, device.serial)).asset)
  return { job, assets }
}

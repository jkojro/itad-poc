import type { APIRequestContext } from '@playwright/test'
import { CONFIRM, advanceToReceiving, createSchedulableJob, transitionOk } from './itad-job-fixtures'
import { csv, importManifestOk } from './itad-manifest-fixtures'
import { scanOk } from './itad-receiving-fixtures'
import { processingJobWithDataBearingAssets, recordResult, startRunOk } from './itad-sanitization-fixtures'
import { passAsset } from './itad-certificate-fixtures'

/**
 * Five active jobs of one company, one per dashboard group (operations dashboard spec
 * "Groups and order"): red (a failed sanitization), orange (closeout with a missing
 * certificate, AC-707), in progress (receiving 3 of 5, AC-709), upcoming (scheduled) and
 * a draft. Filtering by the company keeps other tests' jobs out.
 */
export async function createOperationsScenario(request: APIRequestContext, token: string, companyId: string, suffix: string, tag: string) {
  const red = await createSchedulableJob(request, token, companyId, `QA ops red ${suffix}`)
  const [failedAsset] = await processingJobWithDataBearingAssets(request, token, red.id, 1)
  const run = await startRunOk(request, token, red.id, failedAsset)
  await recordResult(request, token, red.id, run, { result: 'FAIL', verificationMethod: 'full_verification', verificationNotes: 'Readable sectors' })

  const orange = await createSchedulableJob(request, token, companyId, `QA ops orange ${suffix}`)
  const [sanitized] = await processingJobWithDataBearingAssets(request, token, orange.id, 1)
  await passAsset(request, token, orange.id, sanitized)
  await transitionOk(request, token, orange.id, { action: 'start_closeout', confirmations: [CONFIRM('allAssetsProcessed')] })

  const receiving = await createSchedulableJob(request, token, companyId, `QA ops receiving ${suffix}`)
  const serials = Array.from({ length: 5 }, (_, index) => `OP${index}${tag}`)
  await importManifestOk(
    request,
    token,
    receiving.id,
    { name: `ops-${tag}.csv`, content: csv([['Serial', 'Carries data'], ...serials.map((serial) => [serial, 'no'])]) },
    { serial: 'Serial', dataBearing: 'Carries data' },
  )
  await advanceToReceiving(request, token, receiving.id)
  for (const serial of serials.slice(0, 3)) await scanOk(request, token, receiving.id, serial)

  const upcoming = await createSchedulableJob(request, token, companyId, `QA ops upcoming ${suffix}`)
  await transitionOk(request, token, upcoming.id, { action: 'schedule' })

  const draft = await createSchedulableJob(request, token, companyId, `QA ops draft ${suffix}`)
  return { red, orange, receiving, upcoming, draft }
}

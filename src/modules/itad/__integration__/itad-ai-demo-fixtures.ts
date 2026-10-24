import { expect, type APIRequestContext } from '@playwright/test'
import { createCompanyFixture } from '@open-mercato/core/helpers/integration/crmFixtures'
import { CONFIRM, createSchedulableJob, transitionOk, uniqueSuffix } from './itad-job-fixtures'
import { approveRetry, currentAssets, processingJobWithDataBearingAssets, recordResult, startRunOk, type DataBearingAsset } from './itad-sanitization-fixtures'
import { passAsset } from './itad-certificate-fixtures'
import { jobWithOpenReconciliationExceptions } from './itad-ai-fixtures'

/**
 * Demo data of the AI assistant (AI assistant spec, phase 3 step 4; PDF §8 steps 1–4),
 * built through the existing ITAD APIs only. Nothing is cleaned up: it is meant to stay
 * in the environment the demo runs on.
 *
 * 1. "What should I focus on today?" — a job with a failed wipe and a job with a missing device.
 * 2. "Why can't I complete …?" — a job in closeout review with 2 missing certificates.
 * 3. "Approve a retry for …" — the device of the failed-wipe job, in review.
 * 4. "Assign all open sanitization failures on this job to me" — 3 open failures and 1 resolved.
 */
export type AiDemoData = {
  customer: string
  failedWipe: { jobId: string; reference: string; serial: string }
  missingDevice: { jobId: string; reference: string; serial: string }
  closeout: { jobId: string; reference: string; serials: string[] }
  failures: { jobId: string; reference: string; openSerials: string[]; resolvedSerial: string }
}

async function fail(request: APIRequestContext, token: string, jobId: string, asset: DataBearingAsset): Promise<void> {
  const runId = await startRunOk(request, token, jobId, asset)
  const response = await recordResult(request, token, jobId, runId, { result: 'FAIL', verificationMethod: 'full_verification', verificationNotes: 'Readable sectors after purge' })
  expect(response.status(), await response.text()).toBe(200)
}

export async function seedAiDemo(request: APIRequestContext, token: string): Promise<AiDemoData> {
  const suffix = uniqueSuffix().slice(-5).toUpperCase()
  const customer = `Demo Customer ${suffix}`
  const companyId = await createCompanyFixture(request, token, customer)

  // 1 + 3: one device failed its wipe and waits for a retry decision.
  const failedJob = await createSchedulableJob(request, token, companyId, `Demo laptop refresh ${suffix}`)
  const [failedAsset] = await processingJobWithDataBearingAssets(request, token, failedJob.id, 1)
  await fail(request, token, failedJob.id, failedAsset)

  // 1: a device on the manifest never arrived.
  const missing = await jobWithOpenReconciliationExceptions(request, token, companyId, `Demo branch office ${suffix}`)

  // 2: wiped devices, closeout started, no certificate issued yet.
  const closeoutJob = await createSchedulableJob(request, token, companyId, `Demo data centre ${suffix}`)
  const closeoutAssets = await processingJobWithDataBearingAssets(request, token, closeoutJob.id, 2)
  for (const asset of await currentAssets(request, token, closeoutJob.id, closeoutAssets.map((entry) => entry.serial))) {
    await passAsset(request, token, closeoutJob.id, asset)
  }
  expect(await transitionOk(request, token, closeoutJob.id, { action: 'start_closeout', confirmations: [CONFIRM('allAssetsProcessed')] })).toBe('closeout_review')

  // 4: four failed wipes, one retry already approved → 3 open failures and 1 resolved.
  const failuresJob = await createSchedulableJob(request, token, companyId, `Demo warehouse ${suffix}`)
  const failureAssets = await processingJobWithDataBearingAssets(request, token, failuresJob.id, 4)
  const serials = failureAssets.map((asset) => asset.serial)
  for (let index = 0; index < serials.length; index += 1) {
    await fail(request, token, failuresJob.id, (await currentAssets(request, token, failuresJob.id, serials))[index])
  }
  const retried = (await currentAssets(request, token, failuresJob.id, serials))[3]
  expect((await approveRetry(request, token, failuresJob.id, retried, 'Cable replaced, retry')).status()).toBe(200)

  return {
    customer,
    failedWipe: { jobId: failedJob.id, reference: failedJob.internalReference, serial: failedAsset.serial },
    missingDevice: { jobId: missing.jobId, reference: missing.reference, serial: missing.missing.serial },
    closeout: { jobId: closeoutJob.id, reference: closeoutJob.internalReference, serials: closeoutAssets.map((asset) => asset.serial) },
    failures: { jobId: failuresJob.id, reference: failuresJob.internalReference, openSerials: serials.slice(0, 3), resolvedSerial: retried.serial },
  }
}

import type { APIRequestContext } from '@playwright/test'
import { advanceToReceiving, transitionOk, uniqueSuffix } from './itad-job-fixtures'
import { csv, importManifestOk } from './itad-manifest-fixtures'
import { scanOk } from './itad-receiving-fixtures'

/**
 * Cross-cutting flows: since `receivingComplete` is computed from data (manifest spec
 * Phase 4), a job reaches `processing` only with a manifest and no open duplicates.
 */

/** Imports a one-device manifest into a job in `receiving` and scans that device. */
export async function receiveOneDevice(request: APIRequestContext, token: string, jobId: string): Promise<string> {
  const serial = `FLOW-${uniqueSuffix().slice(-8).toUpperCase()}`
  await importManifestOk(request, token, jobId, { name: `flow-${serial}.csv`, content: csv([['Serial'], [serial]]) }, { serial: 'Serial' })
  await scanOk(request, token, jobId, serial)
  return serial
}

/** Moves a fresh schedulable job to `processing` through a real manifest and scan. */
export async function advanceToProcessing(request: APIRequestContext, token: string, jobId: string): Promise<void> {
  await advanceToReceiving(request, token, jobId)
  await receiveOneDevice(request, token, jobId)
  await transitionOk(request, token, jobId, { action: 'start_processing' })
}

import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createOrganizationFixture, deleteOrganizationIfExists } from '@open-mercato/core/helpers/integration/authFixtures'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { getTokenContext, readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { advanceToReceiving, createSchedulableJob, postTransition, transitionOk, uniqueSuffix } from './itad-job-fixtures'
import { csv, importManifestOk } from './itad-manifest-fixtures'
import { listAssets, scanOk } from './itad-receiving-fixtures'
import {
  approveRetry,
  currentAssets,
  getSanitization,
  getTools,
  processingJobWithDataBearingAssets,
  recordResult,
  startRun,
  startRunOk,
} from './itad-sanitization-fixtures'

const errorCode = async (response: { json: () => Promise<unknown> }) => ((await response.json()) as { code?: string }).code

/**
 * TC-ITAD-205 (sanitization spec TEST-307): runs only in processing (refused in
 * receiving and on hold); the receiving role (employee: receive + sanitization.view)
 * reads runs but cannot start, finish or approve a retry (403); another organization
 * gets 404; tool suggestions come from earlier runs.
 */
test.describe('TC-ITAD-205: sanitization permissions, job status and scope', () => {
  test('processing only, separate permissions, organization isolation', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const employeeToken = await getAuthToken(request, 'employee')
    const { tenantId } = getTokenContext(token)
    const suffix = uniqueSuffix()
    const tag = suffix.slice(-6).toUpperCase().replace(/[^A-Z0-9]/g, 'X')
    let companyId: string | null = null
    const jobIds: string[] = []
    let orgBId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD San ACL ${suffix}`)

      // Receiving: data-bearing device, but no runs yet.
      const receivingJob = (await createSchedulableJob(request, token, companyId, `QA san receiving ${suffix}`)).id
      jobIds.push(receivingJob)
      await importManifestOk(request, token, receivingJob, { name: `r-${tag}.csv`, content: csv([['Serial', 'Data'], [`RV${tag}`, 'yes']]) }, { serial: 'Serial', dataBearing: 'Data' })
      await advanceToReceiving(request, token, receivingJob)
      await scanOk(request, token, receivingJob, `RV${tag}`)
      const receivingAsset = (await listAssets(request, token, receivingJob)).items[0]
      const early = await startRun(request, token, receivingJob, receivingAsset)
      expect(early.status()).toBe(409)
      expect(await errorCode(early)).toBe('itad.sanitization.errors.processing_required')

      // Processing job.
      const jobId = (await createSchedulableJob(request, token, companyId, `QA san processing ${suffix}`)).id
      jobIds.push(jobId)
      const [asset] = await processingJobWithDataBearingAssets(request, token, jobId, 1)

      // Employee: may read, may not act.
      expect((await getSanitization(request, employeeToken, jobId, '/sanitization')).status()).toBe(200)
      expect((await startRun(request, employeeToken, jobId, asset)).status()).toBe(403)
      const runId = await startRunOk(request, token, jobId, asset)
      expect((await getSanitization(request, employeeToken, jobId, `/assets/${asset.id}/sanitization`)).status()).toBe(200)
      expect((await recordResult(request, employeeToken, jobId, runId, { result: 'PASS', verificationMethod: 'none' })).status()).toBe(403)

      // On hold: the open run cannot be finished until the job resumes.
      await transitionOk(request, token, jobId, { action: 'hold', reason: 'Power outage' })
      const held = await recordResult(request, token, jobId, runId, { result: 'FAIL', verificationMethod: 'none', verificationNotes: 'x' })
      expect(held.status()).toBe(409)
      expect(await errorCode(held)).toBe('itad.sanitization.errors.processing_required')
      await transitionOk(request, token, jobId, { action: 'resume' })
      expect((await recordResult(request, token, jobId, runId, { result: 'FAIL', verificationMethod: 'none', verificationNotes: 'Drive locked' })).status()).toBe(200)
      const [review] = await currentAssets(request, token, jobId, [asset.serial])
      expect((await approveRetry(request, employeeToken, jobId, review, 'Try again')).status()).toBe(403)

      // Tool suggestions from earlier runs.
      const tools = await getTools(request, token, 'blancco')
      const toolsBody = await readJsonSafe<{ items: Array<{ tool: string; toolVersion: string }> }>(tools)
      expect(toolsBody?.items).toContainEqual(expect.objectContaining({ tool: 'Blancco Drive Eraser', toolVersion: '7.9' }))

      // Another organization sees nothing.
      orgBId = await createOrganizationFixture(request, token, { name: `QA ITAD San Org B ${suffix}`, tenantId })
      for (const path of ['/sanitization', `/assets/${asset.id}/sanitization`]) {
        expect((await getSanitization(request, token, jobId, path, orgBId)).status(), path).toBe(404)
      }
    } finally {
      for (const id of jobIds) await postTransition(request, token, id, { action: 'cancel', reason: 'QA cleanup' }).catch(() => undefined)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
      await deleteOrganizationIfExists(request, token, orgBId)
    }
  })
})

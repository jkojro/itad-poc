import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import {
  createRoleFixture,
  createUserFixture,
  deleteRoleIfExists,
  deleteUserIfExists,
  setRoleAclFeatures,
} from '@open-mercato/core/helpers/integration/authFixtures'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { getTokenContext, readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { createSchedulableJob, postTransition, uniqueSuffix } from './itad-job-fixtures'
import { approveRetry, currentAssets, processingJobWithDataBearingAssets, recordResult, startRunOk } from './itad-sanitization-fixtures'
import { getTimeline, timelineOf } from './itad-exception-fixtures'

/**
 * TC-ITAD-309 (exceptions spec TEST-408; AC-408, E4-054): the business timeline of a
 * device that is received, decided as data-bearing at the scan, reconciled, fails a wipe
 * (exception opened by the system), gets a retry (exception resolved) and passes — in
 * order, with actors and system entries. Reading twice gives the same result (nothing is
 * written); a viewer without the sanitization and exception features sees only the
 * receiving, data-bearing and job entries.
 */
test.describe('TC-ITAD-309: asset business timeline', () => {
  test('receive → decide → reconcile → FAIL → exception → retry → PASS', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const { tenantId, organizationId } = getTokenContext(token)
    const suffix = uniqueSuffix()
    const safe = suffix.replace(/[^a-z0-9]/gi, '_')
    let companyId: string | null = null
    let jobId: string | null = null
    let roleId: string | null = null
    let userId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD Timeline ${suffix}`)
      jobId = (await createSchedulableJob(request, token, companyId, `QA timeline ${suffix}`)).id
      const [asset] = await processingJobWithDataBearingAssets(request, token, jobId, 1)
      const run1 = await startRunOk(request, token, jobId, asset)
      expect((await recordResult(request, token, jobId, run1, { result: 'FAIL', verificationMethod: 'full_verification', verificationNotes: 'Readable sectors' })).status()).toBe(200)
      expect((await approveRetry(request, token, jobId, (await currentAssets(request, token, jobId, [asset.serial]))[0], 'New cable')).status()).toBe(200)
      const run2 = await startRunOk(request, token, jobId, (await currentAssets(request, token, jobId, [asset.serial]))[0])
      expect((await recordResult(request, token, jobId, run2, { result: 'PASS', verificationMethod: 'full_verification' })).status()).toBe(200)

      const timeline = await timelineOf(request, token, jobId, asset.id)
      expect(timeline.map((entry) => entry.kind)).toEqual([
        'received',
        'data_bearing_decided',
        'reconciled',
        'sanitization_started',
        'sanitization_failed',
        'exception_opened',
        'retry_approved',
        'exception_resolved',
        'sanitization_started',
        'sanitization_passed',
      ])
      expect(timeline.find((entry) => entry.kind === 'received')).toMatchObject({ details: { scanResult: 'matched' } })
      expect(timeline.find((entry) => entry.kind === 'data_bearing_decided')).toMatchObject({
        actor: null,
        details: { dataBearingTo: true, dataBearingSource: 'manifest' },
      })
      expect(timeline.find((entry) => entry.kind === 'exception_opened')).toMatchObject({ actor: null, details: { exceptionType: 'sanitization_failed' } })
      expect(timeline.find((entry) => entry.kind === 'exception_resolved')).toMatchObject({ details: { outcome: 'retry_approved', reason: 'New cable' } })
      expect(timeline.find((entry) => entry.kind === 'sanitization_started')?.actor).not.toBeNull()
      for (let index = 1; index < timeline.length; index += 1) expect(timeline[index].at >= timeline[index - 1].at).toBe(true)

      // Reading writes nothing: a second read is identical (E4-054).
      expect(await timelineOf(request, token, jobId, asset.id)).toEqual(timeline)

      // Without sanitization / exception features only the other entries are visible.
      const roleName = `qa_itad_timeline_${safe}`
      roleId = await createRoleFixture(request, token, { name: roleName, tenantId })
      await setRoleAclFeatures(request, token, { roleId, features: ['itad.jobs.view', 'itad.assets.view'] })
      const email = `qa-itad-timeline-${suffix}@example.test`
      const password = `Qa-${suffix}-Secret!`
      userId = await createUserFixture(request, token, { email, password, organizationId, roles: [roleName] })
      const limited = await getAuthToken(request, email, password)
      const limitedTimeline = (await readJsonSafe<{ items: Array<{ kind: string }> }>(await getTimeline(request, limited, jobId, asset.id)))?.items ?? []
      expect(limitedTimeline.map((entry) => entry.kind)).toEqual(['received', 'data_bearing_decided', 'reconciled'])
    } finally {
      await deleteUserIfExists(request, token, userId)
      await deleteRoleIfExists(request, token, roleId)
      if (jobId) await postTransition(request, token, jobId, { action: 'cancel', reason: 'QA cleanup' }).catch(() => undefined)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

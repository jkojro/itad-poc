import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { advanceToReceiving, createSchedulableJob, uniqueSuffix } from './itad-job-fixtures'
import { csv, importManifestOk } from './itad-manifest-fixtures'
import { scanOk } from './itad-receiving-fixtures'
import { jobOverviewOk } from './itad-overview-fixtures'

/**
 * TC-ITAD-601 (operations dashboard spec AC-701, REQ-702 … REQ-706, REQ-720, D7): during
 * receiving, Expected = Received + Missing, Unexpected is separate and Total intake counts
 * every device. Missing is receiving progress, unexpected needs attention. The jobs list
 * uses the same meaning of Received.
 */
test.describe('TC-ITAD-601: overview reconciliation counters', () => {
  test('expected, received, missing, unexpected and total intake while receiving', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    const tag = suffix.slice(-6).toUpperCase().replace(/[^A-Z0-9]/g, 'X')
    let companyId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA Overview Recon ${suffix}`)
      const job = await createSchedulableJob(request, token, companyId, `QA overview recon ${suffix}`)
      const serials = Array.from({ length: 10 }, (_, index) => `OV${index}${tag}`)
      await importManifestOk(
        request,
        token,
        job.id,
        { name: `ov-${tag}.csv`, content: csv([['Serial', 'Carries data'], ...serials.map((serial) => [serial, 'no'])]) },
        { serial: 'Serial', dataBearing: 'Carries data' },
      )
      await advanceToReceiving(request, token, job.id)

      // Receiving started, nothing scanned: missing is progress, not attention.
      const before = await jobOverviewOk(request, token, job.id)
      expect(before.counters).toMatchObject({ expected: 10, received: 0, missing: 10, unexpected: 0, totalIntake: 0 })
      expect(before).toMatchObject({ severity: 'none', group: 'in_progress', signals: [] })

      for (const serial of serials.slice(0, 9)) await scanOk(request, token, job.id, serial)
      await scanOk(request, token, job.id, `UX${tag}`)

      const after = await jobOverviewOk(request, token, job.id)
      expect(after.counters).toMatchObject({ expected: 10, received: 9, missing: 1, unexpected: 1, totalIntake: 10 })
      expect(after.counters.expected).toBe(after.counters.received + after.counters.missing)
      expect(after.severity).toBe('orange')
      expect(after.signals.find((signal) => signal.key === 'unexpected')).toMatchObject({
        severity: 'orange',
        count: 1,
        href: `/backend/itad/jobs/${job.id}?tab=receiving&reconciliation=unexpected`,
      })
      expect(after.signals.map((signal) => signal.key)).not.toContain('missing_exceptions')

      // The jobs list uses the same meaning of Received (Q3).
      const list = await apiRequest(request, 'GET', `/api/itad/jobs?id=${job.id}`, { token })
      const item = (await readJsonSafe<{ items: Array<Record<string, number>> }>(list))!.items[0]
      expect(item).toMatchObject({ expectedAssetCount: 10, matchedAssetCount: 9, unexpectedAssetCount: 1, receivedAssetCount: 10 })
    } finally {
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

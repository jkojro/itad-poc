import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { advanceToReceiving, createSchedulableJob, uniqueSuffix } from './itad-job-fixtures'
import { csv, importManifestOk } from './itad-manifest-fixtures'
import { classifyUndecided, receivingCompleteView, scanOk } from './itad-receiving-fixtures'
import { jobOverviewOk } from './itad-overview-fixtures'

/**
 * TC-ITAD-610 (operations dashboard spec D10): while receiving, devices whose data-bearing
 * is not determined yet are work remaining. The overview shows the count without an
 * attention signal, and `receivingComplete` still blocks `start_processing` until every
 * device is classified.
 */
test.describe('TC-ITAD-610: data-bearing unknown during receiving', () => {
  test('counts undecided devices as progress and keeps the receiving blocker', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    const tag = suffix.slice(-6).toUpperCase().replace(/[^A-Z0-9]/g, 'X')
    let companyId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA Overview Data Bearing ${suffix}`)
      const job = await createSchedulableJob(request, token, companyId, `QA overview data bearing ${suffix}`)
      const serials = Array.from({ length: 10 }, (_, index) => `DB${index}${tag}`)
      // No "carries data" column: received devices stay undecided.
      await importManifestOk(request, token, job.id, { name: `db-${tag}.csv`, content: csv([['Serial'], ...serials.map((serial) => [serial])]) }, { serial: 'Serial' })
      await advanceToReceiving(request, token, job.id)
      for (const serial of serials.slice(0, 4)) await scanOk(request, token, job.id, serial)

      const receiving = await jobOverviewOk(request, token, job.id)
      expect(receiving.counters).toMatchObject({ received: 4, missing: 6, dataBearingUnknown: 4 })
      expect(receiving).toMatchObject({ severity: 'none', group: 'in_progress', signals: [] })
      expect(await receivingCompleteView(request, token, job.id)).toMatchObject({
        state: 'unmet',
        detailKey: 'itad.jobs.conditions.detail.dataBearingUndecided',
      })

      await classifyUndecided(request, token, job.id, false)
      const classified = await jobOverviewOk(request, token, job.id)
      expect(classified.counters.dataBearingUnknown).toBe(0)
      expect((await receivingCompleteView(request, token, job.id))?.state).toBe('met')
    } finally {
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { advanceToReceiving, createSchedulableJob, transitionOk, uniqueSuffix } from './itad-job-fixtures'
import { csv, importManifestOk } from './itad-manifest-fixtures'
import { classifyUndecided, scanOk } from './itad-receiving-fixtures'
import { listExceptions, resolveExceptionApi } from './itad-exception-fixtures'
import { jobOverviewOk } from './itad-overview-fixtures'

/**
 * TC-ITAD-609 (operations dashboard spec D9, AC-708, AC-710): after receiving, open
 * missing and unexpected exceptions make the job orange, never red. Once resolved
 * (`lost_in_transit`, `accepted_into_job`) the reconciliation counters keep their values,
 * but the job needs no attention.
 */
test.describe('TC-ITAD-609: resolved discrepancies stop needing attention', () => {
  test('counters stay, attention goes', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    const tag = suffix.slice(-6).toUpperCase().replace(/[^A-Z0-9]/g, 'X')
    let companyId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA Overview D9 ${suffix}`)
      const job = await createSchedulableJob(request, token, companyId, `QA overview d9 ${suffix}`, { defaultDataBearing: false })
      const serials = [`RA${tag}`, `RB${tag}`, `RC${tag}`]
      await importManifestOk(request, token, job.id, { name: `d9-${tag}.csv`, content: csv([['Serial'], ...serials.map((serial) => [serial])]) }, { serial: 'Serial' })
      await advanceToReceiving(request, token, job.id)
      for (const serial of serials.slice(0, 2)) await scanOk(request, token, job.id, serial)
      await scanOk(request, token, job.id, `RU${tag}`)
      await classifyUndecided(request, token, job.id, false)
      expect(await transitionOk(request, token, job.id, { action: 'start_processing' })).toBe('processing')

      const open = await jobOverviewOk(request, token, job.id)
      expect(open.counters).toMatchObject({ missing: 1, unexpected: 1, openExceptions: 2, openMissingExceptions: 1, openUnexpectedExceptions: 1 })
      expect(open).toMatchObject({ severity: 'orange', group: 'attention_orange' })
      expect(open.signals.map((signal) => [signal.key, signal.severity])).toEqual([
        ['missing_exceptions', 'orange'],
        ['unexpected_exceptions', 'orange'],
      ])

      for (const entry of (await listExceptions(request, token, job.id, 'status=open')).items) {
        const outcome = entry.type === 'missing_from_delivery' ? 'lost_in_transit' : 'accepted_into_job'
        expect((await resolveExceptionApi(request, token, job.id, entry, outcome, 'Agreed with the customer')).status()).toBe(200)
      }

      const resolved = await jobOverviewOk(request, token, job.id)
      expect(resolved.counters).toMatchObject({ missing: 1, unexpected: 1, openExceptions: 0 })
      expect(resolved).toMatchObject({ severity: 'none', group: 'in_progress', signals: [] })
    } finally {
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { advanceToReceiving, createSchedulableJob, postTransition, uniqueSuffix } from './itad-job-fixtures'
import { csv, importManifestOk } from './itad-manifest-fixtures'
import { scanAction, scanOk } from './itad-receiving-fixtures'
import { exceptionDetail, listExceptions } from './itad-exception-fixtures'

/**
 * TC-ITAD-302 (exceptions spec TEST-404, same-device part; AC-404): every duplicate scan
 * opens its own DUPLICATE_SERIAL exception; "same device" by the receiving role (employee)
 * resolves the linked exception with outcome `same_device` and keeps its history; a scan
 * flagged as a different device keeps its exception OPEN.
 */
test.describe('TC-ITAD-302: duplicate scans as exceptions', () => {
  test('duplicate → exception; same device resolves it; different device stays open', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const employeeToken = await getAuthToken(request, 'employee')
    const suffix = uniqueSuffix()
    const tag = suffix.slice(-5).toUpperCase().replace(/[^A-Z0-9]/g, 'X')
    let companyId: string | null = null
    let jobId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD Exc Dup ${suffix}`)
      jobId = (await createSchedulableJob(request, token, companyId, `QA exc dup ${suffix}`)).id
      await importManifestOk(request, token, jobId, { name: `d-${tag}.csv`, content: csv([['Serial'], [`DA${tag}`], [`DB${tag}`]]) }, { serial: 'Serial' })
      await advanceToReceiving(request, token, jobId)
      await scanOk(request, token, jobId, `DA${tag}`)
      await scanOk(request, token, jobId, `DB${tag}`)
      const first = await scanOk(request, token, jobId, `DA${tag}`)
      const second = await scanOk(request, token, jobId, `DB${tag}`)
      expect([first.result, second.result]).toEqual(['DUPLICATE', 'DUPLICATE'])

      const open = await listExceptions(request, token, jobId, 'status=open')
      expect(open.items.map((entry) => [entry.type, entry.serial]).sort()).toEqual([
        ['duplicate_serial', `DA${tag}`],
        ['duplicate_serial', `DB${tag}`],
      ])
      const forFirst = open.items.find((entry) => entry.intakeScanId === first.scan.id)!
      expect(forFirst.assetId).toBe(first.asset.id)

      // The receiving operator resolves it through the domain action (Q7).
      expect((await scanAction(request, employeeToken, jobId, first.scan.id, 'resolve', 'Scanned twice by mistake')).status()).toBe(200)
      const resolved = await exceptionDetail(request, token, jobId, forFirst.id)
      expect(resolved).toMatchObject({ status: 'resolved', resolutionOutcome: 'same_device', resolutionReason: 'Scanned twice by mistake' })
      expect(resolved.events.map((event) => event.kind)).toEqual(['created', 'resolved'])

      // A different-device flag keeps the exception OPEN (resolved by a manager in Phase 2).
      expect((await scanAction(request, token, jobId, second.scan.id, 'flag-different-device', 'Second unit on the pallet')).status()).toBe(200)
      expect((await listExceptions(request, token, jobId, 'status=open')).items.map((entry) => entry.serial)).toEqual([`DB${tag}`])
    } finally {
      if (jobId) await postTransition(request, token, jobId, { action: 'cancel', reason: 'QA cleanup' }).catch(() => undefined)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

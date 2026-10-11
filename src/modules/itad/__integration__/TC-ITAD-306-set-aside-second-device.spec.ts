import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { advanceToReceiving, createSchedulableJob, postTransition, uniqueSuffix } from './itad-job-fixtures'
import { csv, importManifestOk } from './itad-manifest-fixtures'
import { classifyUndecided, getReconciliation, receivingCompleteView, scanAction, scanOk } from './itad-receiving-fixtures'
import { exceptionDetail, listExceptions, resolveExceptionApi, setAsideDuplicate } from './itad-exception-fixtures'

const errorCode = async (response: { json: () => Promise<unknown> }) => ((await response.json()) as { code?: string }).code

/**
 * TC-ITAD-306 (exceptions spec TEST-404, set-aside part; REQ-408): a duplicate flagged as
 * a different device blocks receiving until a manager sets the second unit aside; the
 * scan is closed as `different_device_set_aside` and the exception as
 * `second_device_set_aside`; a pending (not flagged) duplicate cannot be set aside; the
 * generic "Resolve" refuses duplicates; the receiving role cannot set aside.
 */
test.describe('TC-ITAD-306: second device set aside', () => {
  test('flagged duplicate → set aside → receiving can complete', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const employeeToken = await getAuthToken(request, 'employee')
    const suffix = uniqueSuffix()
    const tag = suffix.slice(-5).toUpperCase().replace(/[^A-Z0-9]/g, 'X')
    let companyId: string | null = null
    let jobId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD Exc SetAside ${suffix}`)
      jobId = (await createSchedulableJob(request, token, companyId, `QA exc set aside ${suffix}`, { defaultDataBearing: false })).id
      await importManifestOk(request, token, jobId, { name: `s-${tag}.csv`, content: csv([['Serial'], [`SA${tag}`]]) }, { serial: 'Serial' })
      await advanceToReceiving(request, token, jobId)
      await scanOk(request, token, jobId, `SA${tag}`)
      const duplicate = await scanOk(request, token, jobId, `SA${tag}`)
      await classifyUndecided(request, token, jobId, false)
      const exception = (await listExceptions(request, token, jobId, 'type=duplicate_serial')).items[0]

      // Not flagged yet: cannot be set aside; generic Resolve refuses duplicates.
      const early = await setAsideDuplicate(request, token, jobId, duplicate.scan.id, 'Second unit')
      expect(early.status()).toBe(409)
      expect(await errorCode(early)).toBe('itad.assets.errors.scan_not_flagged')
      const generic = await resolveExceptionApi(request, token, jobId, exception, 'same_device', 'Shortcut')
      expect(generic.status()).toBe(409)
      expect(await errorCode(generic)).toBe('itad.exceptions.errors.resolve_through_domain_action')

      expect((await scanAction(request, token, jobId, duplicate.scan.id, 'flag-different-device', 'Two units, same label')).status()).toBe(200)
      expect((await receivingCompleteView(request, token, jobId))?.detailKey).toBe('itad.jobs.conditions.detail.differentDeviceUnresolved')

      expect((await setAsideDuplicate(request, employeeToken, jobId, duplicate.scan.id, 'Second unit')).status()).toBe(403)
      expect((await setAsideDuplicate(request, token, jobId, duplicate.scan.id, null)).status()).toBe(400)
      expect((await setAsideDuplicate(request, token, jobId, duplicate.scan.id, 'Second unit kept in the quarantine cage')).status()).toBe(200)

      expect(await exceptionDetail(request, token, jobId, exception.id)).toMatchObject({
        status: 'resolved',
        resolutionOutcome: 'second_device_set_aside',
        resolutionReason: 'Second unit kept in the quarantine cage',
      })
      expect(await getReconciliation(request, token, jobId)).toMatchObject({ pendingDuplicates: 0, differentDeviceUnresolved: 0 })
      expect(await receivingCompleteView(request, token, jobId)).toMatchObject({ state: 'met' })
    } finally {
      if (jobId) await postTransition(request, token, jobId, { action: 'cancel', reason: 'QA cleanup' }).catch(() => undefined)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

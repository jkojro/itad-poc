import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { getTokenScope, readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { advanceToReceiving, createSchedulableJob, postTransition, transitionOk, uniqueSuffix } from './itad-job-fixtures'
import { csv, importManifestOk } from './itad-manifest-fixtures'
import { classifyUndecided, scanOk } from './itad-receiving-fixtures'
import {
  assignExceptionApi,
  exceptionDetail,
  getAssignees,
  listExceptions,
  resolveExceptionApi,
} from './itad-exception-fixtures'

const errorCode = async (response: { json: () => Promise<unknown> }) => ((await response.json()) as { code?: string }).code

/**
 * TC-ITAD-307 (exceptions spec TEST-407, TEST-406 assignment part; REQ-403, REQ-411):
 * assign, reassign and unassign are recorded and never resolve; the assignee must be an
 * active user of the organization; `assignedTo=me` / `unassigned` filters; a resolved
 * exception cannot be assigned; the view-only employee cannot assign or resolve.
 */
test.describe('TC-ITAD-307: exception assignment', () => {
  test('assign, reassign, unassign; invalid assignee; resolved exception; view-only', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const employeeToken = await getAuthToken(request, 'employee')
    const adminId = getTokenScope(token).userId
    const employeeId = getTokenScope(employeeToken).userId
    const suffix = uniqueSuffix()
    const tag = suffix.slice(-5).toUpperCase().replace(/[^A-Z0-9]/g, 'X')
    let companyId: string | null = null
    let jobId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD Exc Assign ${suffix}`)
      jobId = (await createSchedulableJob(request, token, companyId, `QA exc assign ${suffix}`, { defaultDataBearing: false })).id
      await importManifestOk(request, token, jobId, { name: `a-${tag}.csv`, content: csv([['Serial'], [`AS${tag}`], [`AM${tag}`]]) }, { serial: 'Serial' })
      await advanceToReceiving(request, token, jobId)
      await scanOk(request, token, jobId, `AS${tag}`)
      await classifyUndecided(request, token, jobId, false)
      await transitionOk(request, token, jobId, { action: 'start_processing' })
      let exception = (await listExceptions(request, token, jobId, 'status=open')).items[0]
      expect(exception.type).toBe('missing_from_delivery')

      const assignees = (await readJsonSafe<{ items: Array<{ id: string }> }>(await getAssignees(request, token)))?.items ?? []
      expect(assignees.map((user) => user.id)).toEqual(expect.arrayContaining([adminId, employeeId]))

      // The view-only employee can neither assign nor resolve.
      expect((await assignExceptionApi(request, employeeToken, jobId, exception, employeeId)).status()).toBe(403)
      expect((await resolveExceptionApi(request, employeeToken, jobId, exception, 'not_shipped', 'Nope')).status()).toBe(403)

      const invalid = await assignExceptionApi(request, token, jobId, exception, '00000000-0000-4000-8000-000000000000')
      expect(invalid.status()).toBe(400)
      expect(await errorCode(invalid)).toBe('itad.exceptions.errors.assignee_invalid')

      expect((await assignExceptionApi(request, token, jobId, exception, employeeId)).status()).toBe(200)
      exception = await exceptionDetail(request, token, jobId, exception.id)
      expect(exception).toMatchObject({ status: 'open', assignedTo: { id: employeeId } })
      expect((await listExceptions(request, employeeToken, jobId, 'assignedTo=me')).total).toBe(1)
      expect((await listExceptions(request, token, jobId, 'assignedTo=unassigned')).total).toBe(0)

      expect((await assignExceptionApi(request, token, jobId, exception, adminId)).status()).toBe(200)
      exception = await exceptionDetail(request, token, jobId, exception.id)
      expect((await assignExceptionApi(request, token, jobId, exception, null)).status()).toBe(200)
      const history = await exceptionDetail(request, token, jobId, exception.id)
      expect(history.status).toBe('open')
      expect(history.assignedTo).toBeNull()
      expect(history.events.map((event) => event.kind)).toEqual(['created', 'assigned', 'assigned', 'unassigned'])

      expect((await resolveExceptionApi(request, token, jobId, history, 'lost_in_transit', 'Courier confirmed the loss')).status()).toBe(200)
      const late = await assignExceptionApi(request, token, jobId, await exceptionDetail(request, token, jobId, exception.id), adminId)
      expect(late.status()).toBe(409)
      expect(await errorCode(late)).toBe('itad.exceptions.errors.exception_resolved')
    } finally {
      if (jobId) await postTransition(request, token, jobId, { action: 'cancel', reason: 'QA cleanup' }).catch(() => undefined)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

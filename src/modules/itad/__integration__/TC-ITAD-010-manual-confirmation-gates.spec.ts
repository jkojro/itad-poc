import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import {
  createRoleFixture,
  createUserFixture,
  deleteRoleIfExists,
  deleteUserIfExists,
  setRoleAclFeatures,
} from '@open-mercato/core/helpers/integration/authFixtures'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { getTokenContext, readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import {
  CONFIRM,
  createSchedulableJob,
  errorCode,
  getJob,
  postTransition,
  uniqueSuffix,
} from './itad-job-fixtures'
import { advanceToProcessing } from './itad-flow-fixtures'

type TransitionsView = {
  canTransition: boolean
  canConfirm: boolean
  actions: Array<{ id: string; allowed: boolean; conditions: Array<{ key: string; state: string; canConfirm: boolean }> }>
}

/**
 * TC-ITAD-010 (spec TEST-007, TEST-009b transition part): an operator with
 * `itad.jobs.transition` but without `itad.jobs.confirm_conditions` cannot pass a manual
 * condition (400 unconfirmed, 403 when confirming); a view-only user gets 403 on any
 * transition; invalid confirmations are rejected with their exact codes.
 */
test.describe('TC-ITAD-010: manual confirmation and transition permissions', () => {
  test('operator, viewer and invalid confirmations are rejected precisely', async ({ request }) => {
    const adminToken = await getAuthToken(request, 'admin')
    const { tenantId, organizationId } = getTokenContext(adminToken)
    const suffix = uniqueSuffix()
    const safe = suffix.replace(/[^a-z0-9]/gi, '_')
    let companyId: string | null = null
    let jobId: string | null = null
    const roleIds: string[] = []
    const userIds: string[] = []
    const makeUser = async (role: string, features: string[]) => {
      const roleId = await createRoleFixture(request, adminToken, { name: `${role}_${safe}`, tenantId })
      roleIds.push(roleId)
      await setRoleAclFeatures(request, adminToken, { roleId, features })
      const email = `qa-itad-${role}-${suffix}@example.test`
      const password = `Qa-${suffix}-Secret!`
      userIds.push(await createUserFixture(request, adminToken, { email, password, organizationId, roles: [`${role}_${safe}`] }))
      return getAuthToken(request, email, password)
    }
    try {
      companyId = await createCompanyFixture(request, adminToken, `QA ITAD Gates ${suffix}`)
      jobId = (await createSchedulableJob(request, adminToken, companyId, `QA gates ${suffix}`)).id
      // Manual confirmations are exercised on `start_closeout` (allAssetsProcessed): since the
      // manifest spec Phase 4, receivingComplete is a data condition that is never confirmed by hand.
      await advanceToProcessing(request, adminToken, jobId)

      const operatorToken = await makeUser('qa_itad_operator', ['itad.jobs.view', 'itad.jobs.manage', 'itad.jobs.transition'])
      const viewerToken = await makeUser('qa_itad_viewer', ['itad.jobs.view'])

      const view = await apiRequest(request, 'GET', `/api/itad/jobs/${jobId}/transitions`, { token: operatorToken })
      const operatorView = await readJsonSafe<TransitionsView>(view)
      expect(operatorView?.canTransition).toBe(true)
      expect(operatorView?.canConfirm).toBe(false)
      const startCloseout = operatorView?.actions.find((action) => action.id === 'start_closeout')
      expect(startCloseout?.allowed).toBe(false)
      expect(startCloseout?.conditions[0]).toMatchObject({ key: 'allAssetsProcessed', state: 'confirmation_required', canConfirm: false })

      const unconfirmed = await postTransition(request, operatorToken, jobId, { action: 'start_closeout' })
      expect(unconfirmed.status()).toBe(400)
      expect(await errorCode(unconfirmed)).toBe('itad.jobs.errors.condition_unmet')

      const operatorConfirm = await postTransition(request, operatorToken, jobId, {
        action: 'start_closeout',
        confirmations: [CONFIRM('allAssetsProcessed')],
      })
      expect(operatorConfirm.status()).toBe(403)

      const viewerMove = await postTransition(request, viewerToken, jobId, { action: 'hold', reason: 'viewer try' })
      expect(viewerMove.status()).toBe(403)

      const duplicate = await postTransition(request, adminToken, jobId, {
        action: 'start_closeout',
        confirmations: [CONFIRM('allAssetsProcessed'), CONFIRM('allAssetsProcessed')],
      })
      expect(duplicate.status()).toBe(400)
      expect(await errorCode(duplicate)).toBe('itad.jobs.errors.confirmation_duplicate')

      const unrelated = await postTransition(request, adminToken, jobId, {
        action: 'start_closeout',
        confirmations: [CONFIRM('allAssetsProcessed'), CONFIRM('noBlockingExceptions')],
      })
      expect(unrelated.status()).toBe(400)
      expect(await errorCode(unrelated)).toBe('itad.jobs.errors.confirmation_not_required')

      const noComment = await postTransition(request, adminToken, jobId, {
        action: 'start_closeout',
        confirmations: [{ condition: 'allAssetsProcessed', comment: ' ' }],
      })
      expect(noComment.status()).toBe(400)
      expect(await errorCode(noComment)).toBe('itad.jobs.errors.comment_required')

      expect((await getJob(request, adminToken, jobId))?.status).toBe('processing')
    } finally {
      if (jobId) await postTransition(request, adminToken, jobId, { action: 'cancel', reason: 'QA cleanup' }).catch(() => undefined)
      for (const id of userIds) await deleteUserIfExists(request, adminToken, id)
      for (const id of roleIds) await deleteRoleIfExists(request, adminToken, id)
      await deleteEntityIfExists(request, adminToken, '/api/customers/companies', companyId)
    }
  })
})

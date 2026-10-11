import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import {
  createOrganizationFixture,
  createRoleFixture,
  createUserFixture,
  deleteOrganizationIfExists,
  deleteRoleIfExists,
  deleteUserIfExists,
  setRoleAclFeatures,
} from '@open-mercato/core/helpers/integration/authFixtures'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { getTokenContext } from '@open-mercato/core/helpers/integration/generalFixtures'
import { createSchedulableJob, postTransition, uniqueSuffix } from './itad-job-fixtures'
import { approveRetry, currentAssets, processingJobWithDataBearingAssets, recordResult, startRunOk } from './itad-sanitization-fixtures'
import { assignExceptionApi, getExceptions, listExceptions, resolveExceptionApi } from './itad-exception-fixtures'

/**
 * TC-ITAD-304 (exceptions spec TEST-406; AC-407): `itad.exceptions.view` reads
 * exceptions; without it the list is 403; sanitization execute alone cannot assign or
 * resolve; a sanitization manager without
 * `itad.exceptions.manage` cannot approve the retry (403, nothing changes); another
 * organization gets 404.
 */
test.describe('TC-ITAD-304: exception permissions', () => {
  test('view, retry needs exceptions.manage, organization isolation', async ({ request }) => {
    const adminToken = await getAuthToken(request, 'admin')
    const employeeToken = await getAuthToken(request, 'employee')
    const { tenantId, organizationId } = getTokenContext(adminToken)
    const suffix = uniqueSuffix()
    const safe = suffix.replace(/[^a-z0-9]/gi, '_')
    let companyId: string | null = null
    let jobId: string | null = null
    let orgBId: string | null = null
    const roleIds: string[] = []
    const userIds: string[] = []
    try {
      companyId = await createCompanyFixture(request, adminToken, `QA ITAD Exc ACL ${suffix}`)
      jobId = (await createSchedulableJob(request, adminToken, companyId, `QA exc acl ${suffix}`)).id
      const [asset] = await processingJobWithDataBearingAssets(request, adminToken, jobId, 1)
      const runId = await startRunOk(request, adminToken, jobId, asset)
      expect((await recordResult(request, adminToken, jobId, runId, { result: 'FAIL', verificationMethod: 'none', verificationNotes: 'Locked drive' })).status()).toBe(200)

      const tokenWith = async (label: string, features: string[]) => {
        const roleName = `qa_itad_${label}_${safe}`
        const roleId = await createRoleFixture(request, adminToken, { name: roleName, tenantId })
        roleIds.push(roleId)
        await setRoleAclFeatures(request, adminToken, { roleId, features })
        const email = `qa-itad-${label}-${suffix}@example.test`
        const password = `Qa-${suffix}-Secret!`
        userIds.push(await createUserFixture(request, adminToken, { email, password, organizationId, roles: [roleName] }))
        return getAuthToken(request, email, password)
      }

      // Employee holds itad.exceptions.view by default.
      expect((await listExceptions(request, employeeToken, jobId)).items.map((entry) => entry.type)).toEqual(['sanitization_failed'])
      const noView = await tokenWith('exc_none', ['itad.jobs.view', 'itad.assets.view'])
      expect((await getExceptions(request, noView, jobId)).status()).toBe(403)

      // Sanitization execute alone grants no exception management (E4-042).
      const technician = await tokenWith('san_exec', ['itad.jobs.view', 'itad.assets.view', 'itad.sanitization.view', 'itad.sanitization.execute', 'itad.exceptions.view'])
      const failed = (await listExceptions(request, adminToken, jobId, 'status=open')).items[0]
      expect((await assignExceptionApi(request, technician, jobId, failed, null)).status()).toBe(403)
      expect((await resolveExceptionApi(request, technician, jobId, failed, 'not_shipped', 'Not allowed')).status()).toBe(403)

      // A sanitization manager without exceptions.manage cannot approve the retry (Q6).
      const sanitizationManager = await tokenWith('san_mgr', [
        'itad.jobs.view',
        'itad.assets.view',
        'itad.sanitization.view',
        'itad.sanitization.manage',
      ])
      const [review] = await currentAssets(request, adminToken, jobId, [asset.serial])
      expect((await approveRetry(request, sanitizationManager, jobId, review, 'Try again')).status()).toBe(403)
      expect((await currentAssets(request, adminToken, jobId, [asset.serial]))[0].status).toBe('review_required')
      expect((await listExceptions(request, adminToken, jobId, 'status=open')).total).toBe(1)

      // With both features the retry works and resolves the exception.
      const bothManager = await tokenWith('san_exc_mgr', [
        'itad.jobs.view',
        'itad.assets.view',
        'itad.sanitization.view',
        'itad.sanitization.manage',
        'itad.exceptions.view',
        'itad.exceptions.manage',
      ])
      expect((await approveRetry(request, bothManager, jobId, review, 'Try again')).status()).toBe(200)
      expect((await listExceptions(request, adminToken, jobId, 'status=open')).total).toBe(0)

      orgBId = await createOrganizationFixture(request, adminToken, { name: `QA ITAD Exc Org B ${suffix}`, tenantId })
      expect((await getExceptions(request, adminToken, jobId, '', orgBId)).status()).toBe(404)
    } finally {
      for (const userId of userIds) await deleteUserIfExists(request, adminToken, userId)
      for (const roleId of roleIds) await deleteRoleIfExists(request, adminToken, roleId)
      if (jobId) await postTransition(request, adminToken, jobId, { action: 'cancel', reason: 'QA cleanup' }).catch(() => undefined)
      await deleteEntityIfExists(request, adminToken, '/api/customers/companies', companyId)
      await deleteOrganizationIfExists(request, adminToken, orgBId)
    }
  })
})

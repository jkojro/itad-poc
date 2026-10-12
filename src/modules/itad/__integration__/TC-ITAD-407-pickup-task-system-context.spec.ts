import { test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import {
  createRoleFixture,
  createUserFixture,
  deleteRoleIfExists,
  deleteUserIfExists,
  setRoleAclFeatures,
} from '@open-mercato/core/helpers/integration/authFixtures'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { getTokenContext } from '@open-mercato/core/helpers/integration/generalFixtures'
import { createSchedulableJob, transitionOk, uniqueSuffix } from './itad-job-fixtures'
import { waitForPickupTasks } from './itad-pickup-fixtures'

/**
 * TC-ITAD-407 (pickup calendar spec REQ-512): a user who may schedule jobs but holds no
 * `customers` interaction features still gets the pickup task; the sync runs in the
 * system command context, not as that user.
 */
test.describe('TC-ITAD-407: pickup task without customers features', () => {
  test('an ITAD-only user schedules and the task is created', async ({ request }) => {
    const adminToken = await getAuthToken(request, 'admin')
    const { tenantId, organizationId } = getTokenContext(adminToken)
    const suffix = uniqueSuffix()
    const safe = suffix.replace(/[^a-z0-9]/gi, '_')
    const roleName = `qa_itad_pickup_${safe}`
    let companyId: string | null = null
    let roleId: string | null = null
    let userId: string | null = null
    try {
      companyId = await createCompanyFixture(request, adminToken, `QA ITAD Pickup ACL ${suffix}`)
      roleId = await createRoleFixture(request, adminToken, { name: roleName, tenantId })
      await setRoleAclFeatures(request, adminToken, { roleId, features: ['itad.jobs.view', 'itad.jobs.manage', 'itad.jobs.transition'] })
      const email = `qa-itad-pickup-${suffix}@example.test`
      const password = `Qa-${suffix}-Secret!`
      userId = await createUserFixture(request, adminToken, { email, password, organizationId, roles: [roleName] })
      const itadOnly = await getAuthToken(request, email, password)

      const job = await createSchedulableJob(request, itadOnly, companyId, `QA pickup acl ${suffix}`)
      await transitionOk(request, itadOnly, job.id, { action: 'schedule' })
      await waitForPickupTasks(request, adminToken, companyId, (tasks) => tasks.length === 1 && tasks[0].status === 'planned', 'task created for an ITAD-only user')
    } finally {
      await deleteUserIfExists(request, adminToken, userId)
      await deleteRoleIfExists(request, adminToken, roleId)
      await deleteEntityIfExists(request, adminToken, '/api/customers/companies', companyId)
    }
  })
})

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
import { getTokenContext } from '@open-mercato/core/helpers/integration/generalFixtures'
import { createSchedulableJob, uniqueSuffix } from './itad-job-fixtures'
import { processingJobWithDataBearingAssets } from './itad-sanitization-fixtures'
import { assetCertificates, downloadPdf, issueCertificate, issueCertificateOk, passAsset } from './itad-certificate-fixtures'

/**
 * TC-ITAD-504 (certificates spec Q8, REQ-617): sanitization features grant no certificate
 * capability; `itad.certificates.view` reads and downloads but cannot issue.
 */
test.describe('TC-ITAD-504: certificate permissions', () => {
  test('capabilities are separate from sanitization', async ({ request }) => {
    const adminToken = await getAuthToken(request, 'admin')
    const { tenantId, organizationId } = getTokenContext(adminToken)
    const suffix = uniqueSuffix()
    const safe = suffix.replace(/[^a-z0-9]/gi, '_')
    let companyId: string | null = null
    const roleIds: string[] = []
    const userIds: string[] = []
    try {
      companyId = await createCompanyFixture(request, adminToken, `QA ITAD Cert ACL ${suffix}`)
      const job = await createSchedulableJob(request, adminToken, companyId, `QA cert acl ${suffix}`)
      const [issuedAsset, freshAsset] = await processingJobWithDataBearingAssets(request, adminToken, job.id, 2)
      await passAsset(request, adminToken, job.id, issuedAsset)
      await passAsset(request, adminToken, job.id, freshAsset)
      const issued = await issueCertificateOk(request, adminToken, job.id, issuedAsset.id)

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

      const technician = await tokenWith('cert_tech', [
        'itad.jobs.view',
        'itad.assets.view',
        'itad.sanitization.view',
        'itad.sanitization.execute',
        'itad.sanitization.manage',
      ])
      expect((await assetCertificates(request, technician, job.id, issuedAsset.id)).status()).toBe(403)
      expect((await issueCertificate(request, technician, job.id, freshAsset.id)).status()).toBe(403)

      const viewer = await tokenWith('cert_view', ['itad.jobs.view', 'itad.assets.view', 'itad.certificates.view'])
      expect((await assetCertificates(request, viewer, job.id, issuedAsset.id)).status()).toBe(200)
      expect((await downloadPdf(request, viewer, job.id, issued.id)).status()).toBe(200)
      expect((await issueCertificate(request, viewer, job.id, freshAsset.id)).status()).toBe(403)
    } finally {
      for (const userId of userIds) await deleteUserIfExists(request, adminToken, userId)
      for (const roleId of roleIds) await deleteRoleIfExists(request, adminToken, roleId)
      await deleteEntityIfExists(request, adminToken, '/api/customers/companies', companyId)
    }
  })
})

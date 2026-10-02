import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import {
  apiRequestWithSelectedOrg,
  createOrganizationFixture,
  deleteOrganizationIfExists,
} from '@open-mercato/core/helpers/integration/authFixtures'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { getTokenContext, readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { createJob, deleteJobIfExists, uniqueSuffix } from './itadJobFixtures'

/**
 * TC-ITAD-004 (spec TEST-009a): a job owned by organization A is invisible to and not
 * writable from organization B (404, no data), a company from A cannot be used as the
 * customer of a job in B, and the same customer reference is allowed in B.
 */
test.describe('TC-ITAD-004: ITAD jobs are isolated per organization', () => {
  test('organization B cannot read, update or delete a job of organization A', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const { tenantId } = getTokenContext(token)
    const suffix = uniqueSuffix()
    const reference = `ISO-${suffix}`
    let companyAId: string | null = null
    let companyBId: string | null = null
    let orgBId: string | null = null
    let jobAId: string | null = null
    let jobBId: string | null = null
    try {
      companyAId = await createCompanyFixture(request, token, `QA ITAD Org A ${suffix}`)
      const jobA = await createJob(request, token, {
        customerId: companyAId,
        name: `QA isolation ${suffix}`,
        customerReference: reference,
      })
      jobAId = jobA.id

      orgBId = await createOrganizationFixture(request, token, { name: `QA ITAD Org B ${suffix}`, tenantId })
      const asOrgB = (method: string, path: string, data?: unknown) =>
        apiRequestWithSelectedOrg(request, method, path, { token, selectedOrgId: orgBId!, data })

      const read = await asOrgB('GET', `/api/itad/jobs?id=${encodeURIComponent(jobA.id)}&pageSize=1`)
      expect(read.status()).toBe(200)
      const readBody = await readJsonSafe<{ items?: unknown[] }>(read)
      expect(readBody?.items ?? []).toHaveLength(0)

      const update = await asOrgB('PUT', '/api/itad/jobs', { id: jobA.id, name: 'hijacked' })
      expect(update.status()).toBe(404)
      const remove = await asOrgB('DELETE', '/api/itad/jobs', { id: jobA.id })
      expect(remove.status()).toBe(404)

      const foreignCustomer = await asOrgB('POST', '/api/itad/jobs', { customerId: companyAId, name: `QA foreign ${suffix}` })
      expect(foreignCustomer.status()).toBe(400)
      expect((await readJsonSafe<{ code?: string }>(foreignCustomer))?.code).toBe('itad.jobs.errors.customer_invalid')

      const companyB = await asOrgB('POST', '/api/customers/companies', { displayName: `QA ITAD Org B Co ${suffix}` })
      expect(companyB.status()).toBe(201)
      companyBId = (await readJsonSafe<{ id?: string }>(companyB))?.id ?? null
      const jobB = await asOrgB('POST', '/api/itad/jobs', {
        customerId: companyBId,
        name: `QA same reference ${suffix}`,
        customerReference: reference,
      })
      expect(jobB.status()).toBe(201)
      jobBId = (await readJsonSafe<{ id?: string }>(jobB))?.id ?? null
    } finally {
      if (orgBId && jobBId) {
        await apiRequestWithSelectedOrg(request, 'DELETE', '/api/itad/jobs', { token, selectedOrgId: orgBId, data: { id: jobBId } }).catch(() => undefined)
      }
      if (orgBId && companyBId) {
        await apiRequestWithSelectedOrg(request, 'DELETE', `/api/customers/companies?id=${encodeURIComponent(companyBId)}`, { token, selectedOrgId: orgBId }).catch(() => undefined)
      }
      await deleteJobIfExists(request, token, jobAId)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyAId)
      await deleteOrganizationIfExists(request, token, orgBId)
    }
  })
})

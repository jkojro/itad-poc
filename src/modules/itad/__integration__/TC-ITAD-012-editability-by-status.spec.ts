import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { createSchedulableJob, errorCode, getJob, postTransition, transitionOk, uniqueSuffix } from './itadJobFixtures'

/**
 * TC-ITAD-012 (spec TEST-008, "Field editability by status"): scheduledPickupAt is
 * editable but not clearable in scheduled and locked from in_transit; the estimate is
 * locked from receiving; on_hold follows its pre-hold column; customerId is draft-only.
 */
test.describe('TC-ITAD-012: field editability follows the status matrix', () => {
  test('locks fields per status, including on_hold', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    let companyId: string | null = null
    let otherCompanyId: string | null = null
    let jobId: string | null = null
    const put = (data: Record<string, unknown>) => apiRequest(request, 'PUT', '/api/itad/jobs', { token, data: { id: jobId, ...data } })
    const later = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString()
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD Edit ${suffix}`)
      otherCompanyId = await createCompanyFixture(request, token, `QA ITAD Edit Other ${suffix}`)
      jobId = (await createSchedulableJob(request, token, companyId, `QA edit ${suffix}`, { expectedAssetEstimate: 500 })).id
      await transitionOk(request, token, jobId, { action: 'schedule' })

      expect((await put({ scheduledPickupAt: later(3) })).status()).toBe(200)
      const clear = await put({ scheduledPickupAt: null })
      expect(clear.status()).toBe(400)
      expect(await errorCode(clear)).toBe('itad.jobs.errors.field_locked')
      const customer = await put({ customerId: otherCompanyId })
      expect(await errorCode(customer)).toBe('itad.jobs.errors.field_locked')

      await transitionOk(request, token, jobId, { action: 'dispatch' })
      const pickup = await put({ scheduledPickupAt: later(5) })
      expect(await errorCode(pickup)).toBe('itad.jobs.errors.field_locked')
      expect((await put({ expectedAssetEstimate: 487 })).status()).toBe(200)

      await transitionOk(request, token, jobId, { action: 'hold', reason: 'truck delayed' })
      expect((await getJob(request, token, jobId))?.editableFields).toEqual(['name', 'customerReference', 'expectedAssetEstimate'])
      expect((await put({ expectedAssetEstimate: 480 })).status()).toBe(200)
      await transitionOk(request, token, jobId, { action: 'resume' })

      await transitionOk(request, token, jobId, { action: 'start_receiving' })
      const estimate = await put({ expectedAssetEstimate: 470 })
      expect(estimate.status()).toBe(400)
      expect(await errorCode(estimate)).toBe('itad.jobs.errors.field_locked')
      expect((await put({ name: `QA edit renamed ${suffix}` })).status()).toBe(200)
      expect(await getJob(request, token, jobId)).toMatchObject({ expectedAssetEstimate: 480, name: `QA edit renamed ${suffix}` })
    } finally {
      if (jobId) await postTransition(request, token, jobId, { action: 'cancel', reason: 'QA cleanup' }).catch(() => undefined)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
      await deleteEntityIfExists(request, token, '/api/customers/companies', otherCompanyId)
    }
  })
})

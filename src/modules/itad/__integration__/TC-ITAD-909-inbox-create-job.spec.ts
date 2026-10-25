import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, createPersonFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { getTokenScope } from '@open-mercato/core/helpers/integration/generalFixtures'
import { deleteJobIfExists, getJob, uniqueSuffix } from './itad-job-fixtures'
import { latestActionLog } from './itad-ai-fixtures'
import { acceptAction, importInboxMessage, inboxDetail, newPickup, selectMatch, waitProcessed } from './itad-inbox-fixtures'

/**
 * TC-ITAD-909 (Inbox Ops spec Phase 3, PDF §4.1 I1, US-IN-01): a new-pickup email from a
 * known customer becomes a `create_job` action; Accept creates the job through
 * `itad.jobs.create` as the operator with customer, reference, estimate, pickup (in the
 * email's zone) and location, links it to the message and logs the email audit context. A
 * second Accept creates nothing. A sender with no customer blocks Accept until the
 * operator chooses the customer in Match.
 */
test.describe('TC-ITAD-909: Inbox create job (I1)', () => {
  test('known sender → accept creates the job; unknown sender → choose the customer first', async ({ request }) => {
    test.setTimeout(180_000)
    const token = await getAuthToken(request, 'admin')
    const { userId } = getTokenScope(token)
    const suffix = uniqueSuffix()
    const jobIds: string[] = []
    let companyId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA Inbox New ${suffix}`)
      const sender = `qa-new-${suffix}@customer.example`
      await createPersonFixture(request, token, { firstName: 'Ewa', lastName: 'N', displayName: `Ewa N ${suffix}`, companyEntityId: companyId, primaryEmail: sender })
      const year = new Date().getUTCFullYear() + 1
      const reference = `PO-${suffix}`
      const location = `Warehouse 3, Prosta 20, Warsaw ${suffix}`
      const message = await waitProcessed(
        request,
        token,
        await importInboxMessage(request, token, {
          fromAddress: sender,
          subject: 'New pickup request',
          bodyText: `Hello, please collect about 40 laptops from ${location} on 10 June ${year} at 9:00. Our reference: ${reference}.`,
          extraction: newPickup({
            name: 'Laptop refresh',
            reference,
            estimate: { value: 40, quote: 'about 40 laptops' },
            location,
            pickup: { localDateTime: `${year}-06-10T09:00`, quote: `10 June ${year} at 9:00` },
          }),
        }),
      )
      const [action] = message.actions
      // The customer is known from the sender only: needs review, never high (spec "Match status").
      expect(action).toMatchObject({
        type: 'create_job',
        matchStatus: 'needs_review',
        missingFields: [],
        payload: { name: 'Laptop refresh', customerReference: reference, expectedAssetEstimate: 40, pickupLocation: location, scheduledPickupAt: `${year}-06-10T09:00` },
      })
      expect(action.target.customer).toMatchObject({ id: companyId })

      const accepted = await acceptAction(request, token, action)
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200)
      expect(accepted.body).toMatchObject({ status: 'executed' })
      const jobId = String(accepted.body!.recordId)
      jobIds.push(jobId)
      const job = (await getJob(request, token, jobId))!
      // 09:00 in Warsaw in June (UTC+2) is 07:00 UTC.
      expect(job).toMatchObject({
        name: 'Laptop refresh',
        customerId: companyId,
        customerReference: reference,
        expectedAssetEstimate: 40,
        pickupLocation: location,
        scheduledPickupAt: `${year}-06-10T07:00:00.000Z`,
        status: 'draft',
      })
      const log = await latestActionLog(request, token, jobId)
      expect(log).toMatchObject({ actorUserId: userId, commandId: 'itad.jobs.create' })
      expect(log?.context).toMatchObject({ channel: 'email', toolName: 'inbox.create_job', actionId: action.id, proposalId: message.id })

      const decided = await inboxDetail(request, token, message.id)
      expect(decided.match).toMatchObject({ job: { id: jobId } })
      expect(decided.actions[0]).toMatchObject({ status: 'executed', result: { recordId: jobId } })
      // A second Accept (stale or not) creates nothing.
      expect((await acceptAction(request, token, action)).status).toBe(409)
      expect((await acceptAction(request, token, decided.actions[0])).status).toBe(409)

      // An unknown sender: no customer, Accept blocked until the operator chooses one.
      const unknown = await waitProcessed(
        request,
        token,
        await importInboxMessage(request, token, {
          fromAddress: `qa-new-unknown-${suffix}@elsewhere.example`,
          subject: 'Pickup',
          bodyText: 'Hi, we have a few monitors to recycle, can you collect them?',
          extraction: newPickup({ name: 'Monitors' }),
        }),
      )
      const [blocked] = unknown.actions
      expect(blocked).toMatchObject({ type: 'create_job', missingFields: ['customerId'] })
      expect((await acceptAction(request, token, blocked)).status).toBe(400)
      const chosen = await selectMatch(request, token, unknown, { customerId: companyId, jobId: null })
      expect(chosen.status, JSON.stringify(chosen.body)).toBe(200)
      const [ready] = (await inboxDetail(request, token, unknown.id)).actions
      expect(ready).toMatchObject({ type: 'create_job', missingFields: [] })
      expect(ready.target.customer).toMatchObject({ id: companyId })
      const created = await acceptAction(request, token, ready)
      expect(created.status, JSON.stringify(created.body)).toBe(200)
      jobIds.push(String(created.body!.recordId))
      expect((await getJob(request, token, String(created.body!.recordId)))!).toMatchObject({ name: 'Monitors', customerId: companyId, pickupLocation: null })
    } finally {
      for (const jobId of jobIds) await deleteJobIfExists(request, token, jobId)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, createPersonFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { createSchedulableJob, getJob, transitionOk, uniqueSuffix } from './itad-job-fixtures'
import { acceptAction, editAction, importInboxMessage, inboxDetail, movePickup, selectMatch, waitProcessed } from './itad-inbox-fixtures'

/**
 * TC-ITAD-908 (Inbox Ops spec "Match status", "Target vs fields", PDF §4.3 "ambiguity
 * requires a choice"): a sender whose company has two active jobs gives an ambiguous
 * match — the action has no target and cannot be accepted. The operator picks the job in
 * the Match panel: the action is superseded and rebuilt from the stored interpretation
 * (no model call) with the new target and its version, keeping the operator's edit; then
 * Accept works on the chosen job only.
 */
test.describe('TC-ITAD-908: Inbox choose the match', () => {
  test('ambiguous → pick the job → rebuilt action with target and version → accept', async ({ request }) => {
    test.setTimeout(180_000)
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    let companyId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA Inbox Choose ${suffix}`)
      const sender = `qa-choose-${suffix}@customer.example`
      await createPersonFixture(request, token, { firstName: 'Ola', lastName: 'C', displayName: `Ola C ${suffix}`, companyEntityId: companyId, primaryEmail: sender })
      const first = await createSchedulableJob(request, token, companyId, `QA inbox choose 1 ${suffix}`)
      const second = await createSchedulableJob(request, token, companyId, `QA inbox choose 2 ${suffix}`)
      await transitionOk(request, token, first.id, { action: 'schedule' })
      await transitionOk(request, token, second.id, { action: 'schedule' })
      const year = new Date().getUTCFullYear() + 1
      const message = await waitProcessed(
        request,
        token,
        await importInboxMessage(request, token, {
          fromAddress: sender,
          subject: 'Pickup date',
          bodyText: `Hi, could you move our pickup to 5 March ${year} at 12:00?`,
          extraction: movePickup(`${year}-03-05T12:00`, `5 March ${year} at 12:00`),
        }),
      )
      expect(message).toMatchObject({ matchStatus: 'ambiguous', match: { job: null } })
      const [ambiguous] = message.actions
      expect(ambiguous).toMatchObject({ type: 'update_pickup', matchStatus: 'ambiguous', missingFields: ['jobId'] })
      expect(ambiguous.target.job).toBeNull()
      expect((await acceptAction(request, token, ambiguous)).status).toBe(400)

      // The operator corrects the time before choosing the job: the edit survives the rebuild.
      expect((await editAction(request, token, ambiguous, { scheduledPickupAt: `${year}-03-06T08:00` })).status).toBe(200)
      const beforeChoice = await inboxDetail(request, token, message.id)
      const chosen = await selectMatch(request, token, beforeChoice, { jobId: second.id })
      expect(chosen.status, JSON.stringify(chosen.body)).toBe(200)

      const rebuilt = await inboxDetail(request, token, message.id)
      expect(rebuilt.match).toMatchObject({ job: { id: second.id } })
      expect(rebuilt.matchStatus).toBe('high')
      expect(rebuilt.actions).toHaveLength(1)
      const [action] = rebuilt.actions
      expect(action.id).not.toBe(ambiguous.id)
      expect(action).toMatchObject({
        matchStatus: 'high',
        missingFields: [],
        payload: { scheduledPickupAt: `${year}-03-06T08:00` },
        fieldSources: { scheduledPickupAt: 'operator' },
      })
      expect(action.target.job).toMatchObject({ id: second.id })

      const firstBefore = (await getJob(request, token, first.id))!.scheduledPickupAt
      const accepted = await acceptAction(request, token, action)
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200)
      // 08:00 in Warsaw in March (UTC+1) is 07:00 UTC; only the chosen job changes.
      expect((await getJob(request, token, second.id))!.scheduledPickupAt).toBe(`${year}-03-06T07:00:00.000Z`)
      expect((await getJob(request, token, first.id))!.scheduledPickupAt).toBe(firstBefore)
    } finally {
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

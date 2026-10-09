import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import {
  advanceToReceiving,
  createSchedulableJob,
  errorCode,
  getJob,
  postTransition,
  transitionOk,
  uniqueSuffix,
} from './itad-job-fixtures'
import { advanceToProcessing } from './itad-flow-fixtures'

/**
 * TC-ITAD-011 (spec TEST-008, REQ-006, REQ-008): hold stores and resume restores the
 * pre-hold status without touching startedAt; reasons are mandatory; backward moves and
 * cancel (also from on_hold and processing) behave per the transition table; invalid
 * moves and non-draft deletes return their exact codes.
 */
test.describe('TC-ITAD-011: hold, resume, cancel and backward moves', () => {
  test('hold/resume, backward moves and cancellation follow the table', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueSuffix()
    let companyId: string | null = null
    const openJobs: string[] = []
    try {
      companyId = await createCompanyFixture(request, token, `QA ITAD Hold ${suffix}`)

      // Hold and resume from receiving.
      const held = await createSchedulableJob(request, token, companyId, `QA hold ${suffix}`)
      openJobs.push(held.id)
      await advanceToReceiving(request, token, held.id)
      const startedAt = (await getJob(request, token, held.id))?.startedAt

      const noReason = await postTransition(request, token, held.id, { action: 'hold' })
      expect(noReason.status()).toBe(400)
      expect(await errorCode(noReason)).toBe('itad.jobs.errors.reason_required')

      expect(await transitionOk(request, token, held.id, { action: 'hold', reason: 'awaiting site access' })).toBe('on_hold')
      const onHold = await getJob(request, token, held.id)
      expect(onHold).toMatchObject({ status: 'on_hold', statusBeforeHold: 'receiving', holdReason: 'awaiting site access' })
      expect(typeof onHold?.heldBy?.name).toBe('string')
      expect(onHold?.heldBy?.name).not.toMatch(/:v\d+$/)

      expect(await transitionOk(request, token, held.id, { action: 'resume' })).toBe('receiving')
      const resumed = await getJob(request, token, held.id)
      expect(resumed).toMatchObject({ status: 'receiving', statusBeforeHold: null, holdReason: null, heldBy: null })
      expect(resumed?.startedAt).toBe(startedAt)

      // Cancel from on_hold clears the hold fields.
      await transitionOk(request, token, held.id, { action: 'hold', reason: 'customer paused' })
      expect(await transitionOk(request, token, held.id, { action: 'cancel', reason: 'customer withdrew' })).toBe('cancelled')
      expect(await getJob(request, token, held.id)).toMatchObject({ status: 'cancelled', statusBeforeHold: null, heldBy: null })
      openJobs.splice(openJobs.indexOf(held.id), 1)

      // Backward moves need a reason.
      const back = await createSchedulableJob(request, token, companyId, `QA backward ${suffix}`)
      openJobs.push(back.id)
      const notAllowed = await postTransition(request, token, back.id, { action: 'dispatch' })
      expect(notAllowed.status()).toBe(400)
      expect(await errorCode(notAllowed)).toBe('itad.jobs.errors.transition_not_allowed')
      await transitionOk(request, token, back.id, { action: 'schedule' })
      await transitionOk(request, token, back.id, { action: 'dispatch' })
      const backNoReason = await postTransition(request, token, back.id, { action: 'return_to_scheduled' })
      expect(await errorCode(backNoReason)).toBe('itad.jobs.errors.reason_required')
      expect(await transitionOk(request, token, back.id, { action: 'return_to_scheduled', reason: 'pickup failed' })).toBe('scheduled')
      expect(await transitionOk(request, token, back.id, { action: 'unschedule', reason: 'rework order' })).toBe('draft')

      // Non-draft delete is refused; processing can still be cancelled.
      await advanceToProcessing(request, token, back.id)
      const remove = await apiRequest(request, 'DELETE', '/api/itad/jobs', { token, data: { id: back.id } })
      expect(remove.status()).toBe(409)
      expect(await errorCode(remove)).toBe('itad.jobs.errors.delete_not_draft')
      expect(await transitionOk(request, token, back.id, { action: 'cancel', reason: 'scope changed' })).toBe('cancelled')
      openJobs.splice(openJobs.indexOf(back.id), 1)
    } finally {
      for (const id of openJobs) await postTransition(request, token, id, { action: 'cancel', reason: 'QA cleanup' }).catch(() => undefined)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

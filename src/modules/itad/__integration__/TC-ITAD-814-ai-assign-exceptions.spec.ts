import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createCompanyFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { getTokenScope } from '@open-mercato/core/helpers/integration/generalFixtures'
import { createSchedulableJob, uniqueSuffix } from './itad-job-fixtures'
import { approveRetry, currentAssets, processingJobWithDataBearingAssets, recordResult, startRunOk } from './itad-sanitization-fixtures'
import { exceptionDetail, listExceptions } from './itad-exception-fixtures'
import { confirmAction, deletePendingActions, seedPendingAction } from './itad-ai-fixtures'

/**
 * TC-ITAD-814 (AI assistant spec AC-AI-03, AC-AI-04, AI-REQ-14): "assign all open
 * sanitization failures on this job to me" assigns the 3 open failures (a resolved one is
 * not part of the selection); a second batch where one failure was resolved between
 * preview and Confirm assigns 2 and reports 1 conflict — non-atomic, per record. More than
 * 50 ids never satisfy the tool. (An id outside the filter is refused at prepare: unit test.)
 */
test.describe('TC-ITAD-814: AI assign exceptions', () => {
  test('assigns the open failures; a failure resolved after the preview is a per-record conflict', async ({ request }) => {
    test.setTimeout(240_000)
    const token = await getAuthToken(request, 'admin')
    const { tenantId, organizationId, userId } = getTokenScope(token)
    const employeeId = getTokenScope(await getAuthToken(request, 'employee')).userId
    const suffix = uniqueSuffix()
    const actions: string[] = []
    let companyId: string | null = null
    try {
      companyId = await createCompanyFixture(request, token, `QA AI Assign ${suffix}`)
      const job = await createSchedulableJob(request, token, companyId, `QA AI assign ${suffix}`)
      const assets = await processingJobWithDataBearingAssets(request, token, job.id, 4)
      const serials = assets.map((asset) => asset.serial)
      for (let index = 0; index < 4; index += 1) {
        const runId = await startRunOk(request, token, job.id, (await currentAssets(request, token, job.id, serials))[index])
        expect((await recordResult(request, token, job.id, runId, { result: 'FAIL', verificationMethod: 'full_verification', verificationNotes: 'Readable sectors' })).status()).toBe(200)
      }
      // One failure resolved before anything is proposed: 3 open remain.
      expect((await approveRetry(request, token, job.id, (await currentAssets(request, token, job.id, serials))[3], 'Cable replaced')).status()).toBe(200)
      const openFailures = async () => (await listExceptions(request, token, job.id, 'status=open&type=sanitization_failed')).items
      const open = await openFailures()
      expect(open).toHaveLength(3)

      const seed = async (exceptionIds: string[], versions: Map<string, string>, assignedToUserId: string) => {
        const id = await seedPendingAction({
          tenantId,
          organizationId,
          createdByUserId: userId,
          toolName: 'itad.assign_exceptions',
          normalizedInput: { jobId: job.id, filter: { type: 'sanitization_failed', assignee: 'any' }, exceptionIds, assignedToUserId },
          recordVersion: null,
          targetEntityType: 'itad.exception',
          targetRecordId: null,
          records: exceptionIds.map((recordId) => ({ recordId, recordVersion: versions.get(recordId) ?? null })),
        })
        actions.push(id)
        return id
      }
      const versionsOf = (items: Array<{ id: string; updatedAt: string }>) => new Map(items.map((item) => [item.id, item.updatedAt]))

      // AC-AI-03: all 3 assigned to the operator ("me"), each by its own command.
      const confirmed = await confirmAction(request, token, await seed(open.map((item) => item.id), versionsOf(open), 'me'))
      expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200)
      expect(confirmed.body).toMatchObject({ ok: true, mutationResult: { commandName: 'itad.exceptions.assign' } })
      for (const item of open) expect((await exceptionDetail(request, token, job.id, item.id)).assignedTo?.id).toBe(userId)

      // AC-AI-04: reassign the 3 to a colleague; one is resolved after the preview.
      const current = await openFailures()
      const batch = await seed(current.map((item) => item.id), versionsOf(current), employeeId)
      const resolvedLater = current[0]
      const assetOfResolved = (await currentAssets(request, token, job.id, serials)).find((asset) => asset.id === resolvedLater.assetId)!
      expect((await approveRetry(request, token, job.id, assetOfResolved, 'Retry approved by phone')).status()).toBe(200)
      const partial = await confirmAction(request, token, batch)
      expect(partial.status, JSON.stringify(partial.body)).toBe(200)
      expect(partial.body).toMatchObject({ ok: true, pendingAction: { status: 'confirmed' } })
      const failed = ((partial.body?.pendingAction as { failedRecords?: Array<{ recordId: string; error: { code: string } }> } | undefined)?.failedRecords) ?? []
      expect(failed.map((record) => record.recordId)).toEqual([resolvedLater.id])
      expect((await exceptionDetail(request, token, job.id, resolvedLater.id)).assignedTo?.id).toBe(userId)
      for (const item of current.slice(1)) expect((await exceptionDetail(request, token, job.id, item.id)).assignedTo?.id).toBe(employeeId)

      // More than 50 ids never satisfy the tool, whatever was stored.
      const many = Array.from({ length: 51 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`)
      const tooMany = await confirmAction(request, token, await seed(many, new Map(), 'me'))
      expect(tooMany.status).toBe(412)
      expect(tooMany.body?.code).toBe('schema_drift')
    } finally {
      await deletePendingActions(actions)
      await deleteEntityIfExists(request, token, '/api/customers/companies', companyId)
    }
  })
})

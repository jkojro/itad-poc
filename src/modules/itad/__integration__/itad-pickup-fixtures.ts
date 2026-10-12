import { expect, type APIRequestContext } from '@playwright/test'
import { apiRequest } from '@open-mercato/core/helpers/integration/api'
import { withClient } from '@open-mercato/core/helpers/integration/dbFixtures'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'

export const PICKUP_TYPE = 'itad-pickup'

export type PickupTaskBody = {
  id: string
  interactionType: string
  status: string
  title: string | null
  body?: string | null
  scheduledAt: string | null
  durationMinutes: number | null
  ownerUserId: string | null
  updatedAt?: string | null
}

/** Pickup tasks on a company, as the calendar reads them (`/api/customers/interactions`). */
export async function listPickupTasks(request: APIRequestContext, token: string, companyId: string): Promise<PickupTaskBody[]> {
  const query = new URLSearchParams({ entityId: companyId, interactionType: PICKUP_TYPE, limit: '100' })
  const response = await apiRequest(request, 'GET', `/api/customers/interactions?${query.toString()}`, { token })
  expect(response.status()).toBe(200)
  const body = await readJsonSafe<{ items?: PickupTaskBody[] }>(response)
  return body?.items ?? []
}

/**
 * The sync runs in the events worker after the job commit, so tests poll until the
 * calendar shows the expected tasks. `describe` renders the tasks compactly for asserts.
 */
export async function waitForPickupTasks(
  request: APIRequestContext,
  token: string,
  companyId: string,
  expected: (tasks: PickupTaskBody[]) => boolean,
  message: string,
): Promise<PickupTaskBody[]> {
  let latest: PickupTaskBody[] = []
  try {
    await expect
      .poll(async () => {
        latest = await listPickupTasks(request, token, companyId)
        return expected(latest)
      })
      .toBe(true)
  } catch (error) {
    throw new Error(`${message}; tasks: ${JSON.stringify(latest.map(describeTask))}`, { cause: error })
  }
  return latest
}

export function describeTask(task: PickupTaskBody) {
  return { id: task.id, status: task.status, scheduledAt: task.scheduledAt, ownerUserId: task.ownerUserId }
}

export const sameInstant = (a: string | null | undefined, b: string | null | undefined): boolean =>
  Boolean(a && b && new Date(a).getTime() === new Date(b).getTime())

export async function updateJob(request: APIRequestContext, token: string, jobId: string, patch: Record<string, unknown>) {
  const response = await apiRequest(request, 'PUT', '/api/itad/jobs', { token, data: { id: jobId, ...patch } })
  expect(response.status(), `PUT /api/itad/jobs failed: ${await response.text()}`).toBe(200)
}

/**
 * Changes a task directly in the database: a write that bypasses the `customers` API and
 * its interceptors (pickup calendar spec REQ-507, "changes made around the API").
 */
export async function changeTaskOutsideApi(
  interactionId: string,
  change: { scheduledAt?: string; status?: string; deleted?: boolean },
): Promise<void> {
  await withClient(async (client) => {
    const run = async (sql: string, values: unknown[]) => {
      const result = await client.query(sql, values)
      // Guards against writing to a different database than the app under test.
      expect(result.rowCount, `no interaction ${interactionId} in the test database (DATABASE_URL)`).toBe(1)
    }
    if (change.scheduledAt) {
      await run('update customer_interactions set scheduled_at = $1, updated_at = now() where id = $2', [change.scheduledAt, interactionId])
    }
    if (change.status) {
      await run('update customer_interactions set status = $1, updated_at = now() where id = $2', [change.status, interactionId])
    }
    if (change.deleted) {
      await run('update customer_interactions set deleted_at = now(), updated_at = now() where id = $1', [interactionId])
    }
  })
}

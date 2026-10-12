import { createLogger } from '@open-mercato/shared/lib/logger'
import { syncPickupTask } from '../services/pickup-task-sync'

const logger = createLogger('itad').child({ component: 'pickup-task' })

/**
 * Keeps the job's pickup task in the platform calendar in step with the job (pickup
 * calendar spec "Sync"). Every job write and status transition emits `itad.job.updated`
 * after commit; `itad.job.deleted` comes from the soft delete of a draft. Persistent, so
 * the events worker runs it off the request path.
 */
export const metadata = {
  event: 'itad.job.updated',
  persistent: true,
  id: 'itad:pickup-task-sync',
}

type Resolver = { resolve: <T = unknown>(name: string) => T }
type SubscriberContext = Resolver & { container?: Resolver }

type JobEventPayload = { id?: unknown; tenantId?: unknown; organizationId?: unknown; actorUserId?: unknown }

const readId = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null)

export async function handleJobEvent(payload: unknown, ctx: SubscriberContext): Promise<void> {
  const data = (payload ?? {}) as JobEventPayload
  const jobId = readId(data.id)
  const tenantId = readId(data.tenantId)
  const organizationId = readId(data.organizationId)
  if (!jobId || !tenantId || !organizationId) return
  const container = ctx.container ?? { resolve: ctx.resolve }
  const result = await syncPickupTask(container, { tenantId, organizationId }, jobId, {
    causedByUserId: readId(data.actorUserId),
  })
  if (result.error) {
    logger.warn('Pickup task sync failed', { jobId, error: result.error })
  }
}

export default handleJobEvent

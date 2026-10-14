import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { ItadJobPickupTask } from '../data/entities'
import type { PickupTaskLinkState } from '../domain/pickup-task'

/**
 * Read side of the pickup task links (pickup calendar spec "API Contracts"). Only `itad`
 * data: the link records what `itad` last gave the task, which is what the job page shows.
 */
export type PickupTaskSummary = {
  interactionId: string
  state: PickupTaskLinkState
  scheduledAt: string
  lastError: string | null
  lastSyncedAt: string | null
}

type Scope = { tenantId: string; organizationId: string }

/** The current link, or the newest one when none is current (all lost). */
export async function loadPickupTaskSummary(
  em: EntityManager,
  scope: Scope,
  jobId: string,
): Promise<{ pickupTask: PickupTaskSummary | null; historyCount: number }> {
  const links = await em.find(
    ItadJobPickupTask,
    { job: jobId, tenantId: scope.tenantId, organizationId: scope.organizationId } as FilterQuery<ItadJobPickupTask>,
    { orderBy: { createdAt: 'desc' } },
  )
  const link = links.find((entry) => entry.isCurrent) ?? links[0] ?? null
  return {
    pickupTask: link
      ? {
          interactionId: link.interactionId,
          state: link.state,
          scheduledAt: link.scheduledAt.toISOString(),
          lastError: link.lastError ?? null,
          lastSyncedAt: link.lastSyncedAt ? link.lastSyncedAt.toISOString() : null,
        }
      : null,
    historyCount: links.length,
  }
}

/**
 * The job behind a pickup task, for the calendar editor's "Go to job" widget. Scoped to
 * the tenant and the organizations the caller may read (`null` = all of the tenant).
 */
export async function findJobOfPickupTask(
  em: EntityManager,
  tenantId: string,
  readableOrganizationIds: string[] | null,
  interactionId: string,
): Promise<{ jobId: string; reference: string } | null> {
  const where: Record<string, unknown> = { interactionId, tenantId }
  if (readableOrganizationIds !== null) where.organizationId = { $in: readableOrganizationIds }
  const link = await em.findOne(ItadJobPickupTask, where as FilterQuery<ItadJobPickupTask>, { populate: ['job'] })
  if (!link || link.job.deletedAt) return null
  return { jobId: link.job.id, reference: link.job.internalReference }
}

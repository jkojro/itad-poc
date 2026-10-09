import { LockMode } from '@mikro-orm/core'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { notFound } from '@open-mercato/shared/lib/crud/errors'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { ItadJob } from '../data/entities'
import type { JobScope } from './jobs'

/**
 * Locks the job row (`SELECT … FOR UPDATE`) inside the caller's transaction. Manifest
 * changes, receiving scans, duplicate actions and asset removals all take it before
 * checking status or serial uniqueness, so they serialize with each other and with
 * status transitions (manifest spec "Concurrency"). It never bumps `updatedAt`.
 */
export async function lockJob(tx: EntityManager, scope: JobScope, jobId: string): Promise<ItadJob> {
  const job = await tx.findOne(
    ItadJob,
    { id: jobId, tenantId: scope.tenantId, organizationId: scope.organizationId, deletedAt: null } as FilterQuery<ItadJob>,
    { lockMode: LockMode.PESSIMISTIC_WRITE },
  )
  if (!job) {
    const { translate } = await resolveTranslations()
    throw notFound(translate('itad.jobs.errors.not_found', 'ITAD job not found'))
  }
  return job
}

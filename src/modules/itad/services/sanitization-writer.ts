import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { ItadAsset, ItadAssetStatusTransition, ItadSanitizationRun, type ItadJob } from '../data/entities'
import type { ItadAssetHistoryStatus, ItadAssetStatus, ItadAssetTransitionAction } from '../domain/job-types'
import { JOB_CANCELLED_ABORT_REASON } from '../domain/sanitization-state-machine'

/**
 * Writes shared by the sanitization commands and the job `cancel` transition. Plain
 * module (see module AGENTS.md "Transactions"): the caller passes its transaction's
 * EntityManager and holds the job row lock; events stay with the caller.
 */

export type AssetStep = { from: ItadAssetHistoryStatus; to: ItadAssetHistoryStatus }

/**
 * Moves the asset to `toStatus` and appends one history row per step. Steps of one action
 * get increasing `createdAt` (1 ms apart) so the history reads in order: FAIL is always
 * `sanitization_failed` before `review_required`.
 */
export function recordAssetSteps(
  tx: EntityManager,
  input: {
    job: ItadJob
    asset: ItadAsset
    action: ItadAssetTransitionAction
    steps: AssetStep[]
    toStatus: ItadAssetStatus
    run: ItadSanitizationRun | null
    reason: string | null
    actorUserId: string
    now: Date
  },
): void {
  const { job, asset, action, steps, toStatus, run, reason, actorUserId, now } = input
  for (const [index, step] of steps.entries()) {
    tx.persist(
      tx.create(ItadAssetStatusTransition, {
        tenantId: asset.tenantId,
        organizationId: asset.organizationId,
        job,
        asset,
        action,
        fromStatus: step.from,
        toStatus: step.to,
        dataBearingFrom: asset.dataBearing ?? null,
        dataBearingTo: asset.dataBearing ?? null,
        run,
        reason,
        actorUserId,
        createdAt: new Date(now.getTime() + index),
      }),
    )
  }
  asset.status = toStatus
  asset.updatedAt = now
}

export type AbortedRun = { runId: string; assetId: string }

/**
 * Closes every open run of a job that is being cancelled (spec "Job cancelled"): each run
 * becomes ABORTED with reason `job_cancelled`, and its asset returns to
 * `sanitization_required` with an `abort_run` history row. Afterwards `result IS NULL`
 * still means "a run in progress on a live job".
 */
export async function abortOpenRunsOfCancelledJob(
  tx: EntityManager,
  input: { job: ItadJob; actorUserId: string; now: Date },
): Promise<AbortedRun[]> {
  const { job, actorUserId, now } = input
  const runs = await tx.find(
    ItadSanitizationRun,
    { tenantId: job.tenantId, organizationId: job.organizationId, job: job.id, result: null } as FilterQuery<ItadSanitizationRun>,
    { populate: ['asset'] as never[], orderBy: { id: 'asc' } },
  )
  const aborted: AbortedRun[] = []
  for (const run of runs) {
    run.result = 'ABORTED'
    run.abortReason = JOB_CANCELLED_ABORT_REASON
    run.finishedAt = now
    run.finishedByUserId = actorUserId
    run.updatedAt = now
    const asset = run.asset
    if (asset.status === 'sanitization_in_progress') {
      recordAssetSteps(tx, {
        job,
        asset,
        action: 'abort_run',
        steps: [{ from: 'sanitization_in_progress', to: 'sanitization_required' }],
        toStatus: 'sanitization_required',
        run,
        reason: JOB_CANCELLED_ABORT_REASON,
        actorUserId,
        now,
      })
    }
    aborted.push({ runId: run.id, assetId: asset.id })
  }
  return aborted
}

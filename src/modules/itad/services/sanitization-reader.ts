import type { EntityManager } from '@mikro-orm/postgresql'
import type { ItadAssetStatus } from '../domain/job-types'

/**
 * Read side of sanitization (scoped SQL; pass the transaction's EntityManager when a
 * result guards a write). Data-bearing assets are active assets with `data_bearing = true`.
 */
export type SanitizationScope = { tenantId: string; organizationId: string }

export type SanitizationCounts = {
  required: number
  inProgress: number
  sanitized: number
  reviewRequired: number
}

const COUNTS_SQL = `select
    count(*) filter (where a."status" = 'sanitization_required') as "required",
    count(*) filter (where a."status" = 'sanitization_in_progress') as "in_progress",
    count(*) filter (where a."status" = 'sanitized') as "sanitized",
    count(*) filter (where a."status" = 'review_required') as "review_required"
  from "itad_assets" a
  where a."tenant_id" = ? and a."organization_id" = ? and a."job_id" = ? and a."deleted_at" is null and a."data_bearing" = true`

/** Counters of the Sanitization tab, by asset status. */
export async function loadSanitizationCounts(em: EntityManager, scope: SanitizationScope, jobId: string): Promise<SanitizationCounts> {
  const row = await em.execute<Record<string, string | number>>(COUNTS_SQL, [scope.tenantId, scope.organizationId, jobId], 'get')
  return {
    required: Number(row?.required ?? 0),
    inProgress: Number(row?.in_progress ?? 0),
    sanitized: Number(row?.sanitized ?? 0),
    reviewRequired: Number(row?.review_required ?? 0),
  }
}

export const SANITIZATION_PENDING_STATUSES: ItadAssetStatus[] = ['sanitization_required', 'sanitization_in_progress', 'review_required']

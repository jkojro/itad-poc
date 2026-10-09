"use client"
import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { StatusBadge, type StatusBadgeVariant } from '@open-mercato/ui/primitives/status-badge'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import type { useT } from '@open-mercato/shared/lib/i18n/context'
import type { ReconciliationSummary } from '../domain/reconciliation'

type Translate = ReturnType<typeof useT>

export type ReconciliationState = 'matched' | 'missing' | 'unexpected'

/** Semantic variants only — never hard-coded colors. */
const STATE_VARIANTS: Record<ReconciliationState, StatusBadgeVariant> = {
  matched: 'success',
  missing: 'warning',
  unexpected: 'warning',
}

const STATE_FALLBACK_LABELS: Record<ReconciliationState, string> = {
  matched: 'Matched',
  missing: 'Missing',
  unexpected: 'Unexpected',
}

export function reconciliationLabel(t: Translate, state: ReconciliationState): string {
  return t(`itad.reconciliation.state.${state}`, STATE_FALLBACK_LABELS[state])
}

export function ReconciliationBadge({ t, state }: { t: Translate; state: ReconciliationState }) {
  return (
    <StatusBadge variant={STATE_VARIANTS[state]} dot>
      {reconciliationLabel(t, state)}
    </StatusBadge>
  )
}

const queryKey = (jobId: string) => ['itad-reconciliation', jobId]

/** Job reconciliation counters (`GET …/reconciliation`, needs only `itad.jobs.view`). */
export function useReconciliation(jobId: string) {
  return useQuery<ReconciliationSummary>({
    queryKey: queryKey(jobId),
    queryFn: async () => readApiResultOrThrow<ReconciliationSummary>(`/api/itad/jobs/${encodeURIComponent(jobId)}/reconciliation`),
  })
}

/** Re-reads the counters after a manifest change, scan or correction. */
export function useInvalidateReconciliation(jobId: string): () => void {
  const queryClient = useQueryClient()
  return React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKey(jobId) })
  }, [jobId, queryClient])
}

/** One line like "9 matched · 1 missing · 1 unexpected · 0 duplicates to resolve". */
export function reconciliationSummaryText(t: Translate, summary: ReconciliationSummary): string {
  return t('itad.reconciliation.summary', '{matched} matched · {missing} missing · {unexpected} unexpected · {duplicates} duplicates to resolve', {
    matched: summary.matched,
    missing: summary.missing,
    unexpected: summary.unexpected,
    duplicates: summary.pendingDuplicates + summary.differentDeviceUnresolved,
  })
}

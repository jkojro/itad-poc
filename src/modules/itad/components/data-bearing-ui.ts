import type { useT } from '@open-mercato/shared/lib/i18n/context'
import type { StatusBadgeVariant } from '@open-mercato/ui/primitives/status-badge'
import type { ItadDataBearingSource } from '../domain/data-bearing'
import type { ItadAssetStatus } from '../domain/job-types'

type Translate = ReturnType<typeof useT>

/** "Yes" / "No" / "Not determined" for a tri-state `dataBearing`. */
export function dataBearingLabel(t: Translate, value: boolean | null | undefined): string {
  if (value === true) return t('itad.receiving.dataBearing.yes', 'Yes')
  if (value === false) return t('itad.receiving.dataBearing.no', 'No')
  return t('itad.receiving.dataBearing.unknown', 'Not determined')
}

const SOURCE_FALLBACK_LABELS: Record<ItadDataBearingSource, string> = {
  manifest: 'from manifest',
  job_default: 'job default',
  manual: 'set by hand',
  bulk: 'bulk decision',
}

/** Where a decided value came from, shown as a muted hint next to it. */
export function dataBearingSourceLabel(t: Translate, source: ItadDataBearingSource): string {
  return t(`itad.receiving.dataBearing.source.${source}`, SOURCE_FALLBACK_LABELS[source])
}

const ASSET_STATUS_FALLBACK_LABELS: Record<ItadAssetStatus, string> = {
  received: 'Received',
  sanitization_required: 'Sanitization required',
  sanitization_in_progress: 'Sanitization in progress',
  sanitized: 'Sanitized',
  review_required: 'Review required',
}

/** Semantic variants only — never hard-coded colors (sanitization spec "UI"). */
export const ASSET_STATUS_VARIANTS: Record<ItadAssetStatus, StatusBadgeVariant> = {
  received: 'neutral',
  sanitization_required: 'info',
  sanitization_in_progress: 'info',
  sanitized: 'success',
  review_required: 'warning',
}

export function assetStatusLabel(t: Translate, status: ItadAssetStatus): string {
  return t(`itad.assets.status.${status}`, ASSET_STATUS_FALLBACK_LABELS[status])
}

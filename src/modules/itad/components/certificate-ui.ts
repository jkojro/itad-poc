import type { useT } from '@open-mercato/shared/lib/i18n/context'
import type { StatusMap } from '@open-mercato/ui/primitives/status-badge'
import type { CertificateLocale, CertificateStatus } from '../domain/certificates'

type Translate = ReturnType<typeof useT>

/** Semantic variants only — never hard-coded colors. */
export const CERTIFICATE_STATUS_VARIANTS: StatusMap<CertificateStatus> = { issued: 'success', superseded: 'neutral', void: 'error' }

const STATUS_LABELS: Record<CertificateStatus, string> = { issued: 'Issued', superseded: 'Superseded', void: 'Void' }

/** Language names are shown in their own language, so they are not translated. */
export const CERTIFICATE_LOCALE_LABELS: Record<CertificateLocale, string> = { pl: 'Polski', en: 'English' }

export function certificateStatusLabel(t: Translate, status: CertificateStatus): string {
  return t(`itad.certificates.status.${status}`, STATUS_LABELS[status])
}

export function formatCertificateDateTime(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
}

export function certificatePdfHref(jobId: string, certificateId: string): string {
  return `/api/itad/jobs/${encodeURIComponent(jobId)}/certificates/${encodeURIComponent(certificateId)}/pdf`
}

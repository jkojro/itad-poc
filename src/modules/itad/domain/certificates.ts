import type { ItadAssetStatus, ItadJobStatus } from './job-types'
import type { ItadRunResult, ItadSanitizationMethod, ItadVerificationMethod } from './sanitization-state-machine'

/**
 * Certificates of Data Sanitization (certificates spec, Epic 6). Pure: a certificate is
 * evidence of a PASS run the workflow already recorded, so every rule here reads facts
 * and decides; nothing writes. One certificate covers one asset and one source run.
 */
export const CERTIFICATE_STATUSES = ['issued', 'superseded', 'void'] as const
export type CertificateStatus = (typeof CERTIFICATE_STATUSES)[number]

export const CERTIFICATE_LOCALES = ['pl', 'en'] as const
export type CertificateLocale = (typeof CERTIFICATE_LOCALES)[number]

export const CERTIFICATE_EVENT_KINDS = ['issued', 'superseded', 'voided'] as const
export type CertificateEventKind = (typeof CERTIFICATE_EVENT_KINDS)[number]

export const CERTIFICATE_VOID_REASON_CODES = ['manual', 'reclassified_non_data_bearing'] as const
export type CertificateVoidReasonCode = (typeof CERTIFICATE_VOID_REASON_CODES)[number]

export const CERTIFICATE_REFERENCE_KIND = 'certificate'
export const CERTIFICATE_REFERENCE_PREFIX = 'CDS'
const MIN_DIGITS = 5

export const MEDIA_IDENTIFIERS_MAX = 10
export const MEDIA_IDENTIFIER_MAX_LENGTH = 100

export function formatCertificateNumber(year: number, value: number): string {
  return `${CERTIFICATE_REFERENCE_PREFIX}-${year}-${String(value).padStart(MIN_DIGITS, '0')}`
}

// ─── Job status (spec "Job status") ─────────────────────────────────────────

export type CertificateAction = 'issue' | 'reissue' | 'void'

type OperationalStatus = Exclude<ItadJobStatus, 'on_hold'>

const ALLOWED: Record<OperationalStatus, readonly CertificateAction[]> = {
  draft: [],
  scheduled: [],
  in_transit: [],
  receiving: [],
  processing: ['issue', 'reissue', 'void'],
  closeout_review: ['issue', 'reissue', 'void'],
  completed: ['issue', 'reissue', 'void'],
  // A cancelled job requires no certificate; an existing one can still be corrected.
  cancelled: ['reissue', 'void'],
}

export type CertificateJob = { status: ItadJobStatus; statusBeforeHold?: ItadJobStatus | null }

export function certificateActionAllowed(job: CertificateJob, action: CertificateAction): boolean {
  const status = job.status === 'on_hold' ? job.statusBeforeHold ?? null : job.status
  if (!status || status === 'on_hold') return false
  return ALLOWED[status].includes(action)
}

// ─── Source run and eligibility (spec "Eligibility") ────────────────────────

export type CertificateRun = {
  id: string
  assetId: string
  jobId: string
  result: ItadRunResult | null
  finishedAt: Date | null
}

/** The asset's latest finished PASS run, or `null`. FAIL and aborted runs never count. */
export function latestPassRun<T extends CertificateRun>(runs: readonly T[]): T | null {
  let latest: T | null = null
  for (const run of runs) {
    if (run.result !== 'PASS' || !run.finishedAt) continue
    if (!latest || run.finishedAt.getTime() > (latest.finishedAt as Date).getTime()) latest = run
  }
  return latest
}

export type CertificateAsset = {
  id: string
  jobId: string
  dataBearing: boolean | null
  status: ItadAssetStatus
  deleted: boolean
}

export type EligibilityDetail = 'not_data_bearing' | 'not_sanitized' | 'asset_voided' | 'no_pass_run' | 'job_status'

export type EligibilityDecision =
  | { ok: true; sourceRunId: string }
  | { ok: false; code: 'certificate_not_eligible'; detail: EligibilityDetail }
  | { ok: false; code: 'certificate_already_issued' }

export type EligibilityFacts = {
  job: CertificateJob
  asset: CertificateAsset
  runs: readonly CertificateRun[]
  /** Whether the asset has an `issued` certificate (any run). */
  hasIssuedCertificate: boolean
}

/**
 * Whether one asset may get a certificate now (REQ-601, REQ-605, REQ-621). `action`
 * `reissue` expects the asset's current certificate to exist, `issue` refuses it.
 */
export function decideEligibility(facts: EligibilityFacts, action: 'issue' | 'reissue' = 'issue'): EligibilityDecision {
  const { job, asset } = facts
  if (!certificateActionAllowed(job, action)) return { ok: false, code: 'certificate_not_eligible', detail: 'job_status' }
  if (asset.deleted) return { ok: false, code: 'certificate_not_eligible', detail: 'asset_voided' }
  if (asset.dataBearing !== true) return { ok: false, code: 'certificate_not_eligible', detail: 'not_data_bearing' }
  if (asset.status !== 'sanitized') return { ok: false, code: 'certificate_not_eligible', detail: 'not_sanitized' }
  const own = facts.runs.filter((run) => run.assetId === asset.id && run.jobId === asset.jobId)
  const source = latestPassRun(own)
  if (!source) return { ok: false, code: 'certificate_not_eligible', detail: 'no_pass_run' }
  if (action === 'issue' && facts.hasIssuedCertificate) return { ok: false, code: 'certificate_already_issued' }
  return { ok: true, sourceRunId: source.id }
}

// ─── Required certificates (closeout condition) ─────────────────────────────

export type RequirementAsset = Pick<CertificateAsset, 'id' | 'dataBearing' | 'status' | 'deleted'> & {
  hasIssuedCertificate: boolean
}

export type CertificateCounts = {
  dataBearing: number
  sanitized: number
  required: number
  issued: number
  missing: number
  missingAssetIds: string[]
}

/** Spec "Required certificates": data-bearing ∧ sanitized ∧ active; none for a cancelled job. */
export function certificateCounts(jobStatus: ItadJobStatus, assets: readonly RequirementAsset[]): CertificateCounts {
  const active = assets.filter((asset) => !asset.deleted)
  const dataBearing = active.filter((asset) => asset.dataBearing === true)
  const sanitized = dataBearing.filter((asset) => asset.status === 'sanitized')
  const required = jobStatus === 'cancelled' ? [] : sanitized
  const missing = required.filter((asset) => !asset.hasIssuedCertificate)
  return {
    dataBearing: dataBearing.length,
    sanitized: sanitized.length,
    required: required.length,
    issued: required.length - missing.length,
    missing: missing.length,
    missingAssetIds: missing.map((asset) => asset.id),
  }
}

// ─── Source data and snapshot (spec "Snapshot") ─────────────────────────────

/** Everything on the certificate except number, issue time and issuer. */
export type CertificateSourceData = {
  customerName: string
  jobReference: string
  customerReference: string | null
  jobName: string
  assetSerial: string
  customerAssetTag: string | null
  manufacturer: string | null
  model: string | null
  mediaIdentifiers: string[]
  method: ItadSanitizationMethod
  methodDetail: string | null
  tool: string
  toolVersion: string
  result: 'PASS'
  verificationMethod: ItadVerificationMethod | null
  startedAt: string
  completedAt: string
  startedBy: string
  resultRecordedBy: string
  sourceRunId: string
}

export type CertificateSnapshot = CertificateSourceData & {
  certificateNumber: string
  issuedAt: string
  issuedBy: string
  locale: CertificateLocale
  /** Number of the certificate this one replaces, on a reissue. */
  supersedes: string | null
}

export function buildSnapshot(
  source: CertificateSourceData,
  issue: { certificateNumber: string; issuedAt: Date; issuedBy: string; locale: CertificateLocale; supersedes?: string | null },
): CertificateSnapshot {
  return {
    ...source,
    mediaIdentifiers: [...source.mediaIdentifiers],
    certificateNumber: issue.certificateNumber,
    issuedAt: issue.issuedAt.toISOString(),
    issuedBy: issue.issuedBy,
    locale: issue.locale,
    supersedes: issue.supersedes ?? null,
  }
}

/** The customer-facing text values of the source data, keyed by field (for the glyph check). */
export function printableFields(source: CertificateSourceData): Array<{ field: string; value: string }> {
  const fields: Array<{ field: string; value: string | null }> = [
    { field: 'customerName', value: source.customerName },
    { field: 'jobReference', value: source.jobReference },
    { field: 'customerReference', value: source.customerReference },
    { field: 'jobName', value: source.jobName },
    { field: 'assetSerial', value: source.assetSerial },
    { field: 'customerAssetTag', value: source.customerAssetTag },
    { field: 'manufacturer', value: source.manufacturer },
    { field: 'model', value: source.model },
    { field: 'methodDetail', value: source.methodDetail },
    { field: 'tool', value: source.tool },
    { field: 'toolVersion', value: source.toolVersion },
    { field: 'startedBy', value: source.startedBy },
    { field: 'resultRecordedBy', value: source.resultRecordedBy },
    ...source.mediaIdentifiers.map((value, index) => ({ field: `mediaIdentifiers.${index}`, value })),
  ]
  return fields.filter((entry): entry is { field: string; value: string } => typeof entry.value === 'string' && entry.value.length > 0)
}

/**
 * Fields holding a character the embedded font cannot print (REQ-622). Whitespace and
 * line breaks are layout, not glyphs. Nothing is ever substituted: the caller refuses.
 */
export function unprintableFields(
  values: ReadonlyArray<{ field: string; value: string }>,
  hasGlyph: (codePoint: number) => boolean,
): string[] {
  const fields: string[] = []
  for (const { field, value } of values) {
    for (const char of value) {
      const codePoint = char.codePointAt(0) as number
      if (/\s/.test(char)) continue
      if (!hasGlyph(codePoint)) {
        fields.push(field)
        break
      }
    }
  }
  return fields
}

/** Trims, drops empties and duplicates; `null` when the input breaks the limits. */
export function normalizeMediaIdentifiers(values: readonly string[] | null | undefined): string[] | null {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of values ?? []) {
    const value = raw.trim()
    if (!value || seen.has(value)) continue
    if (value.length > MEDIA_IDENTIFIER_MAX_LENGTH) return null
    seen.add(value)
    result.push(value)
  }
  return result.length > MEDIA_IDENTIFIERS_MAX ? null : result
}

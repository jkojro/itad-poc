import { createHash } from 'node:crypto'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import { ItadAsset, ItadCertificate, ItadSanitizationRun, type ItadJob } from '../data/entities'
import {
  canonicalSourceJson,
  decideEligibility,
  sourceDifferences,
  type CertificateDifference,
  type CertificateLocale,
  type CertificateSourceData,
  type CertificateStatus,
  type CertificateVoidReasonCode,
  type EligibilityDecision,
  type EligibilityFacts,
} from '../domain/certificates'
import { loadCompanyNames } from '../module-integrations/customers'
import { loadUserDisplayNames } from '../module-integrations/users'

/**
 * Read side of certificates (certificates spec). Eligibility facts are read inside the
 * caller's transaction (the issue flow reads them twice: before allocating a number and
 * again under the job lock in `persistLink`).
 */
type Scope = { tenantId: string; organizationId: string }

export type LoadedEligibility = {
  facts: EligibilityFacts
  asset: ItadAsset | null
  runs: ItadSanitizationRun[]
}

/** Asset (also a removed one), its runs in this job and whether it has an issued certificate. */
export async function loadEligibility(
  em: EntityManager,
  scope: Scope,
  job: ItadJob,
  assetId: string,
): Promise<LoadedEligibility> {
  const asset = await em.findOne(ItadAsset, {
    id: assetId,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    job: job.id,
  } as FilterQuery<ItadAsset>)
  const runs = asset
    ? await em.find(ItadSanitizationRun, {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        job: job.id,
        asset: asset.id,
      } as FilterQuery<ItadSanitizationRun>)
    : []
  const issued = asset
    ? await em.count(ItadCertificate, {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        asset: asset.id,
        status: 'issued',
      } as FilterQuery<ItadCertificate>)
    : 0
  return {
    asset,
    runs,
    facts: {
      job: { status: job.status, statusBeforeHold: job.statusBeforeHold ?? null },
      asset: {
        id: asset?.id ?? assetId,
        jobId: job.id,
        dataBearing: asset?.dataBearing ?? null,
        status: asset?.status ?? 'received',
        deleted: !asset || Boolean(asset.deletedAt),
      },
      runs: runs.map((run) => ({
        id: run.id,
        assetId: asset?.id ?? assetId,
        jobId: job.id,
        result: run.result ?? null,
        finishedAt: run.finishedAt ?? null,
      })),
      hasIssuedCertificate: issued > 0,
    },
  }
}

/** What the certificate will show, resolved now from the sources (spec "Snapshot"). */
export async function loadSourceData(
  queryEngine: QueryEngine,
  scope: Scope,
  job: ItadJob,
  asset: ItadAsset,
  run: ItadSanitizationRun,
): Promise<CertificateSourceData> {
  const companies = await loadCompanyNames(queryEngine, scope, [job.customerId])
  const users = await loadUserDisplayNames(queryEngine, scope.tenantId, [run.operatorUserId, run.finishedByUserId])
  const userName = (id: string | null | undefined) => (id ? users.get(id) ?? id : '')
  return {
    customerName: companies.get(job.customerId) ?? '',
    jobReference: job.internalReference,
    customerReference: job.customerReference ?? null,
    jobName: job.name,
    assetSerial: asset.serial,
    customerAssetTag: asset.customerAssetTag ?? null,
    manufacturer: asset.manufacturer ?? null,
    model: asset.model ?? null,
    mediaIdentifiers: Array.isArray(run.mediaIdentifiers) ? [...run.mediaIdentifiers] : [],
    method: run.method,
    methodDetail: run.methodDetail ?? null,
    tool: run.tool,
    toolVersion: run.toolVersion,
    result: 'PASS',
    verificationMethod: run.verificationMethod ?? null,
    startedAt: run.startedAt.toISOString(),
    completedAt: (run.finishedAt ?? run.startedAt).toISOString(),
    startedBy: userName(run.operatorUserId),
    resultRecordedBy: userName(run.finishedByUserId),
    sourceRunId: run.id,
  }
}

export type CertificateListItem = {
  id: string
  certificateNumber: string
  status: CertificateStatus
  locale: CertificateLocale
  assetId: string
  assetSerial: string
  sourceRun: { id: string; method: string; tool: string; toolVersion: string; completedAt: string }
  issuedAt: string
  issuedBy: { id: string; name: string | null }
  supersedesCertificateId: string | null
  supersededByCertificateId: string | null
  supersedeReason: string | null
  supersededAt: string | null
  supersededBy: { id: string; name: string | null } | null
  voidedAt: string | null
  voidedBy: { id: string; name: string | null } | null
  voidReason: string | null
  voidReasonCode: CertificateVoidReasonCode | null
  updatedAt: string
}

/** Certificates of one asset (or of the whole job), newest first, with issuer names. */
export async function listCertificates(
  em: EntityManager,
  queryEngine: QueryEngine,
  scope: Scope,
  filter: { jobId: string; assetId?: string },
): Promise<CertificateListItem[]> {
  const where: Record<string, unknown> = { tenantId: scope.tenantId, organizationId: scope.organizationId, job: filter.jobId }
  if (filter.assetId) where.asset = filter.assetId
  const rows = await em.find(ItadCertificate, where as FilterQuery<ItadCertificate>, { orderBy: { issuedAt: 'desc' } })
  const userIds = rows.flatMap((row) => [row.issuedByUserId, row.supersededByUserId, row.voidedByUserId])
  const names = await loadUserDisplayNames(queryEngine, scope.tenantId, userIds.filter((id): id is string => Boolean(id)))
  const user = (id: string | null | undefined) => (id ? { id, name: names.get(id) ?? null } : null)
  return rows.map((row) => ({
    id: row.id,
    certificateNumber: row.certificateNumber,
    status: row.status,
    locale: row.locale,
    assetId: certificateAssetId(row),
    assetSerial: row.snapshot.assetSerial,
    sourceRun: {
      id: row.snapshot.sourceRunId,
      method: row.snapshot.method,
      tool: row.snapshot.tool,
      toolVersion: row.snapshot.toolVersion,
      completedAt: row.snapshot.completedAt,
    },
    issuedAt: row.issuedAt.toISOString(),
    issuedBy: { id: row.issuedByUserId, name: names.get(row.issuedByUserId) ?? null },
    supersedesCertificateId: row.supersedesCertificateId ?? null,
    supersededByCertificateId: row.supersededByCertificateId ?? null,
    supersedeReason: row.supersedeReason ?? null,
    supersededAt: row.supersededAt ? row.supersededAt.toISOString() : null,
    supersededBy: user(row.supersededByUserId),
    voidedAt: row.voidedAt ? row.voidedAt.toISOString() : null,
    voidedBy: user(row.voidedByUserId),
    voidReason: row.voidReason ?? null,
    voidReasonCode: row.voidReasonCode ?? null,
    updatedAt: row.updatedAt.toISOString(),
  }))
}

export function certificateAssetId(certificate: ItadCertificate): string {
  return typeof certificate.asset === 'object' ? certificate.asset.id : String(certificate.asset)
}

/** One certificate of the job in scope, or `null`. */
export async function findCertificate(em: EntityManager, scope: Scope, jobId: string, certificateId: string): Promise<ItadCertificate | null> {
  return em.findOne(ItadCertificate, {
    id: certificateId,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    job: jobId,
  } as FilterQuery<ItadCertificate>)
}

/** Fingerprint of the source data for change detection between preview and reissue (not security). */
export function sourceDataHash(source: CertificateSourceData): string {
  return createHash('sha256').update(canonicalSourceJson(source)).digest('hex')
}

export type ReissuePreview = {
  certificateId: string
  certificateNumber: string
  source: CertificateSourceData
  differences: CertificateDifference[]
  previewHash: string
}

export type ReissueSource =
  | { ok: true; asset: ItadAsset; run: ItadSanitizationRun; source: CertificateSourceData; preview: ReissuePreview }
  | { ok: false; decision: Exclude<EligibilityDecision, { ok: true }> }

/**
 * What a reissue of `certificate` would carry now (spec "Reissue preview"): eligibility
 * for a reissue (the current certificate is expected), the source run, fresh source data,
 * the differences against the current snapshot and the `previewHash`. Writes nothing and
 * has no number, issue time or issuer.
 */
export async function loadReissueSource(
  em: EntityManager,
  queryEngine: QueryEngine,
  scope: Scope,
  job: ItadJob,
  certificate: ItadCertificate,
): Promise<ReissueSource> {
  const assetId = certificateAssetId(certificate)
  const loaded = await loadEligibility(em, scope, job, assetId)
  const decision = decideEligibility(loaded.facts, 'reissue')
  if (!decision.ok) return { ok: false, decision }
  const run = loaded.runs.find((entry) => entry.id === decision.sourceRunId)
  if (!run || !loaded.asset) throw new Error('[internal] Eligible reissue without asset or run')
  const source = await loadSourceData(queryEngine, scope, job, loaded.asset, run)
  return {
    ok: true,
    asset: loaded.asset,
    run,
    source,
    preview: {
      certificateId: certificate.id,
      certificateNumber: certificate.certificateNumber,
      source,
      differences: sourceDifferences(certificate.snapshot, source),
      previewHash: sourceDataHash(source),
    },
  }
}

import type { EntityManager } from '@mikro-orm/postgresql'
import { ItadCertificate, ItadCertificateEvent, type ItadAsset, type ItadJob, type ItadSanitizationRun } from '../data/entities'
import type { CertificateLocale, CertificateSnapshot, CertificateVoidReasonCode } from '../domain/certificates'

/**
 * Writes certificate rows inside the caller's transaction (certificates spec "Issue").
 * The command owns the transaction, the job lock and the eligibility checks; this only
 * writes certificate rows and their append-only history rows.
 */
type Scope = { tenantId: string; organizationId: string }

export function insertIssuedCertificate(
  tx: EntityManager,
  scope: Scope,
  input: {
    job: ItadJob
    asset: ItadAsset
    run: ItadSanitizationRun
    snapshot: CertificateSnapshot
    locale: CertificateLocale
    pdfAttachmentId: string
    actorUserId: string
    issuedAt: Date
    supersedesCertificateId?: string | null
  },
): ItadCertificate {
  const certificate = tx.create(ItadCertificate, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    certificateNumber: input.snapshot.certificateNumber,
    job: input.job,
    asset: input.asset,
    sanitizationRun: input.run,
    status: 'issued',
    snapshot: input.snapshot,
    locale: input.locale,
    pdfAttachmentId: input.pdfAttachmentId,
    issuedByUserId: input.actorUserId,
    issuedAt: input.issuedAt,
    supersedesCertificateId: input.supersedesCertificateId ?? null,
    createdAt: input.issuedAt,
    updatedAt: input.issuedAt,
  })
  tx.persist(certificate)
  tx.persist(
    tx.create(ItadCertificateEvent, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      certificate,
      kind: 'issued',
      relatedCertificateId: input.supersedesCertificateId ?? null,
      actorUserId: input.actorUserId,
      createdAt: input.issuedAt,
    }),
  )
  return certificate
}

/**
 * Marks the old certificate `superseded` (spec "Reissue", step 5). The successor link is
 * set by `linkSuccessor` once the new certificate exists; the partial unique index allows
 * the new `issued` row only after this change is flushed.
 */
export function markSuperseded(
  certificate: ItadCertificate,
  input: { actorUserId: string; reason: string; now: Date },
): void {
  certificate.status = 'superseded'
  certificate.supersededAt = input.now
  certificate.supersededByUserId = input.actorUserId
  certificate.supersedeReason = input.reason
  certificate.updatedAt = input.now
}

/** Links the superseded certificate to its successor and appends its `superseded` history row. */
export function linkSuccessor(
  tx: EntityManager,
  scope: Scope,
  input: { certificate: ItadCertificate; successor: ItadCertificate; actorUserId: string; reason: string; now: Date },
): void {
  input.certificate.supersededByCertificateId = input.successor.id
  tx.persist(
    tx.create(ItadCertificateEvent, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      certificate: input.certificate,
      kind: 'superseded',
      reason: input.reason,
      relatedCertificateId: input.successor.id,
      actorUserId: input.actorUserId,
      createdAt: input.now,
    }),
  )
}

/** `issued` → `void` with reason, user and time; the snapshot and the PDF stay (spec "Void"). */
export function voidCertificate(
  tx: EntityManager,
  scope: Scope,
  input: { certificate: ItadCertificate; actorUserId: string; reason: string | null; reasonCode: CertificateVoidReasonCode; now: Date },
): void {
  const { certificate } = input
  certificate.status = 'void'
  certificate.voidedAt = input.now
  certificate.voidedByUserId = input.actorUserId
  certificate.voidReason = input.reason
  certificate.voidReasonCode = input.reasonCode
  certificate.updatedAt = input.now
  tx.persist(
    tx.create(ItadCertificateEvent, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      certificate,
      kind: 'voided',
      reason: input.reason ?? input.reasonCode,
      relatedCertificateId: null,
      actorUserId: input.actorUserId,
      createdAt: input.now,
    }),
  )
}

import type { EntityManager } from '@mikro-orm/postgresql'
import { ItadCertificate, ItadCertificateEvent, type ItadAsset, type ItadJob, type ItadSanitizationRun } from '../data/entities'
import type { CertificateLocale, CertificateSnapshot } from '../domain/certificates'

/**
 * Writes certificate rows inside the caller's transaction (certificates spec "Issue").
 * The command owns the transaction, the job lock and the eligibility checks; this only
 * inserts the certificate and its `issued` history row.
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

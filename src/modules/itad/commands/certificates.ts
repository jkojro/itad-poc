import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import { isUniqueViolation } from '@open-mercato/shared/lib/crud/errors'
import { enforceCommandOptimisticLock } from '@open-mercato/shared/lib/crud/optimistic-lock-command'
import { createFallbackTranslator } from '@open-mercato/shared/lib/i18n/translate'
import { loadDictionary, resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import type { ItadAsset, ItadCertificate, ItadJob, ItadSanitizationRun } from '../data/entities'
import {
  itadCertificateIssueSchema,
  itadCertificateReissueSchema,
  itadCertificateVoidSchema,
  type ItadCertificateIssueInput,
  type ItadCertificateReissueInput,
  type ItadCertificateVoidInput,
} from '../data/validators'
import {
  CERTIFICATE_REFERENCE_KIND,
  buildSnapshot,
  certificateReason,
  decideCertificateChange,
  decideEligibility,
  formatCertificateNumber,
  printableFields,
  unprintableFields,
  type CertificateChangeDecision,
  type CertificateLocale,
  type CertificateSourceData,
  type EligibilityDecision,
} from '../domain/certificates'
import { referenceYearOf } from '../domain/references'
import { emitItadEvent } from '../events'
import { certificateError } from '../lib/certificate-errors'
import { ITAD_JOB_ENTITY_ID } from '../lib/constants'
import { EVIDENCE_ATTACHMENT_PARTITION, resolveAttachmentService } from '../module-integrations/attachments'
import { loadUserDisplayNames } from '../module-integrations/users'
import { createGlyphChecker, renderCertificatePdf, type Translate } from '../services/certificate-pdf'
import { certificateAssetId, findCertificate, loadEligibility, loadReissueSource, loadSourceData } from '../services/certificate-reader'
import { insertIssuedCertificate, linkSuccessor, markSuperseded, voidCertificate } from '../services/certificate-writer'
import { allocateSequenceValue } from '../services/job-reference-generator'
import { lockJob } from './job-lock'
import { ensureScope, loadJob, type JobScope } from './jobs'

const logger = createLogger('itad').child({ component: 'certificates' })

/** The partial unique index "one issued certificate per asset" (spec REQ-621). */
const ISSUED_PER_ASSET_INDEX = 'itad_certificates_asset_issued_unique'

/** Resource kind of the certificate optimistic lock and audit entries. */
export const ITAD_CERTIFICATE_LOCK_RESOURCE_KIND = 'itad.certificate'

export type ItadCertificateIssueResult = {
  certificateId: string
  certificateNumber: string
  jobId: string
  assetId: string
  tenantId: string
  organizationId: string
}

export type ItadCertificateReissueResult = ItadCertificateIssueResult & {
  supersededCertificateId: string
  supersededCertificateNumber: string
}

export type ItadCertificateVoidResult = {
  certificateId: string
  certificateNumber: string
  status: 'void'
  updatedAt: string
  jobId: string
  assetId: string
  tenantId: string
  organizationId: string
}

async function resolveActor(ctx: CommandRuntimeContext): Promise<{ scope: JobScope; actorUserId: string; em: EntityManager }> {
  const scope = await ensureScope(ctx)
  const actorUserId = ctx.auth?.sub ?? null
  if (!actorUserId) throw new Error('[internal] Certificate commands require an authenticated actor')
  return { scope, actorUserId, em: ctx.container.resolve<EntityManager>('em').fork() }
}

async function refuse(decision: Exclude<EligibilityDecision, { ok: true }>): Promise<never> {
  if (decision.code === 'certificate_already_issued') return certificateError('certificate_already_issued')
  return certificateError('certificate_not_eligible', { detail: decision.detail })
}

async function refuseChange(decision: Exclude<CertificateChangeDecision, { ok: true }>): Promise<never> {
  if (decision.code === 'certificate_not_issued') return certificateError('certificate_not_issued')
  return certificateError('certificate_not_eligible', { detail: decision.detail })
}

async function loadCertificate(tx: EntityManager, scope: JobScope, jobId: string, certificateId: string): Promise<ItadCertificate> {
  const certificate = await findCertificate(tx, scope, jobId, certificateId)
  if (!certificate) return await certificateError('certificate_not_found')
  return certificate
}

function lockCertificate(ctx: CommandRuntimeContext, certificate: ItadCertificate): void {
  enforceCommandOptimisticLock({
    resourceKind: ITAD_CERTIFICATE_LOCK_RESOURCE_KIND,
    resourceId: certificate.id,
    current: certificate.updatedAt,
    request: ctx.request ?? null,
  })
}

async function translatorFor(locale: CertificateLocale): Promise<Translate> {
  return createFallbackTranslator(await loadDictionary(locale)) as Translate
}

type CheckedSource = { job: ItadJob; asset: ItadAsset; run: ItadSanitizationRun; source: CertificateSourceData }
type Replacement = { certificateId: string; certificateNumber: string; reason: string }

/**
 * Steps 2–5 of the issue flow, shared by issue and reissue (certificates spec "Issue"):
 * 2. the printable-character check — every early refusal spends no number;
 * 3. the number, in its own short transaction (a later failure leaves a logged gap);
 * 4. snapshot and PDF;
 * 5. the PDF and the certificate stored together through `attachments` (`persistLink`),
 *    re-checking the full eligibility under the job lock. A reissue supersedes the old
 *    certificate first (the partial unique index allows one `issued` per asset), then
 *    inserts the new one and links both.
 */
async function produceCertificate(
  ctx: CommandRuntimeContext,
  args: {
    scope: JobScope
    actorUserId: string
    em: EntityManager
    queryEngine: QueryEngine
    locale: CertificateLocale
    checked: CheckedSource
    replaces: Replacement | null
  },
): Promise<{ certificateId: string; certificateNumber: string }> {
  const { scope, actorUserId, em, queryEngine, locale, checked, replaces } = args
  const jobId = checked.job.id
  const assetId = checked.asset.id
  const unprintable = unprintableFields(printableFields(checked.source), await createGlyphChecker())
  if (unprintable.length > 0) await certificateError('certificate_unprintable_characters', { fields: unprintable })

  const issuedAt = new Date()
  const year = referenceYearOf(issuedAt)
  const value = await em.fork().transactional((tx) => allocateSequenceValue(tx, scope, CERTIFICATE_REFERENCE_KIND, year))
  const certificateNumber = formatCertificateNumber(year, value)

  const issuer = await loadUserDisplayNames(queryEngine, scope.tenantId, [actorUserId])
  const snapshot = buildSnapshot(checked.source, {
    certificateNumber,
    issuedAt,
    issuedBy: issuer.get(actorUserId) ?? actorUserId,
    locale,
    supersedes: replaces?.certificateNumber ?? null,
  })
  const pdf = await renderCertificatePdf(snapshot, await translatorFor(locale))

  const stored: { id?: string } = {}
  try {
    await resolveAttachmentService(ctx.container).createScoped({
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      entityId: ITAD_JOB_ENTITY_ID,
      recordId: jobId,
      partitionCode: EVIDENCE_ATTACHMENT_PARTITION,
      fileName: `${certificateNumber}.pdf`,
      declaredMimeType: 'application/pdf',
      buffer: Buffer.from(pdf),
      persistLink: async (tx, attachmentId) => {
        const job = await lockJob(tx, scope, jobId)
        const fresh = await loadEligibility(tx, scope, job, assetId)
        const decision = decideEligibility(fresh.facts, replaces ? 'reissue' : 'issue')
        if (!decision.ok) return await refuse(decision)
        // A newer PASS run appeared meanwhile: this PDF describes the old one.
        if (decision.sourceRunId !== checked.run.id) {
          return await certificateError('certificate_not_eligible', { detail: 'no_pass_run' })
        }
        let previous: ItadCertificate | null = null
        if (replaces) {
          previous = await loadCertificate(tx, scope, jobId, replaces.certificateId)
          const change = decideCertificateChange(previous, job, 'reissue')
          if (!change.ok) return await refuseChange(change)
          markSuperseded(previous, { actorUserId, reason: replaces.reason, now: issuedAt })
          await tx.flush()
        }
        const certificate = insertIssuedCertificate(tx, scope, {
          job,
          asset: fresh.asset!,
          run: fresh.runs.find((run) => run.id === decision.sourceRunId)!,
          snapshot,
          locale,
          pdfAttachmentId: attachmentId,
          actorUserId,
          issuedAt,
          supersedesCertificateId: previous?.id ?? null,
        })
        await tx.flush()
        if (previous && replaces) {
          linkSuccessor(tx, scope, { certificate: previous, successor: certificate, actorUserId, reason: replaces.reason, now: issuedAt })
          await tx.flush()
        }
        stored.id = certificate.id
      },
    })
  } catch (err) {
    logger.warn('Certificate number left unused', { certificateNumber, jobId, assetId })
    if (isUniqueViolation(err, ISSUED_PER_ASSET_INDEX)) return await certificateError('certificate_already_issued')
    throw err
  }
  if (!stored.id) throw new Error('[internal] Certificate was not stored')

  const base = { jobId, assetId, actorUserId, tenantId: scope.tenantId, organizationId: scope.organizationId }
  try {
    await emitItadEvent('itad.certificate.issued', {
      certificateId: stored.id,
      certificateNumber,
      supersedesCertificateId: replaces?.certificateId ?? null,
      ...base,
    })
    if (replaces) {
      await emitItadEvent('itad.certificate.superseded', {
        certificateId: replaces.certificateId,
        certificateNumber: replaces.certificateNumber,
        supersededByCertificateId: stored.id,
        ...base,
      })
    }
  } catch (err) {
    logger.error('Failed to emit certificate events', { err })
  }
  return { certificateId: stored.id, certificateNumber }
}

/** Issues one Certificate of Data Sanitization: eligibility under the job lock, then steps 2–5. */
const issueCommand: CommandHandler<ItadCertificateIssueInput, ItadCertificateIssueResult> = {
  id: 'itad.certificates.issue',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = itadCertificateIssueSchema.parse(rawInput)
    const { scope, actorUserId, em } = await resolveActor(ctx)
    await loadJob(em, scope, input.jobId)
    const queryEngine = ctx.container.resolve<QueryEngine>('queryEngine')

    const checked = await em.transactional(async (tx) => {
      const job = await lockJob(tx, scope, input.jobId)
      const loaded = await loadEligibility(tx, scope, job, input.assetId)
      const decision = decideEligibility(loaded.facts)
      if (!decision.ok) return await refuse(decision)
      const run = loaded.runs.find((entry) => entry.id === decision.sourceRunId)
      if (!run || !loaded.asset) throw new Error('[internal] Eligible certificate without asset or run')
      return { job, asset: loaded.asset, run }
    })
    const source = await loadSourceData(queryEngine, scope, checked.job, checked.asset, checked.run)

    const produced = await produceCertificate(ctx, {
      scope,
      actorUserId,
      em,
      queryEngine,
      locale: input.locale,
      checked: { ...checked, source },
      replaces: null,
    })
    return {
      ...produced,
      jobId: input.jobId,
      assetId: input.assetId,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
    }
  },
  buildLog: async ({ result }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('itad.audit.certificates.issue', 'Issue ITAD certificate'),
      resourceKind: ITAD_CERTIFICATE_LOCK_RESOURCE_KIND,
      resourceId: result.certificateId,
      parentResourceKind: 'itad.job',
      parentResourceId: result.jobId,
      tenantId: result.tenantId,
      organizationId: result.organizationId,
      snapshotAfter: { certificateNumber: result.certificateNumber, assetId: result.assetId, status: 'issued' },
    }
  },
}

/**
 * Reissues an `issued` certificate (spec "Reissue"): a required reason, the optimistic
 * lock on the old certificate, fresh source data whose hash must equal the `previewHash`
 * the user confirmed (else 409 `certificate_preview_stale`), then steps 2–5 with the old
 * certificate superseded in the same transaction. The new one gets a new number.
 */
const reissueCommand: CommandHandler<ItadCertificateReissueInput, ItadCertificateReissueResult> = {
  id: 'itad.certificates.reissue',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = itadCertificateReissueSchema.parse(rawInput)
    const reason = certificateReason(input.reason)
    if (reason === false) return await certificateError('reason_required')
    const { scope, actorUserId, em } = await resolveActor(ctx)
    await loadJob(em, scope, input.jobId)
    const queryEngine = ctx.container.resolve<QueryEngine>('queryEngine')

    const prepared = await em.transactional(async (tx) => {
      const job = await lockJob(tx, scope, input.jobId)
      const certificate = await loadCertificate(tx, scope, job.id, input.certificateId)
      lockCertificate(ctx, certificate)
      const change = decideCertificateChange(certificate, job, 'reissue')
      if (!change.ok) return await refuseChange(change)
      const reissue = await loadReissueSource(tx, queryEngine, scope, job, certificate)
      if (!reissue.ok) return await refuse(reissue.decision)
      return { job, certificate, reissue }
    })
    const { job, certificate, reissue } = prepared
    if (reissue.preview.previewHash !== input.previewHash) return await certificateError('certificate_preview_stale')

    const produced = await produceCertificate(ctx, {
      scope,
      actorUserId,
      em,
      queryEngine,
      locale: input.locale,
      checked: { job, asset: reissue.asset, run: reissue.run, source: reissue.source },
      replaces: { certificateId: certificate.id, certificateNumber: certificate.certificateNumber, reason },
    })
    return {
      ...produced,
      supersededCertificateId: certificate.id,
      supersededCertificateNumber: certificate.certificateNumber,
      jobId: input.jobId,
      assetId: reissue.asset.id,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
    }
  },
  buildLog: async ({ result }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('itad.audit.certificates.reissue', 'Reissue ITAD certificate'),
      resourceKind: ITAD_CERTIFICATE_LOCK_RESOURCE_KIND,
      resourceId: result.certificateId,
      parentResourceKind: 'itad.job',
      parentResourceId: result.jobId,
      tenantId: result.tenantId,
      organizationId: result.organizationId,
      snapshotBefore: { certificateNumber: result.supersededCertificateNumber, status: 'issued' },
      snapshotAfter: {
        certificateNumber: result.certificateNumber,
        supersedes: result.supersededCertificateNumber,
        assetId: result.assetId,
        status: 'issued',
      },
    }
  },
}

/**
 * Voids an `issued` certificate with a required reason (spec "Void", Q11). The snapshot
 * and the PDF stay; if the asset still requires a certificate, it counts as missing again.
 */
const voidCommand: CommandHandler<ItadCertificateVoidInput, ItadCertificateVoidResult> = {
  id: 'itad.certificates.void',
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = itadCertificateVoidSchema.parse(rawInput)
    const reason = certificateReason(input.reason)
    if (reason === false) return await certificateError('reason_required')
    const { scope, actorUserId, em } = await resolveActor(ctx)
    await loadJob(em, scope, input.jobId)

    const result = await em.transactional(async (tx) => {
      const job = await lockJob(tx, scope, input.jobId)
      const certificate = await loadCertificate(tx, scope, job.id, input.certificateId)
      lockCertificate(ctx, certificate)
      const change = decideCertificateChange(certificate, job, 'void')
      if (!change.ok) return await refuseChange(change)
      voidCertificate(tx, scope, { certificate, actorUserId, reason, reasonCode: 'manual', now: new Date() })
      await tx.flush()
      return {
        certificateId: certificate.id,
        certificateNumber: certificate.certificateNumber,
        status: 'void' as const,
        updatedAt: certificate.updatedAt.toISOString(),
        jobId: job.id,
        assetId: certificateAssetId(certificate),
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
      }
    })
    try {
      await emitItadEvent('itad.certificate.voided', {
        certificateId: result.certificateId,
        certificateNumber: result.certificateNumber,
        voidReasonCode: 'manual',
        jobId: result.jobId,
        assetId: result.assetId,
        actorUserId,
        tenantId: result.tenantId,
        organizationId: result.organizationId,
      })
    } catch (err) {
      logger.error('Failed to emit itad.certificate.voided', { err })
    }
    return result
  },
  buildLog: async ({ result }) => {
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('itad.audit.certificates.void', 'Void ITAD certificate'),
      resourceKind: ITAD_CERTIFICATE_LOCK_RESOURCE_KIND,
      resourceId: result.certificateId,
      parentResourceKind: 'itad.job',
      parentResourceId: result.jobId,
      tenantId: result.tenantId,
      organizationId: result.organizationId,
      snapshotBefore: { certificateNumber: result.certificateNumber, status: 'issued' },
      snapshotAfter: { certificateNumber: result.certificateNumber, status: 'void', voidReasonCode: 'manual' },
    }
  },
}

registerCommand(issueCommand)
registerCommand(reissueCommand)
registerCommand(voidCommand)

import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import { isUniqueViolation } from '@open-mercato/shared/lib/crud/errors'
import { createFallbackTranslator } from '@open-mercato/shared/lib/i18n/translate'
import { loadDictionary, resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import { itadCertificateIssueSchema, type ItadCertificateIssueInput } from '../data/validators'
import {
  CERTIFICATE_REFERENCE_KIND,
  buildSnapshot,
  decideEligibility,
  formatCertificateNumber,
  printableFields,
  unprintableFields,
  type CertificateLocale,
  type EligibilityDecision,
} from '../domain/certificates'
import { referenceYearOf } from '../domain/references'
import { emitItadEvent } from '../events'
import { certificateError } from '../lib/certificate-errors'
import { ITAD_JOB_ENTITY_ID } from '../lib/constants'
import { EVIDENCE_ATTACHMENT_PARTITION, resolveAttachmentService } from '../module-integrations/attachments'
import { loadUserDisplayNames } from '../module-integrations/users'
import { createGlyphChecker, renderCertificatePdf, type Translate } from '../services/certificate-pdf'
import { loadEligibility, loadSourceData } from '../services/certificate-reader'
import { insertIssuedCertificate } from '../services/certificate-writer'
import { allocateSequenceValue } from '../services/job-reference-generator'
import { lockJob } from './job-lock'
import { ensureScope, loadJob, type JobScope } from './jobs'

const logger = createLogger('itad').child({ component: 'certificates' })

/** The partial unique index "one issued certificate per asset" (spec REQ-621). */
const ISSUED_PER_ASSET_INDEX = 'itad_certificates_asset_issued_unique'

export type ItadCertificateIssueResult = {
  certificateId: string
  certificateNumber: string
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

async function translatorFor(locale: CertificateLocale): Promise<Translate> {
  return createFallbackTranslator(await loadDictionary(locale)) as Translate
}

/**
 * Issues one Certificate of Data Sanitization (certificates spec "Issue"):
 * 1. eligibility under the job lock;
 * 2. source data and the printable-character check — every early refusal spends no number;
 * 3. the number, in its own short transaction (a later failure leaves a logged gap);
 * 4. snapshot and PDF;
 * 5. the PDF and the certificate stored together through `attachments` (`persistLink`),
 *    re-checking the full eligibility under the job lock.
 */
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
    const unprintable = unprintableFields(printableFields(source), await createGlyphChecker())
    if (unprintable.length > 0) await certificateError('certificate_unprintable_characters', { fields: unprintable })

    const issuedAt = new Date()
    const year = referenceYearOf(issuedAt)
    const value = await em.fork().transactional((tx) => allocateSequenceValue(tx, scope, CERTIFICATE_REFERENCE_KIND, year))
    const certificateNumber = formatCertificateNumber(year, value)

    const issuer = await loadUserDisplayNames(queryEngine, scope.tenantId, [actorUserId])
    const snapshot = buildSnapshot(source, {
      certificateNumber,
      issuedAt,
      issuedBy: issuer.get(actorUserId) ?? actorUserId,
      locale: input.locale,
    })
    const pdf = await renderCertificatePdf(snapshot, await translatorFor(input.locale))

    const stored: { id?: string } = {}
    try {
      await resolveAttachmentService(ctx.container).createScoped({
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        entityId: ITAD_JOB_ENTITY_ID,
        recordId: input.jobId,
        partitionCode: EVIDENCE_ATTACHMENT_PARTITION,
        fileName: `${certificateNumber}.pdf`,
        declaredMimeType: 'application/pdf',
        buffer: Buffer.from(pdf),
        persistLink: async (tx, attachmentId) => {
          const job = await lockJob(tx, scope, input.jobId)
          const fresh = await loadEligibility(tx, scope, job, input.assetId)
          const decision = decideEligibility(fresh.facts)
          if (!decision.ok) return await refuse(decision)
          // A newer PASS run appeared meanwhile: this PDF describes the old one.
          if (decision.sourceRunId !== checked.run.id) {
            return await certificateError('certificate_not_eligible', { detail: 'no_pass_run' })
          }
          const certificate = insertIssuedCertificate(tx, scope, {
            job,
            asset: fresh.asset!,
            run: fresh.runs.find((run) => run.id === decision.sourceRunId)!,
            snapshot,
            locale: input.locale,
            pdfAttachmentId: attachmentId,
            actorUserId,
            issuedAt,
          })
          await tx.flush()
          stored.id = certificate.id
        },
      })
    } catch (err) {
      logger.warn('Certificate number left unused', { certificateNumber, jobId: input.jobId, assetId: input.assetId })
      if (isUniqueViolation(err, ISSUED_PER_ASSET_INDEX)) return await certificateError('certificate_already_issued')
      throw err
    }
    if (!stored.id) throw new Error('[internal] Certificate was not stored')

    try {
      await emitItadEvent('itad.certificate.issued', {
        certificateId: stored.id,
        certificateNumber,
        supersedesCertificateId: null,
        jobId: input.jobId,
        assetId: input.assetId,
        actorUserId,
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
      })
    } catch (err) {
      logger.error('Failed to emit itad.certificate.issued', { err })
    }
    return {
      certificateId: stored.id,
      certificateNumber,
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
      resourceKind: 'itad.certificate',
      resourceId: result.certificateId,
      parentResourceKind: 'itad.job',
      parentResourceId: result.jobId,
      tenantId: result.tenantId,
      organizationId: result.organizationId,
      snapshotAfter: { certificateNumber: result.certificateNumber, assetId: result.assetId, status: 'issued' },
    }
  },
}

registerCommand(issueCommand)

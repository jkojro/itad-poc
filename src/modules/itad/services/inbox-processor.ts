import type { EntityManager } from '@mikro-orm/postgresql'
import type { AwilixContainer } from 'awilix'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import { ItadInboxAction, ItadInboxMessage, ItadJob } from '../data/entities'
import type { ExtractedIntent, InboxExtraction } from '../domain/inbox'
import { buildActions, orderedIntents, type ProposedAction } from '../domain/inbox-proposals'
import type { EmailParts } from '../domain/inbox-matching'
import type { InboxInterpretation } from '../lib/inbox-interpreter-agent'
import type { InboxProcessJob } from '../lib/inbox-queue'
import { factualDraft, loadJobFacts, type JobFacts } from './inbox-drafts'
import { INBOX_INTERPRETER_MODEL, interpretEmail, type GenerateObjectOverride } from './inbox-interpreter'
import { matchMessage } from './inbox-matcher'

/**
 * Processing of one inbox message generation (spec "Processing idempotency"): matching
 * and the model call run outside any transaction; the result is written in one
 * transaction that locks the message row and proceeds only while the message is still
 * `processing` at this generation. Undecided actions of older generations are superseded,
 * decided ones are never touched, and `(message, generation, ordinal)` is unique — so a
 * retried or duplicated job leaves exactly one set of actions.
 */

const logger = createLogger('itad').child({ component: 'inbox-processor' })

const strip = <T>(value: T | null | undefined): T | undefined => (value === null ? undefined : value)

/** The model output as the domain stores it (nullable fields become absent). */
export function toExtraction(interpretation: InboxInterpretation): InboxExtraction {
  return {
    intents: interpretation.intents.map(
      (intent): ExtractedIntent => ({
        intent: intent.intent,
        confidence: intent.confidence,
        serials: strip(intent.serials),
        scheduledPickup: strip(intent.scheduledPickup),
        expectedAssetEstimate: strip(intent.expectedAssetEstimate),
        pickupLocation: strip(intent.pickupLocation),
        customerReference: strip(intent.customerReference),
        suggestedName: strip(intent.suggestedName),
        outcome: strip(intent.outcome),
        reason: strip(intent.reason),
      }),
    ),
    summary: interpretation.summary,
    language: interpretation.language,
  }
}

export type ProcessOptions = {
  /** Last queue attempt: an error marks the message `failed` instead of being retried. */
  finalAttempt: boolean
  generateObject?: GenerateObjectOverride
  now?: Date
}

export async function processInboxMessage(container: AwilixContainer, job: InboxProcessJob, options: ProcessOptions): Promise<'written' | 'skipped' | 'failed'> {
  const scope = { tenantId: job.tenantId, organizationId: job.organizationId }
  const em = container.resolve<EntityManager>('em').fork()
  const message = await findOneWithDecryption(em, ItadInboxMessage, { id: job.messageId, ...scope, deletedAt: null }, undefined, scope)
  if (!message || message.status !== 'processing' || message.generation !== job.generation) return 'skipped'

  try {
    const parts: EmailParts = { currentText: message.currentText, subject: message.subject, history: message.threadMessages.map((entry) => entry.body) }
    const outsiderForward = message.forwardedByUserId ? null : message.threadMessages.find((entry) => entry.isForwarded && entry.from)?.from ?? null
    const queryEngine = container.resolve<QueryEngine>('queryEngine')
    const { match, levels } = await matchMessage(em, queryEngine, {
      ...scope,
      parts,
      customerAddress: message.customerAddress,
      forwardedSender: outsiderForward,
    })
    const { translate } = await resolveTranslations()
    const chosenJob = levels.job.id ? await em.findOne(ItadJob, { id: levels.job.id, ...scope, deletedAt: null } as never) : null
    const facts: JobFacts | null = chosenJob ? await loadJobFacts(em, chosenJob, translate) : null

    // Integration tests never call a provider (OM_TEST_MODE): a manual import may seed the
    // interpretation; anything else (e.g. a webhook delivery) gets an empty one.
    const testMode = process.env.OM_TEST_MODE === '1'
    const seeded = testMode ? message.extraction ?? { intents: [], summary: '', language: null } : null
    let extraction: InboxExtraction
    let modelDraft: string | null = null
    if (seeded) {
      extraction = seeded
    } else {
      const candidateJobs = await em.find(ItadJob, { ...scope, id: { $in: match.jobs.map((candidate) => candidate.id) }, deletedAt: null } as never)
      const interpretation = await interpretEmail(
        container,
        {
          ...scope,
          today: (options.now ?? new Date()).toISOString(),
          subject: message.subject,
          currentText: message.currentText,
          history: parts.history,
          candidateJobs: candidateJobs.map((candidate) => ({
            reference: candidate.internalReference,
            status: candidate.status,
            scheduledPickupAt: candidate.scheduledPickupAt ? candidate.scheduledPickupAt.toISOString() : null,
            customerReference: candidate.customerReference ?? null,
          })),
          openExceptions: (levels.jobContext?.exceptions ?? []).map((exception) => ({ serial: exception.serial, type: exception.type })),
          jobFacts: facts?.text ?? null,
        },
        { generateObject: options.generateObject },
      )
      extraction = toExtraction(interpretation)
      modelDraft = interpretation.replyDraft.trim() || null
    }

    const actions = buildActions(parts, extraction, levels)
    const intents = orderedIntents(extraction)
    const draft =
      modelDraft ?? factualDraft(translate, { customerName: message.customerName ?? null, facts, statusInquiry: intents.includes('status_inquiry') })

    return await writeResult(em, job, {
      match,
      intents,
      extraction,
      summary: extraction.summary,
      draft,
      actions,
      model: seeded ? null : INBOX_INTERPRETER_MODEL,
    })
  } catch (err) {
    logger.error('Inbox processing failed', { messageId: job.messageId, generation: job.generation, err })
    if (!options.finalAttempt) throw err
    await markFailed(em, job, 'interpretation_failed', 'The email could not be interpreted; reprocess it or handle it manually.')
    return 'failed'
  }
}

type ProcessingResult = {
  match: ItadInboxMessage['match']
  intents: ItadInboxMessage['intents']
  extraction: InboxExtraction
  summary: string
  draft: string
  actions: ProposedAction[]
  model: string | null
}

/** True when this transaction holds the message row at the expected generation, still processing. */
async function lockCurrent(tx: EntityManager, job: InboxProcessJob): Promise<boolean> {
  const rows = await tx.execute<Array<{ status: string; generation: number }>>(
    'select "status", "generation" from "itad_inbox_messages" where "id" = ? and "tenant_id" = ? for update',
    [job.messageId, job.tenantId],
  )
  return rows[0]?.status === 'processing' && Number(rows[0].generation) === job.generation
}

async function writeResult(em: EntityManager, job: InboxProcessJob, result: ProcessingResult): Promise<'written' | 'skipped'> {
  return em.transactional(async (tx) => {
    if (!(await lockCurrent(tx, job))) return 'skipped'
    const message = await tx.findOneOrFail(ItadInboxMessage, { id: job.messageId, tenantId: job.tenantId })
    await tx.nativeUpdate(ItadInboxAction, { message: job.messageId, status: 'pending', generation: { $lt: job.generation } } as never, { status: 'superseded' })
    result.actions.forEach((action, ordinal) => {
      tx.persist(
        tx.create(ItadInboxAction, {
          tenantId: message.tenantId,
          organizationId: message.organizationId,
          message,
          generation: job.generation,
          ordinal,
          type: action.type,
          target: action.target,
          payload: action.payload,
          originalPayload: action.payload,
          fieldSources: action.fieldSources,
          matchStatus: action.matchStatus,
          missingFields: action.missingFields,
          targetVersion: action.targetVersion,
          status: 'pending',
        } as never),
      )
    })
    message.match = result.match
    message.jobId = result.match?.jobId ?? null
    message.intents = result.intents
    message.extraction = result.extraction
    message.summary = result.summary
    message.draftReply = result.draft
    message.draftGeneratedAt = new Date()
    message.model = result.model
    message.processingError = null
    message.status = 'proposed'
    await tx.flush()
    return 'written'
  })
}

async function markFailed(em: EntityManager, job: InboxProcessJob, code: string, text: string): Promise<void> {
  await em.fork().transactional(async (tx) => {
    if (!(await lockCurrent(tx, job))) return
    const message = await tx.findOneOrFail(ItadInboxMessage, { id: job.messageId, tenantId: job.tenantId })
    message.status = 'failed'
    message.processingError = { code, message: text }
    await tx.flush()
  })
}

/**
 * Refresh draft (spec "Draft reply", US-IN-04): rebuilds the reply from the job's current
 * facts. The model words it in the email's language; without the model (integration
 * environment, or when it fails) the factual draft in the operator's locale is used.
 */
export async function buildRefreshedDraft(
  container: AwilixContainer,
  message: ItadInboxMessage,
  options: { generateObject?: GenerateObjectOverride; now?: Date } = {},
): Promise<string> {
  const scope = { tenantId: message.tenantId, organizationId: message.organizationId }
  const em = container.resolve<EntityManager>('em').fork()
  const { translate } = await resolveTranslations()
  const job = message.jobId ? await em.findOne(ItadJob, { id: message.jobId, ...scope, deletedAt: null } as never) : null
  const facts = job ? await loadJobFacts(em, job, translate) : null
  const statusInquiry = message.intents.includes('status_inquiry')
  const fallback = factualDraft(translate, { customerName: message.customerName ?? null, facts, statusInquiry })
  if (process.env.OM_TEST_MODE === '1') return fallback
  try {
    const interpretation = await interpretEmail(
      container,
      {
        ...scope,
        today: (options.now ?? new Date()).toISOString(),
        subject: message.subject,
        currentText: message.currentText,
        history: message.threadMessages.map((entry) => entry.body),
        candidateJobs: job
          ? [{ reference: job.internalReference, status: job.status, scheduledPickupAt: job.scheduledPickupAt?.toISOString() ?? null, customerReference: job.customerReference ?? null }]
          : [],
        openExceptions: [],
        jobFacts: facts?.text ?? null,
      },
      { generateObject: options.generateObject },
    )
    return interpretation.replyDraft.trim() || fallback
  } catch (err) {
    logger.warn('Draft refresh without the model', { messageId: message.id, err })
    return fallback
  }
}

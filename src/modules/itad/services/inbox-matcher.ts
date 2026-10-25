import type { EntityManager } from '@mikro-orm/postgresql'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import { ItadException, ItadJob } from '../data/entities'
import type { Candidate, InboxMatch, MatchEvidence } from '../domain/inbox'
import { decideLevel, findJobReferences, locateValue, mergeCandidates, type EmailParts } from '../domain/inbox-matching'
import type { JobContext, MatchLevels } from '../domain/inbox-proposals'
import { isTerminalStatus } from '../domain/job-editability'
import { findCompaniesByEmail } from '../module-integrations/customers'

/**
 * Deterministic matching of an inbox message to ITAD records (spec "Match", "Match
 * status"), before and independent of the model. Reads only the message's organization.
 * Evidence: job references (current text > subject > history), job customer references
 * found in the email, and the customer sender (its companies' active jobs, heuristic).
 */

const ACTIVE_JOB_SCAN = 500

export type MatchInput = {
  tenantId: string
  organizationId: string
  parts: EmailParts
  customerAddress: string
  /** A forwarded sender kept only as evidence (a forward by someone outside the organization). */
  forwardedSender: string | null
}

export type MatchResult = { match: InboxMatch; levels: MatchLevels }

export async function matchMessage(em: EntityManager, queryEngine: QueryEngine, input: MatchInput): Promise<MatchResult> {
  const scope = { tenantId: input.tenantId, organizationId: input.organizationId }
  const jobEvidence: Array<{ id: string; evidence: MatchEvidence }> = []
  const customerEvidence: Array<{ id: string; evidence: MatchEvidence }> = []

  // 1. Explicit job references.
  const references = findJobReferences(input.parts)
  if (references.length > 0) {
    const jobs = await em.find(ItadJob, {
      ...scope,
      internalReference: { $in: references.map((entry) => entry.reference) },
      deletedAt: null,
    } as never)
    for (const job of jobs) {
      const found = references.find((entry) => entry.reference === job.internalReference.toUpperCase())
      if (found) jobEvidence.push({ id: job.id, evidence: { kind: 'job_reference', source: found.source, value: job.internalReference } })
    }
  }

  // 2. Customer references of active jobs that occur in the email.
  const activeJobs = (
    await em.find(ItadJob, { ...scope, deletedAt: null } as never, { orderBy: { createdAt: 'desc' }, limit: ACTIVE_JOB_SCAN })
  ).filter((job) => !isTerminalStatus(job.status))
  for (const job of activeJobs) {
    if (!job.customerReference) continue
    const source = locateValue(input.parts, job.customerReference)
    if (source) jobEvidence.push({ id: job.id, evidence: { kind: 'customer_reference', source, value: job.customerReference } })
  }

  // 3. The sender: its companies, and their active jobs as heuristic candidates.
  const senderCompanies = await findCompaniesByEmail(queryEngine, scope, input.customerAddress)
  for (const companyId of senderCompanies) {
    customerEvidence.push({ id: companyId, evidence: { kind: 'sender_email', source: 'sender', value: input.customerAddress } })
  }
  if (input.forwardedSender) {
    for (const companyId of await findCompaniesByEmail(queryEngine, scope, input.forwardedSender)) {
      customerEvidence.push({ id: companyId, evidence: { kind: 'sender_email', source: 'forwarded_sender', value: input.forwardedSender } })
    }
  }
  if (jobEvidence.length === 0) {
    const customerIds = new Set(customerEvidence.map((entry) => entry.id))
    for (const job of activeJobs.filter((candidate) => customerIds.has(candidate.customerId))) {
      const via = customerEvidence.find((entry) => entry.id === job.customerId)!
      jobEvidence.push({ id: job.id, evidence: via.evidence })
    }
  }

  const jobs: Candidate[] = mergeCandidates(jobEvidence)
  const jobLevel = decideLevel(jobs)
  const jobsById = new Map([...activeJobs].map((job) => [job.id, job]))
  for (const candidate of jobs) {
    if (!jobsById.has(candidate.id)) {
      const job = await em.findOne(ItadJob, { ...scope, id: candidate.id, deletedAt: null } as never)
      if (job) jobsById.set(job.id, job)
    }
  }
  const chosenJob = jobLevel.id ? jobsById.get(jobLevel.id) ?? null : null

  // The customer follows the job when one is chosen; otherwise the sender's companies decide.
  const customers: Candidate[] = mergeCandidates(customerEvidence)
  const customerLevel = chosenJob ? { id: chosenJob.customerId, status: jobLevel.status } : decideLevel(customers)

  return {
    match: {
      customerId: customerLevel.id,
      customerStatus: customerLevel.status,
      jobId: chosenJob?.id ?? null,
      jobStatus: jobLevel.status,
      customers,
      jobs,
      overridden: false,
    },
    levels: { customer: customerLevel, job: { id: chosenJob?.id ?? null, status: jobLevel.status }, jobContext: chosenJob ? await jobContext(em, chosenJob) : null },
  }
}

/** The job facts I2 / I3 need: its version and its open missing / unexpected exceptions. */
export async function jobContext(em: EntityManager, job: ItadJob): Promise<JobContext> {
  const exceptions = await em.find(ItadException, {
    tenantId: job.tenantId,
    organizationId: job.organizationId,
    job: job.id,
    status: 'open',
    type: { $in: ['missing_from_delivery', 'unexpected_asset'] },
  } as never)
  return {
    id: job.id,
    updatedAt: job.updatedAt.toISOString(),
    exceptions: exceptions.map((exception) => ({
      id: exception.id,
      type: exception.type,
      status: exception.status,
      serial: exception.serial,
      updatedAt: exception.updatedAt.toISOString(),
    })),
  }
}

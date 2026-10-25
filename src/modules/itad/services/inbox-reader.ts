import type { EntityManager } from '@mikro-orm/postgresql'
import { findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { notFound } from '@open-mercato/shared/lib/crud/errors'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import type { RbacService } from '@open-mercato/core/modules/auth/services/rbacService'
import { ItadException, ItadInboxAction, ItadInboxMessage, ItadJob } from '../data/entities'
import { isStalled, worstMatchStatus, type InboxIntent, type MatchStatus } from '../domain/inbox'
import { messageMatchStatus } from '../domain/inbox-proposals'
import { manualOutcomes } from '../domain/exceptions'
import type { ItadRouteContext } from '../lib/route-context'
import { loadCompanyNames } from '../module-integrations/customers'

/**
 * Read side of ITAD Inbox Ops with the spec's "Read access" rule: `itad.inbox.view` grants
 * the email (the customer's own message) and the proposal's shape; details taken from
 * ITAD records are returned only when the reader also holds that record's view feature
 * in the record's organization — otherwise `{ hidden: true }` says the link exists.
 */

type Hidden = { hidden: true }
const HIDDEN: Hidden = { hidden: true }

type Grants = { jobs: boolean; exceptions: boolean }

async function grantsFor(route: ItadRouteContext, organizationId: string, cache: Map<string, Grants>): Promise<Grants> {
  const cached = cache.get(organizationId)
  if (cached) return cached
  const rbac = route.container.resolve<RbacService>('rbacService')
  const scope = { tenantId: route.tenantId, organizationId }
  const [jobs, exceptions] = await Promise.all([
    rbac.userHasAllFeatures(route.userId, ['itad.jobs.view'], scope),
    rbac.userHasAllFeatures(route.userId, ['itad.exceptions.view'], scope),
  ])
  const grants = { jobs, exceptions }
  cache.set(organizationId, grants)
  return grants
}

function scopeWhere(route: ItadRouteContext): Record<string, unknown> {
  const where: Record<string, unknown> = { tenantId: route.tenantId, deletedAt: null }
  if (route.readableOrganizationIds !== null) where.organizationId = { $in: route.readableOrganizationIds }
  return where
}

export type InboxListItem = {
  id: string
  receivedAt: string
  source: string
  customerAddress: string
  customerName: string | null
  subject: string
  intents: InboxIntent[]
  status: string
  stalled: boolean
  matchStatus: MatchStatus | null
  pendingActions: number
  job: { id: string; reference: string } | Hidden | null
  updatedAt: string
}

export async function listInboxMessages(
  route: ItadRouteContext,
  query: { page: number; pageSize: number; status?: string; intent?: string; jobId?: string },
): Promise<{ items: InboxListItem[]; total: number }> {
  const em = route.container.resolve<EntityManager>('em').fork()
  const where = scopeWhere(route)
  if (query.status) where.status = query.status
  if (query.jobId) where.jobId = query.jobId
  // Intents are a small JSON array; filtered in memory on the page (PoC volumes).
  const [rows, total] = await em.findAndCount(ItadInboxMessage, where as never, {
    orderBy: { receivedAt: 'desc', id: 'desc' },
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  })
  const messages = (await findWithDecryption(em, ItadInboxMessage, { id: { $in: rows.map((row) => row.id) } } as never, {}, { tenantId: route.tenantId })).filter(
    (message) => !query.intent || message.intents.includes(query.intent as InboxIntent),
  )
  const byId = new Map(messages.map((message) => [message.id, message]))
  const actions = rows.length
    ? await em.find(ItadInboxAction, { message: { $in: rows.map((row) => row.id) }, status: { $ne: 'superseded' } } as never)
    : []
  const jobIds = rows.map((row) => row.jobId).filter((id): id is string => Boolean(id))
  const jobs = jobIds.length ? await em.find(ItadJob, { id: { $in: jobIds }, tenantId: route.tenantId } as never) : []
  const grantsCache = new Map<string, Grants>()
  const now = new Date()
  const items: InboxListItem[] = []
  for (const row of rows) {
    const message = byId.get(row.id)
    if (!message) continue
    const own = actions.filter((action) => (action.message as unknown as { id: string }).id === message.id)
    const grants = await grantsFor(route, message.organizationId, grantsCache)
    const job = message.jobId ? jobs.find((candidate) => candidate.id === message.jobId) ?? null : null
    items.push({
      id: message.id,
      receivedAt: message.receivedAt.toISOString(),
      source: message.source,
      customerAddress: message.customerAddress,
      customerName: message.customerName ?? null,
      subject: message.subject,
      intents: message.intents,
      status: message.status,
      stalled: isStalled(message.status, message.processingStartedAt ?? null, now),
      matchStatus: message.status === 'proposed' || message.status === 'closed' ? statusOf(message, own) : null,
      pendingActions: own.filter((action) => action.status === 'pending').length,
      job: job ? (grants.jobs ? { id: job.id, reference: job.internalReference } : HIDDEN) : null,
      updatedAt: message.updatedAt.toISOString(),
    })
  }
  return { items, total }
}

function statusOf(message: ItadInboxMessage, actions: ItadInboxAction[]): MatchStatus {
  const live = actions.filter((action) => action.status !== 'superseded')
  if (live.length > 0) return worstMatchStatus(live.map((action) => action.matchStatus))
  const match = message.match
  return messageMatchStatus([], {
    customer: { id: match?.customerId ?? null, status: match?.customerStatus ?? 'needs_review' },
    job: { id: match?.jobId ?? null, status: match?.jobStatus ?? 'needs_review' },
  })
}

export async function readInboxMessage(route: ItadRouteContext, id: string) {
  const em = route.container.resolve<EntityManager>('em').fork()
  const message = await findOneWithDecryption(em, ItadInboxMessage, { id, ...scopeWhere(route) } as never, undefined, { tenantId: route.tenantId })
  if (!message) {
    const { translate } = await resolveTranslations()
    throw notFound(translate('itad.inbox.errors.not_found', 'Message not found'))
  }
  const grants = await grantsFor(route, message.organizationId, new Map())
  const scope = { tenantId: message.tenantId, organizationId: message.organizationId }
  const actions = await findWithDecryption(
    em,
    ItadInboxAction,
    { message: message.id, status: { $ne: 'superseded' } } as never,
    { orderBy: { generation: 'asc', ordinal: 'asc' } },
    scope,
  )

  const match = message.match
  const jobIds = Array.from(new Set([...(match?.jobs ?? []).map((candidate) => candidate.id), ...actions.map((action) => action.target.jobId).filter(Boolean)])) as string[]
  const jobs = jobIds.length ? await em.find(ItadJob, { id: { $in: jobIds }, ...scope } as never) : []
  const exceptionIds = actions.map((action) => action.target.exceptionId).filter((value): value is string => Boolean(value))
  const exceptions = exceptionIds.length ? await em.find(ItadException, { id: { $in: exceptionIds }, ...scope } as never) : []
  const customerIds = Array.from(new Set([...(match?.customers ?? []).map((candidate) => candidate.id), ...jobs.map((job) => job.customerId), ...actions.map((action) => action.target.customerId).filter(Boolean)])) as string[]
  const customerNames = grants.jobs && customerIds.length ? await loadCompanyNames(route.container.resolve<QueryEngine>('queryEngine'), scope, customerIds) : new Map<string, string>()

  const jobView = (jobId: string | null | undefined) => {
    if (!jobId) return null
    if (!grants.jobs) return HIDDEN
    const job = jobs.find((candidate) => candidate.id === jobId)
    return job
      ? {
          id: job.id,
          reference: job.internalReference,
          name: job.name,
          status: job.status,
          scheduledPickupAt: job.scheduledPickupAt ? job.scheduledPickupAt.toISOString() : null,
          customerReference: job.customerReference ?? null,
        }
      : null
  }
  const customerView = (customerId: string | null | undefined) => {
    if (!customerId) return null
    return grants.jobs ? { id: customerId, name: customerNames.get(customerId) ?? null } : HIDDEN
  }
  const exceptionView = (exceptionId: string | null | undefined) => {
    if (!exceptionId) return null
    if (!grants.exceptions) return { kind: 'exception', ...HIDDEN }
    const exception = exceptions.find((candidate) => candidate.id === exceptionId)
    return exception ? { id: exception.id, type: exception.type, status: exception.status, serial: exception.serial } : null
  }
  // Evidence values that come from ITAD records (references) follow the job grant.
  const evidence = (items: Array<{ kind: string; source: string; value: string }>) =>
    items.map((item) => (item.kind === 'sender_email' || grants.jobs ? item : { kind: item.kind, source: item.source, ...HIDDEN }))

  const now = new Date()
  return {
    id: message.id,
    source: message.source,
    status: message.status,
    stalled: isStalled(message.status, message.processingStartedAt ?? null, now),
    generation: message.generation,
    receivedAt: message.receivedAt.toISOString(),
    from: { address: message.fromAddress, name: message.fromName ?? null },
    customerSender: { address: message.customerAddress, name: message.customerName ?? null },
    forwardedByOrganizationUser: Boolean(message.forwardedByUserId),
    subject: message.subject,
    currentText: message.currentText,
    threadMessages: message.threadMessages,
    intents: message.intents,
    summary: message.summary ?? null,
    matchStatus: message.status === 'proposed' || message.status === 'closed' ? statusOf(message, actions) : null,
    match: match
      ? {
          customer: customerView(match.customerId),
          job: jobView(match.jobId),
          overridden: match.overridden,
          customerCandidates: match.customers.map((candidate) => ({ customer: customerView(candidate.id), evidence: evidence(candidate.evidence) })),
          jobCandidates: match.jobs.map((candidate) => ({ job: jobView(candidate.id), evidence: evidence(candidate.evidence) })),
        }
      : null,
    // The draft is built from job counts and blockers: it follows the job grant.
    draftReply: grants.jobs ? message.draftReply ?? null : null,
    draftHidden: !grants.jobs && Boolean(message.draftReply),
    draftGeneratedAt: message.draftGeneratedAt ? message.draftGeneratedAt.toISOString() : null,
    processingError: message.processingError ?? null,
    actions: actions.map((action) => {
      const job = jobView(action.target.jobId)
      return {
        id: action.id,
        type: action.type,
        status: action.status,
        matchStatus: action.matchStatus,
        target: {
          customer: customerView(action.target.customerId),
          job,
          exception: exceptionView(action.target.exceptionId),
        },
        // The fields come from the customer's email or the operator; the I2 "before" is the job's.
        payload: action.payload,
        fieldSources: action.fieldSources,
        missingFields: action.missingFields,
        before: action.type === 'update_pickup' && job && !('hidden' in job) ? { scheduledPickupAt: job.scheduledPickupAt } : null,
        // Outcomes the exception's type allows, for the edit form (only when the exception is visible).
        allowedOutcomes: (() => {
          const view = exceptionView(action.target.exceptionId)
          return view && !('hidden' in view) ? [...manualOutcomes(view.type)] : null
        })(),
        result: action.result ?? null,
        rejectReason: action.rejectReason ?? null,
        decidedAt: action.decidedAt ? action.decidedAt.toISOString() : null,
        updatedAt: action.updatedAt.toISOString(),
      }
    }),
    updatedAt: message.updatedAt.toISOString(),
  }
}

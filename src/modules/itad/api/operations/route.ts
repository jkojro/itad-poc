import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import { ItadJob } from '../../data/entities'
import {
  ACTIVE_JOB_STATUSES,
  EMPTY_JOB_OVERVIEW_SOURCE,
  JOB_OVERVIEW_GROUPS,
  buildJobOverview,
  compareOverviewJobs,
  matchesOperationsFilters,
} from '../../domain/job-overview'
import { ITAD_JOB_STATUSES } from '../../domain/job-types'
import { attentionSignalHref } from '../../lib/job-overview-links'
import { jobOverviewCountersSchema, jobOverviewSignalSchema } from '../../lib/job-overview-schemas'
import { itadRouteErrorResponse, resolveItadRouteContext } from '../../lib/route-context'
import { loadCompanyNames } from '../../module-integrations/customers'
import { loadJobOverviewSources } from '../../services/job-overview-reader'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['itad.jobs.view'] },
}

/** Active jobs are tens in practice; the cap bounds the worst case (spec "Bounded set"). */
const MAX_ACTIVE_JOBS = 500

const flag = z.enum(['true', 'false']).optional().transform((value) => value === 'true')
const querySchema = z.object({
  customerId: z.string().uuid().optional(),
  status: z.array(z.enum(ACTIVE_JOB_STATUSES)).default([]),
  openExceptions: flag,
  missing: flag,
  failed: flag,
  missingCertificates: flag,
})

/**
 * Operations Dashboard (operations dashboard spec Q1, Q2): every active job in the
 * caller's scope with counters, attention signals, severity and group, sorted by need for
 * action. Computed from source data on every read; the filters run on computed values.
 * `customers` lists every customer of the active jobs, before filters, for the filter.
 */
export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams
    const query = querySchema.parse({
      customerId: params.get('customerId') ?? undefined,
      status: params.getAll('status'),
      openExceptions: params.get('openExceptions') ?? undefined,
      missing: params.get('missing') ?? undefined,
      failed: params.get('failed') ?? undefined,
      missingCertificates: params.get('missingCertificates') ?? undefined,
    })
    const route = await resolveItadRouteContext(request)
    if (route.readableOrganizationIds !== null && route.readableOrganizationIds.length === 0) {
      return NextResponse.json({ items: [], customers: [], truncated: false })
    }
    const em = route.container.resolve<EntityManager>('em').fork()
    const where: Record<string, unknown> = {
      tenantId: route.tenantId,
      deletedAt: null,
      status: { $in: [...ACTIVE_JOB_STATUSES] },
    }
    if (route.readableOrganizationIds !== null) where.organizationId = { $in: route.readableOrganizationIds }
    const jobs = await em.find(ItadJob, where as FilterQuery<ItadJob>, {
      orderBy: { scheduledPickupAt: 'asc', internalReference: 'asc' },
      limit: MAX_ACTIVE_JOBS + 1,
    })
    const truncated = jobs.length > MAX_ACTIVE_JOBS
    const active = jobs.slice(0, MAX_ACTIVE_JOBS)

    const queryEngine = route.container.resolve<QueryEngine>('queryEngine')
    const names = new Map<string, string>()
    const byOrganization = new Map<string, Set<string>>()
    for (const job of active) byOrganization.set(job.organizationId, (byOrganization.get(job.organizationId) ?? new Set()).add(job.customerId))
    for (const [organizationId, customerIds] of byOrganization) {
      const found = await loadCompanyNames(queryEngine, { tenantId: route.tenantId, organizationId }, [...customerIds])
      for (const [customerId, name] of found) names.set(`${organizationId}:${customerId}`, name)
    }
    const customers = new Map<string, string | null>()
    for (const job of active) customers.set(job.customerId, names.get(`${job.organizationId}:${job.customerId}`) ?? customers.get(job.customerId) ?? null)

    const sources = await loadJobOverviewSources(em, route.tenantId, active.map((job) => job.id))
    const items = active
      .filter((job) => !query.customerId || job.customerId === query.customerId)
      .filter((job) => query.status.length === 0 || query.status.includes(job.status as (typeof ACTIVE_JOB_STATUSES)[number]))
      .map((job) => {
        const overview = buildJobOverview(job, sources.get(job.id) ?? EMPTY_JOB_OVERVIEW_SOURCE)
        return {
          id: job.id,
          internalReference: job.internalReference,
          name: job.name,
          status: job.status,
          statusBeforeHold: job.statusBeforeHold ?? null,
          customer: { id: job.customerId, name: names.get(`${job.organizationId}:${job.customerId}`) ?? null },
          scheduledPickupAt: job.scheduledPickupAt ? job.scheduledPickupAt.toISOString() : null,
          ...overview,
          signals: overview.signals.map((signal) => ({ ...signal, href: attentionSignalHref(job.id, signal.key) })),
        }
      })
      .filter((item) => matchesOperationsFilters(item.counters, query))
      .sort((a, b) =>
        compareOverviewJobs(
          { group: a.group, scheduledPickupAt: a.scheduledPickupAt ? new Date(a.scheduledPickupAt) : null, internalReference: a.internalReference },
          { group: b.group, scheduledPickupAt: b.scheduledPickupAt ? new Date(b.scheduledPickupAt) : null, internalReference: b.internalReference },
        ),
      )

    return NextResponse.json({
      items,
      customers: [...customers.entries()]
        .map(([id, name]) => ({ id, name }))
        .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')),
      truncated,
    })
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.operations.list')
  }
}

const errorSchema = z.object({ error: z.string(), code: z.string().optional() }).passthrough()

const operationsJobSchema = z.object({
  id: z.string().uuid(),
  internalReference: z.string(),
  name: z.string(),
  status: z.enum(ITAD_JOB_STATUSES),
  statusBeforeHold: z.enum(ITAD_JOB_STATUSES).nullable(),
  customer: z.object({ id: z.string().uuid(), name: z.string().nullable() }),
  scheduledPickupAt: z.string().nullable(),
  counters: jobOverviewCountersSchema,
  signals: z.array(jobOverviewSignalSchema),
  severity: z.enum(['red', 'orange', 'none']),
  group: z.enum(JOB_OVERVIEW_GROUPS),
})

export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'ITAD operations dashboard',
  methods: {
    GET: {
      summary: 'Active jobs grouped by need for action',
      description:
        'Every non-terminal job in scope (at most 500) with its counters, attention signals (with links), severity and group, sorted: needs attention red, orange, in progress, upcoming, drafts; then scheduled pickup. Filters: customer, status (repeatable), and `true` to require open exceptions, missing devices, failed sanitization or missing certificates. `customers` lists the customers of all active jobs, before filters.',
      query: querySchema.extend({
        status: z.array(z.enum(ACTIVE_JOB_STATUSES)).optional(),
        openExceptions: z.enum(['true', 'false']).optional(),
        missing: z.enum(['true', 'false']).optional(),
        failed: z.enum(['true', 'false']).optional(),
        missingCertificates: z.enum(['true', 'false']).optional(),
      }),
      responses: [
        {
          status: 200,
          description: 'Active jobs',
          schema: z.object({
            items: z.array(operationsJobSchema),
            customers: z.array(z.object({ id: z.string().uuid(), name: z.string().nullable() })),
            truncated: z.boolean(),
          }),
        },
      ],
      errors: [
        { status: 400, description: 'Invalid filter', schema: errorSchema },
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Missing itad.jobs.view', schema: errorSchema },
      ],
    },
  },
}

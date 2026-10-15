import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { EMPTY_JOB_OVERVIEW_SOURCE, JOB_OVERVIEW_GROUPS, buildJobOverview } from '../../../../domain/job-overview'
import { jobOverviewCountersSchema, jobOverviewSignalSchema } from '../../../../lib/job-overview-schemas'
import { attentionSignalHref } from '../../../../lib/job-overview-links'
import { itadRouteErrorResponse, loadReadableJob, resolveItadRouteContext } from '../../../../lib/route-context'
import { loadJobOverviewSources } from '../../../../services/job-overview-reader'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['itad.jobs.view'] },
}

const paramsSchema = z.object({ id: z.string().uuid() })

/**
 * Operations overview of one job (operations dashboard spec "Job Overview"): counters,
 * attention signals with links, severity and group, computed from source data at read
 * time. Derived counters need only `itad.jobs.view`, like the jobs list.
 */
export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    const { id } = paramsSchema.parse({ id: params?.id })
    const route = await resolveItadRouteContext(request)
    const job = await loadReadableJob(route, id)
    const em = route.container.resolve<EntityManager>('em').fork()
    const sources = await loadJobOverviewSources(em, route.tenantId, [job.id])
    const overview = buildJobOverview(job, sources.get(job.id) ?? EMPTY_JOB_OVERVIEW_SOURCE)
    return NextResponse.json({
      ...overview,
      signals: overview.signals.map((signal) => ({ ...signal, href: attentionSignalHref(job.id, signal.key) })),
    })
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.jobs.overview')
  }
}

const errorSchema = z.object({ error: z.string(), code: z.string().optional() }).passthrough()

export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'ITAD job overview',
  methods: {
    GET: {
      summary: 'Operations overview of one job',
      description:
        'Current counters of the job (Expected, Received = matched, Missing, Unexpected, Total intake, Awaiting wipe, Sanitized, Failed, open exceptions, certificates), the attention signals with links to where each is resolved, the severity and the dashboard group. Computed from source data on every read.',
      responses: [
        {
          status: 200,
          description: 'Overview',
          schema: z.object({
            counters: jobOverviewCountersSchema,
            signals: z.array(jobOverviewSignalSchema),
            severity: z.enum(['red', 'orange', 'none']),
            group: z.enum(JOB_OVERVIEW_GROUPS),
          }),
        },
      ],
      errors: [
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Missing itad.jobs.view', schema: errorSchema },
        { status: 404, description: 'Job not found in scope', schema: errorSchema },
      ],
    },
  },
}

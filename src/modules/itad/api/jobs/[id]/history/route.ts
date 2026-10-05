import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import { ItadJobConditionConfirmation, ItadJobStatusTransition } from '../../../../data/entities'
import { ITAD_JOB_STATUSES } from '../../../../domain/job-types'
import { ITAD_JOB_ACTIONS } from '../../../../domain/job-state-machine'
import { loadUserDisplayNames } from '../../../../module-integrations/users'
import {
  itadRouteErrorResponse,
  jobIdParamsSchema,
  loadReadableJob,
  resolveItadRouteContext,
} from '../../../../lib/route-context'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['itad.jobs.view'] },
}

/** Domain lifecycle history of one job, newest first, with manual confirmations. */
export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    const { id } = jobIdParamsSchema.parse({ id: params?.id })
    const route = await resolveItadRouteContext(request)
    const job = await loadReadableJob(route, id)
    const em = route.container.resolve<EntityManager>('em').fork()
    const scope = { tenantId: route.tenantId, organizationId: job.organizationId }

    const transitions = await em.find(
      ItadJobStatusTransition,
      { ...scope, job: job.id } as FilterQuery<ItadJobStatusTransition>,
      { orderBy: { createdAt: 'desc' } },
    )
    const confirmations = transitions.length
      ? await em.find(
          ItadJobConditionConfirmation,
          { ...scope, job: job.id } as FilterQuery<ItadJobConditionConfirmation>,
          { orderBy: { confirmedAt: 'asc' } },
        )
      : []

    const queryEngine = route.container.resolve<QueryEngine>('queryEngine')
    const names = await loadUserDisplayNames(queryEngine, route.tenantId, [
      ...transitions.map((entry) => entry.actorUserId),
      ...confirmations.map((entry) => entry.confirmedByUserId),
    ])
    const actor = (userId: string) => ({ id: userId, name: names.get(userId) ?? null })

    const byTransition = new Map<string, ItadJobConditionConfirmation[]>()
    for (const confirmation of confirmations) {
      const key = String(confirmation.transition.id)
      byTransition.set(key, [...(byTransition.get(key) ?? []), confirmation])
    }

    return NextResponse.json({
      items: transitions.map((entry) => ({
        id: entry.id,
        action: entry.action,
        from: entry.fromStatus,
        to: entry.toStatus,
        reason: entry.reason ?? null,
        actor: actor(entry.actorUserId),
        createdAt: entry.createdAt.toISOString(),
        confirmations: (byTransition.get(String(entry.id)) ?? []).map((confirmation) => ({
          condition: confirmation.condition,
          comment: confirmation.comment,
          confirmedBy: actor(confirmation.confirmedByUserId),
          confirmedAt: confirmation.confirmedAt.toISOString(),
        })),
      })),
    })
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.jobs.history.get')
  }
}

const actorSchema = z.object({ id: z.string().uuid(), name: z.string().nullable() })

const historyResponseSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().uuid(),
      action: z.enum(ITAD_JOB_ACTIONS),
      from: z.enum(ITAD_JOB_STATUSES),
      to: z.enum(ITAD_JOB_STATUSES),
      reason: z.string().nullable(),
      actor: actorSchema,
      createdAt: z.string(),
      confirmations: z.array(
        z.object({ condition: z.string(), comment: z.string(), confirmedBy: actorSchema, confirmedAt: z.string() }),
      ),
    }),
  ),
})

export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'ITAD job status history',
  methods: {
    GET: {
      summary: 'List the status history of a job',
      description: 'Append-only domain history (newest first) with the manual confirmations each transition carried.',
      responses: [{ status: 200, description: 'Status history', schema: historyResponseSchema }],
      errors: [
        { status: 401, description: 'Unauthorized', schema: z.object({ error: z.string() }) },
        { status: 403, description: 'Missing itad.jobs.view', schema: z.object({ error: z.string() }) },
        { status: 404, description: 'Job not found in scope', schema: z.object({ error: z.string() }) },
      ],
    },
  },
}

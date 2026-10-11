import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { notFound } from '@open-mercato/shared/lib/crud/errors'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import { ITAD_EXCEPTION_EVENT_KINDS, ITAD_EXCEPTION_OUTCOMES } from '../../../../../domain/exceptions'
import { itadRouteErrorResponse, loadReadableJob, resolveItadRouteContext } from '../../../../../lib/route-context'
import { EXCEPTION_SELECT, loadExceptionEvents, toExceptionItems, type ExceptionRow } from '../../../../../services/exception-list'
import { exceptionItemSchema } from '../../../../../lib/exception-api-schemas'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['itad.exceptions.view'] },
}

const paramsSchema = z.object({ id: z.string().uuid(), exceptionId: z.string().uuid() })

/** One exception with its history (creation, assignments, resolution; exceptions spec E4-052). */
export async function GET(request: Request, { params }: { params: { id: string; exceptionId: string } }) {
  try {
    const { id, exceptionId } = paramsSchema.parse({ id: params?.id, exceptionId: params?.exceptionId })
    const route = await resolveItadRouteContext(request)
    const job = await loadReadableJob(route, id)
    const em = route.container.resolve<EntityManager>('em').fork()
    const rows = await em.execute<ExceptionRow[]>(
      `${EXCEPTION_SELECT} where e."tenant_id" = ? and e."organization_id" = ? and e."job_id" = ? and e."id" = ?`,
      [route.tenantId, job.organizationId, job.id, exceptionId],
    )
    if (!rows.length) {
      const { translate } = await resolveTranslations()
      throw notFound(translate('itad.exceptions.errors.not_found', 'Exception not found'))
    }
    const queryEngine = route.container.resolve<QueryEngine>('queryEngine')
    const [item] = await toExceptionItems(queryEngine, route.tenantId, rows)
    const events = await loadExceptionEvents(em, queryEngine, { tenantId: route.tenantId, organizationId: job.organizationId }, exceptionId)
    return NextResponse.json({ ...item, events })
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.exceptions.detail')
  }
}

const errorSchema = z.object({ error: z.string(), code: z.string().optional() }).passthrough()
const actorSchema = z.object({ id: z.string().uuid(), name: z.string().nullable() }).nullable()

export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'ITAD exception',
  methods: {
    GET: {
      summary: 'One exception with its history',
      description: 'History rows oldest first; `actor` is `null` for the system.',
      responses: [
        {
          status: 200,
          description: 'Exception',
          schema: exceptionItemSchema.extend({
            events: z.array(
              z.object({
                id: z.string().uuid(),
                kind: z.enum(ITAD_EXCEPTION_EVENT_KINDS),
                assignedTo: actorSchema,
                previousAssignedTo: actorSchema,
                outcome: z.enum(ITAD_EXCEPTION_OUTCOMES).nullable(),
                reason: z.string().nullable(),
                actor: actorSchema,
                createdAt: z.string(),
              }),
            ),
          }),
        },
      ],
      errors: [
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Missing itad.exceptions.view', schema: errorSchema },
        { status: 404, description: 'Job or exception not found in scope', schema: errorSchema },
      ],
    },
  },
}

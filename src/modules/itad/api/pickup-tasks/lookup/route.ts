import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { notFound } from '@open-mercato/shared/lib/crud/errors'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { itadRouteErrorResponse, resolveItadRouteContext } from '../../../lib/route-context'
import { findJobOfPickupTask } from '../../../services/pickup-task-reader'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['itad.jobs.view'] },
}

const lookupQuerySchema = z.object({ interactionId: z.string().uuid() })

/**
 * The ITAD job behind a calendar pickup task (pickup calendar spec, "Go to job" widget).
 * 404 for any interaction that is not a pickup task readable by the caller.
 */
export async function GET(request: Request) {
  try {
    const { interactionId } = lookupQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams))
    const route = await resolveItadRouteContext(request)
    const em = route.container.resolve<EntityManager>('em').fork()
    const job = await findJobOfPickupTask(em, route.tenantId, route.readableOrganizationIds, interactionId)
    if (!job) {
      const { translate } = await resolveTranslations()
      throw notFound(translate('itad.pickupTask.errors.notFound', 'This calendar entry is not an ITAD pickup'))
    }
    return NextResponse.json(job)
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.pickup-tasks.lookup')
  }
}

const errorSchema = z.object({ error: z.string(), code: z.string().optional() }).passthrough()

export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'ITAD pickup task lookup',
  methods: {
    GET: {
      summary: 'Job behind a calendar pickup task',
      description: 'Returns the ITAD job that owns the given `customers` interaction when it is a pickup task.',
      query: lookupQuerySchema,
      responses: [
        { status: 200, description: 'Job', schema: z.object({ jobId: z.string().uuid(), reference: z.string() }) },
      ],
      errors: [
        { status: 400, description: 'Invalid interaction id', schema: errorSchema },
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Missing itad.jobs.view', schema: errorSchema },
        { status: 404, description: 'Not a pickup task in scope', schema: errorSchema },
      ],
    },
  },
}

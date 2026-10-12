import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { PICKUP_TASK_LINK_STATES } from '../../../../../domain/pickup-task'
import {
  itadRouteErrorResponse,
  jobIdParamsSchema,
  loadReadableJob,
  resolveItadRouteContext,
} from '../../../../../lib/route-context'
import { loadPickupTaskSummary } from '../../../../../services/pickup-task-reader'
import { syncPickupTask } from '../../../../../services/pickup-task-sync'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['itad.jobs.manage'] },
}

/**
 * "Retry calendar sync" (pickup calendar spec REQ-508): runs the pickup task sync for one
 * job now. Idempotent; a failure is returned in `pickupTask.lastError`, not as an error.
 */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const { id } = jobIdParamsSchema.parse({ id: params?.id })
    const route = await resolveItadRouteContext(request)
    const job = await loadReadableJob(route, id)
    const scope = { tenantId: route.tenantId, organizationId: job.organizationId }
    const result = await syncPickupTask(route.container, scope, job.id, { causedByUserId: route.userId })
    const em = route.container.resolve<EntityManager>('em').fork()
    const summary = await loadPickupTaskSummary(em, scope, job.id)
    return NextResponse.json({ ok: result.error === null, pickupTask: summary.pickupTask, pickupTaskHistoryCount: summary.historyCount })
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.jobs.pickup-task.sync')
  }
}

const errorSchema = z.object({ error: z.string(), code: z.string().optional() }).passthrough()

const pickupTaskSchema = z
  .object({
    interactionId: z.string().uuid(),
    state: z.enum(PICKUP_TASK_LINK_STATES),
    scheduledAt: z.string(),
    lastError: z.string().nullable(),
    lastSyncedAt: z.string().nullable(),
  })
  .nullable()

export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'ITAD pickup task sync',
  methods: {
    POST: {
      summary: 'Retry the calendar sync of a job',
      description: 'Reconciles the job\'s pickup task in the platform calendar now and returns its state.',
      responses: [
        {
          status: 200,
          description: 'Sync ran; `ok` is false when it failed (see `pickupTask.lastError`)',
          schema: z.object({ ok: z.boolean(), pickupTask: pickupTaskSchema, pickupTaskHistoryCount: z.number().int() }),
        },
      ],
      errors: [
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Missing itad.jobs.manage', schema: errorSchema },
        { status: 404, description: 'Job not found', schema: errorSchema },
      ],
    },
  },
}

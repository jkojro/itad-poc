import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import {
  itadRouteErrorResponse,
  jobIdParamsSchema,
  loadReadableJob,
  resolveItadRouteContext,
} from '../../../../lib/route-context'
import { loadReconciliationSummary } from '../../../../services/reconciliation-reader'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['itad.jobs.view'] },
}

/**
 * Reconciliation counters of one job (manifest spec "Access rule by data kind"): part of
 * the job summary, so `itad.jobs.view` is enough — no per-device data is returned.
 */
export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    const { id } = jobIdParamsSchema.parse({ id: params?.id })
    const route = await resolveItadRouteContext(request)
    const job = await loadReadableJob(route, id)
    const em = route.container.resolve<EntityManager>('em').fork()
    const summary = await loadReconciliationSummary(em, { tenantId: route.tenantId, organizationId: job.organizationId }, job.id)
    return NextResponse.json(summary)
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.reconciliation.get')
  }
}

const errorSchema = z.object({ error: z.string(), code: z.string().optional() }).passthrough()

export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'ITAD job reconciliation',
  methods: {
    GET: {
      summary: 'Reconciliation counters of a job',
      description:
        'Derived at read time: expected (active manifest items), received (active assets), matched, missing, unexpected, pending duplicates and different-device duplicates.',
      responses: [
        {
          status: 200,
          description: 'Counters',
          schema: z.object({
            expectedAssetCount: z.number().int(),
            receivedAssetCount: z.number().int(),
            matched: z.number().int(),
            missing: z.number().int(),
            unexpected: z.number().int(),
            pendingDuplicates: z.number().int(),
            differentDeviceUnresolved: z.number().int(),
            dataBearingUndecided: z.number().int(),
            hasManifest: z.boolean(),
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

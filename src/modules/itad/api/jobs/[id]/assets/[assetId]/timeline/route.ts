import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { RbacService } from '@open-mercato/core/modules/auth/services/rbacService'
import { notFound } from '@open-mercato/shared/lib/crud/errors'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import { buildAssetTimeline } from '../../../../../../domain/asset-timeline'
import { ITAD_EXCEPTION_OUTCOMES, ITAD_EXCEPTION_TYPES } from '../../../../../../domain/exceptions'
import { itadRouteErrorResponse, loadReadableJob, resolveItadRouteContext } from '../../../../../../lib/route-context'
import { loadUserDisplayNames } from '../../../../../../module-integrations/users'
import { loadAssetDetail, loadTimelineSources } from '../../../../../../services/asset-detail-reader'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['itad.assets.view'] },
}

const paramsSchema = z.object({ id: z.string().uuid(), assetId: z.string().uuid() })

/**
 * Business timeline of one device (E4-053): assembled at read time from receiving,
 * classification, sanitization, exception and job records — never from the technical
 * audit log. Sanitization and exception entries need their own view features.
 */
export async function GET(request: Request, { params }: { params: { id: string; assetId: string } }) {
  try {
    const { id, assetId } = paramsSchema.parse({ id: params?.id, assetId: params?.assetId })
    const route = await resolveItadRouteContext(request)
    const job = await loadReadableJob(route, id)
    const scope = { tenantId: route.tenantId, organizationId: job.organizationId }
    const em = route.container.resolve<EntityManager>('em').fork()
    const asset = await loadAssetDetail(em, scope, job.id, assetId)
    if (!asset) {
      const { translate } = await resolveTranslations()
      throw notFound(translate('itad.assets.errors.asset_not_found', 'Asset not found'))
    }
    const rbac = route.container.resolve<RbacService>('rbacService')
    const can = (feature: string) => rbac.userHasAllFeatures(route.userId, [feature], scope)
    const visibility = { sanitization: await can('itad.sanitization.view'), exceptions: await can('itad.exceptions.view') }
    const entries = buildAssetTimeline(await loadTimelineSources(em, scope, job.id, asset), visibility)
    const names = await loadUserDisplayNames(
      route.container.resolve<QueryEngine>('queryEngine'),
      route.tenantId,
      entries.flatMap((entry) => [entry.actorUserId, entry.details.assignedToUserId ?? null]),
    )
    const actor = (userId: string | null | undefined) => (userId ? { id: userId, name: names.get(userId) ?? null } : null)
    return NextResponse.json({
      items: entries.map((entry) => ({
        at: entry.at,
        kind: entry.kind,
        category: entry.category,
        actor: actor(entry.actorUserId),
        details: { ...entry.details, assignedTo: actor(entry.details.assignedToUserId) },
      })),
    })
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.assets.timeline')
  }
}

const errorSchema = z.object({ error: z.string(), code: z.string().optional() }).passthrough()
const actorSchema = z.object({ id: z.string().uuid(), name: z.string().nullable() }).nullable()

export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'ITAD asset timeline',
  methods: {
    GET: {
      summary: 'Business timeline of one device',
      description:
        'Chronological business events (received, scanned again, data-bearing decided / changed, sanitization started / passed / failed / aborted, retry approved, exception opened / assigned / resolved, reconciled, job completed / cancelled). `actor` is `null` for the system. Sanitization entries need `itad.sanitization.view`, exception entries `itad.exceptions.view`. Reading never writes.',
      responses: [
        {
          status: 200,
          description: 'Timeline',
          schema: z.object({
            items: z.array(
              z.object({
                at: z.string(),
                kind: z.string(),
                category: z.enum(['receiving', 'data_bearing', 'sanitization', 'exception', 'job']),
                actor: actorSchema,
                details: z
                  .object({
                    exceptionType: z.enum(ITAD_EXCEPTION_TYPES).optional(),
                    outcome: z.enum(ITAD_EXCEPTION_OUTCOMES).nullable().optional(),
                    assignedTo: actorSchema.optional(),
                    reason: z.string().nullable().optional(),
                  })
                  .passthrough(),
              }),
            ),
          }),
        },
      ],
      errors: [
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Missing itad.assets.view', schema: errorSchema },
        { status: 404, description: 'Job or asset not found in scope', schema: errorSchema },
      ],
    },
  },
}

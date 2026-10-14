import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import { itadAssigneeSearchSchema } from '../../data/validators'
import { itadRouteErrorResponse, resolveItadRouteContext } from '../../lib/route-context'
import { listOrganizationUsers } from '../../module-integrations/users'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['itad.jobs.manage'] },
}

/** Active users of the selected organization who can coordinate a pickup (pickup calendar spec). */
export async function GET(request: Request) {
  try {
    const query = itadAssigneeSearchSchema.parse(Object.fromEntries(new URL(request.url).searchParams))
    const route = await resolveItadRouteContext(request)
    const organizationId = route.ctx.selectedOrganizationId ?? null
    if (!organizationId) return NextResponse.json({ items: [] })
    const items = await listOrganizationUsers(
      route.container.resolve<QueryEngine>('queryEngine'),
      { tenantId: route.tenantId, organizationId },
      { search: query.search, limit: 20 },
    )
    return NextResponse.json({ items })
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.pickup-coordinators')
  }
}

const errorSchema = z.object({ error: z.string(), code: z.string().optional() }).passthrough()

export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'ITAD pickup coordinators',
  methods: {
    GET: {
      summary: 'Users who can coordinate a pickup',
      description: 'Active users of the selected organization, at most 20; `search` matches name or email.',
      query: itadAssigneeSearchSchema,
      responses: [
        {
          status: 200,
          description: 'Users',
          schema: z.object({ items: z.array(z.object({ id: z.string().uuid(), name: z.string().nullable(), email: z.string().nullable() })) }),
        },
      ],
      errors: [
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Missing itad.jobs.manage', schema: errorSchema },
      ],
    },
  },
}

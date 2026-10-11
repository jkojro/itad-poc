import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { escapeLikePattern } from '@open-mercato/shared/lib/db/escapeLikePattern'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { itadSanitizationToolsSchema } from '../../../data/validators'
import { itadRouteErrorResponse, resolveItadRouteContext } from '../../../lib/route-context'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['itad.sanitization.view'] },
}

const LIMIT = 20

/**
 * Tool and version suggestions from earlier runs in the selected organization
 * (sanitization spec Q6), most used first.
 */
export async function GET(request: Request) {
  try {
    const query = itadSanitizationToolsSchema.parse(Object.fromEntries(new URL(request.url).searchParams))
    const route = await resolveItadRouteContext(request)
    const organizationId = route.ctx.selectedOrganizationId ?? null
    if (!organizationId) return NextResponse.json({ items: [] })
    const em = route.container.resolve<EntityManager>('em').fork()
    const where = ['"tenant_id" = ?', '"organization_id" = ?']
    const values: unknown[] = [route.tenantId, organizationId]
    if (query.search) {
      where.push('"tool" ilike ?')
      values.push(`%${escapeLikePattern(query.search)}%`)
    }
    const rows = await em.execute<Array<{ tool: string; tool_version: string; uses: string | number }>>(
      `select "tool", "tool_version", count(*) as "uses" from "itad_sanitization_runs"
       where ${where.join(' and ')}
       group by "tool", "tool_version"
       order by count(*) desc, "tool" asc, "tool_version" desc
       limit ?`,
      [...values, LIMIT],
    )
    return NextResponse.json({ items: rows.map((row) => ({ tool: row.tool, toolVersion: row.tool_version, uses: Number(row.uses) })) })
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.sanitization.tools')
  }
}

const errorSchema = z.object({ error: z.string(), code: z.string().optional() }).passthrough()

export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'ITAD sanitization tool suggestions',
  methods: {
    GET: {
      summary: 'Tools and versions used in earlier sanitization runs',
      description: 'Distinct tool + version pairs of the selected organization, most used first (at most 20). `search` matches the tool name.',
      query: itadSanitizationToolsSchema,
      responses: [
        {
          status: 200,
          description: 'Suggestions',
          schema: z.object({ items: z.array(z.object({ tool: z.string(), toolVersion: z.string(), uses: z.number().int() })) }),
        },
      ],
      errors: [
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Missing itad.sanitization.view', schema: errorSchema },
      ],
    },
  },
}

import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import { itadExceptionListSchema } from '../../../../data/validators'
import { ITAD_EXCEPTION_TYPES } from '../../../../domain/exceptions'
import { exceptionItemSchema } from '../../../../lib/exception-api-schemas'
import { itadRouteErrorResponse, jobIdParamsSchema, loadReadableJob, resolveItadRouteContext } from '../../../../lib/route-context'
import { EXCEPTION_SELECT, toExceptionItems, type ExceptionRow } from '../../../../services/exception-list'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['itad.exceptions.view'] },
}

/**
 * Exceptions of one job (exceptions spec E4-060, E4-061): OPEN first, then newest. Filters
 * by status, type, assignee (`me`, `unassigned`, user id) and asset; `counts` are the OPEN
 * exceptions by type.
 */
export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    const { id } = jobIdParamsSchema.parse({ id: params?.id })
    const query = itadExceptionListSchema.parse(Object.fromEntries(new URL(request.url).searchParams))
    const route = await resolveItadRouteContext(request)
    const job = await loadReadableJob(route, id)
    const em = route.container.resolve<EntityManager>('em').fork()

    const where = ['e."tenant_id" = ?', 'e."organization_id" = ?', 'e."job_id" = ?']
    const values: unknown[] = [route.tenantId, job.organizationId, job.id]
    if (query.status) {
      where.push('e."status" = ?')
      values.push(query.status)
    }
    if (query.type) {
      where.push('e."type" = ?')
      values.push(query.type)
    }
    if (query.assignedTo === 'unassigned') {
      where.push('e."assigned_to_user_id" is null')
    } else if (query.assignedTo) {
      where.push('e."assigned_to_user_id" = ?')
      values.push(query.assignedTo === 'me' ? route.userId : query.assignedTo)
    }
    if (query.assetId) {
      where.push('e."asset_id" = ?')
      values.push(query.assetId)
    }
    const whereSql = where.join(' and ')
    const rows = await em.execute<ExceptionRow[]>(
      `${EXCEPTION_SELECT} where ${whereSql}
       order by case when e."status" = 'open' then 0 else 1 end, e."created_at" desc, e."id" desc
       limit ? offset ?`,
      [...values, query.pageSize, (query.page - 1) * query.pageSize],
    )
    const totals = await em.execute<Array<{ total: string | number }>>(`select count(*) as "total" from "itad_exceptions" e where ${whereSql}`, values)
    const counts = await em.execute<Array<{ type: string; count: string | number }>>(
      `select "type", count(*) as "count" from "itad_exceptions"
       where "tenant_id" = ? and "organization_id" = ? and "job_id" = ? and "status" = 'open' group by "type"`,
      [route.tenantId, job.organizationId, job.id],
    )
    const items = await toExceptionItems(route.container.resolve<QueryEngine>('queryEngine'), route.tenantId, rows)
    return NextResponse.json({
      items,
      total: Number(totals[0]?.total ?? 0),
      page: query.page,
      pageSize: query.pageSize,
      openCounts: Object.fromEntries(ITAD_EXCEPTION_TYPES.map((type) => [type, Number(counts.find((row) => row.type === type)?.count ?? 0)])),
    })
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.exceptions.list')
  }
}

const errorSchema = z.object({ error: z.string(), code: z.string().optional() }).passthrough()
export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'ITAD exceptions of a job',
  methods: {
    GET: {
      summary: 'List the exceptions of a job',
      description:
        'OPEN exceptions first, then newest. `assignedTo` accepts `me`, `unassigned` or a user id. `openCounts` holds the OPEN exceptions by type.',
      query: itadExceptionListSchema,
      responses: [
        {
          status: 200,
          description: 'Exceptions',
          schema: z.object({
            items: z.array(exceptionItemSchema),
            total: z.number().int(),
            page: z.number().int(),
            pageSize: z.number().int(),
            openCounts: z.record(z.enum(ITAD_EXCEPTION_TYPES), z.number().int()),
          }),
        },
      ],
      errors: [
        { status: 400, description: 'Invalid query', schema: errorSchema },
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Missing itad.exceptions.view', schema: errorSchema },
        { status: 404, description: 'Job not found in scope', schema: errorSchema },
      ],
    },
  },
}

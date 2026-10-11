import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { escapeLikePattern } from '@open-mercato/shared/lib/db/escapeLikePattern'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import { itadSanitizationListSchema } from '../../../../data/validators'
import { ITAD_ASSET_STATUSES } from '../../../../domain/job-types'
import { ITAD_RUN_RESULTS, ITAD_SANITIZATION_METHODS } from '../../../../domain/sanitization-state-machine'
import { normalizeSerial } from '../../../../domain/serial'
import { itadRouteErrorResponse, jobIdParamsSchema, loadReadableJob, resolveItadRouteContext } from '../../../../lib/route-context'
import { loadUserDisplayNames } from '../../../../module-integrations/users'
import { loadSanitizationCounts } from '../../../../services/sanitization-reader'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['itad.sanitization.view'] },
}

type Row = {
  id: string
  serial: string
  manufacturer: string | null
  model: string | null
  status: string
  updated_at: Date | string
  runs_count: string | number
  run_id: string | null
  run_method: string | null
  run_tool: string | null
  run_tool_version: string | null
  run_result: string | null
  run_started_at: Date | string | null
  run_finished_at: Date | string | null
  run_operator_user_id: string | null
}

const iso = (value: Date | string | null) => (value ? new Date(value).toISOString() : null)

/**
 * Data-bearing assets of a job with their latest run (sanitization spec "Sanitization
 * tab"). `status` filters by asset status; `search` matches serial, manufacturer, model.
 */
export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    const { id } = jobIdParamsSchema.parse({ id: params?.id })
    const query = itadSanitizationListSchema.parse(Object.fromEntries(new URL(request.url).searchParams))
    const route = await resolveItadRouteContext(request)
    const job = await loadReadableJob(route, id)
    const em = route.container.resolve<EntityManager>('em').fork()
    const scope = { tenantId: route.tenantId, organizationId: job.organizationId }

    const where = ['a."tenant_id" = ?', 'a."organization_id" = ?', 'a."job_id" = ?', 'a."deleted_at" is null', 'a."data_bearing" = true']
    const values: unknown[] = [scope.tenantId, scope.organizationId, job.id]
    if (query.status) {
      where.push('a."status" = ?')
      values.push(query.status)
    }
    if (query.search) {
      const text = `%${escapeLikePattern(query.search)}%`
      where.push('(a."serial_normalized" like ? or a."manufacturer" ilike ? or a."model" ilike ?)')
      values.push(`%${escapeLikePattern(normalizeSerial(query.search))}%`, text, text)
    }
    const whereSql = where.join(' and ')
    const [rows, totals, counts] = await Promise.all([
      em.execute<Row[]>(
        `select a."id", a."serial", a."manufacturer", a."model", a."status", a."updated_at",
                (select count(*) from "itad_sanitization_runs" c where c."asset_id" = a."id" and c."tenant_id" = a."tenant_id") as "runs_count",
                r."id" as "run_id", r."method" as "run_method", r."tool" as "run_tool", r."tool_version" as "run_tool_version",
                r."result" as "run_result", r."started_at" as "run_started_at", r."finished_at" as "run_finished_at",
                r."operator_user_id" as "run_operator_user_id"
         from "itad_assets" a
         left join lateral (
           select * from "itad_sanitization_runs" s
           where s."asset_id" = a."id" and s."tenant_id" = a."tenant_id" and s."organization_id" = a."organization_id"
           order by s."started_at" desc, s."id" desc limit 1
         ) r on true
         where ${whereSql}
         order by a."serial_normalized" asc, a."id" asc
         limit ? offset ?`,
        [...values, query.pageSize, (query.page - 1) * query.pageSize],
      ),
      em.execute<Array<{ total: string | number }>>(`select count(*) as "total" from "itad_assets" a where ${whereSql}`, values),
      loadSanitizationCounts(em, scope, job.id),
    ])
    const names = await loadUserDisplayNames(
      route.container.resolve<QueryEngine>('queryEngine'),
      route.tenantId,
      rows.flatMap((row) => (row.run_operator_user_id ? [row.run_operator_user_id] : [])),
    )

    return NextResponse.json({
      items: rows.map((row) => ({
        id: row.id,
        serial: row.serial,
        manufacturer: row.manufacturer,
        model: row.model,
        status: row.status,
        updatedAt: new Date(row.updated_at).toISOString(),
        runsCount: Number(row.runs_count),
        lastRun: row.run_id
          ? {
              id: row.run_id,
              method: row.run_method,
              tool: row.run_tool,
              toolVersion: row.run_tool_version,
              result: row.run_result,
              startedAt: iso(row.run_started_at),
              finishedAt: iso(row.run_finished_at),
              operator: { id: row.run_operator_user_id, name: row.run_operator_user_id ? names.get(row.run_operator_user_id) ?? null : null },
            }
          : null,
      })),
      total: Number(totals[0]?.total ?? 0),
      page: query.page,
      pageSize: query.pageSize,
      counts,
      jobStatus: job.status,
    })
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.sanitization.list')
  }
}

const errorSchema = z.object({ error: z.string(), code: z.string().optional() }).passthrough()

export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'ITAD sanitization of a job',
  methods: {
    GET: {
      summary: 'List the data-bearing assets of a job with their latest sanitization run',
      description:
        'Active assets with `dataBearing = true`, ordered by serial, each with its latest run and run count, plus counters by status.',
      query: itadSanitizationListSchema,
      responses: [
        {
          status: 200,
          description: 'Data-bearing assets',
          schema: z.object({
            items: z.array(
              z.object({
                id: z.string().uuid(),
                serial: z.string(),
                manufacturer: z.string().nullable(),
                model: z.string().nullable(),
                status: z.enum(ITAD_ASSET_STATUSES),
                updatedAt: z.string(),
                runsCount: z.number().int(),
                lastRun: z
                  .object({
                    id: z.string().uuid(),
                    method: z.enum(ITAD_SANITIZATION_METHODS),
                    tool: z.string(),
                    toolVersion: z.string(),
                    result: z.enum(ITAD_RUN_RESULTS).nullable(),
                    startedAt: z.string(),
                    finishedAt: z.string().nullable(),
                    operator: z.object({ id: z.string().uuid(), name: z.string().nullable() }),
                  })
                  .nullable(),
              }),
            ),
            total: z.number().int(),
            page: z.number().int(),
            pageSize: z.number().int(),
            counts: z.object({ required: z.number(), inProgress: z.number(), sanitized: z.number(), reviewRequired: z.number() }),
            jobStatus: z.string(),
          }),
        },
      ],
      errors: [
        { status: 400, description: 'Invalid query', schema: errorSchema },
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Missing itad.sanitization.view', schema: errorSchema },
        { status: 404, description: 'Job not found in scope', schema: errorSchema },
      ],
    },
  },
}

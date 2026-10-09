import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { escapeLikePattern } from '@open-mercato/shared/lib/db/escapeLikePattern'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import { itadAssetListSchema } from '../../../../data/validators'
import { ITAD_ASSET_STATUSES } from '../../../../domain/job-types'
import { normalizeSerial } from '../../../../domain/serial'
import {
  itadRouteErrorResponse,
  jobIdParamsSchema,
  loadReadableJob,
  resolveItadRouteContext,
} from '../../../../lib/route-context'
import { loadUserDisplayNames } from '../../../../module-integrations/users'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['itad.assets.view'] },
}

type AssetRow = {
  id: string
  serial: string
  customer_asset_tag: string | null
  manufacturer: string | null
  model: string | null
  data_bearing: boolean | null
  status: string
  received_at: Date | string
  received_by_user_id: string
  updated_at: Date | string
  manifest_item_id: string | null
}

/**
 * Active assets of one job, newest first. `manifestItemId` links to the active manifest
 * item with the same serial (read-time match); source data is never embedded — it is
 * read from the manifest items route, which requires `itad.manifest.view`.
 */
export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    const { id } = jobIdParamsSchema.parse({ id: params?.id })
    const query = itadAssetListSchema.parse(Object.fromEntries(new URL(request.url).searchParams))
    const route = await resolveItadRouteContext(request)
    const job = await loadReadableJob(route, id)
    const em = route.container.resolve<EntityManager>('em').fork()

    const where: string[] = ['a."tenant_id" = ?', 'a."organization_id" = ?', 'a."job_id" = ?', 'a."deleted_at" is null']
    const values: unknown[] = [route.tenantId, job.organizationId, job.id]
    if (query.id) {
      where.push('a."id" = ?')
      values.push(query.id)
    }
    if (query.search) {
      const text = `%${escapeLikePattern(query.search)}%`
      where.push(`(a."serial_normalized" like ? or a."customer_asset_tag" ilike ? or a."manufacturer" ilike ? or a."model" ilike ?)`)
      values.push(`%${escapeLikePattern(normalizeSerial(query.search))}%`, text, text, text)
    }
    const whereSql = where.join(' and ')
    const [rows, totals] = await Promise.all([
      em.execute<AssetRow[]>(
        `select a."id", a."serial", a."customer_asset_tag", a."manufacturer", a."model", a."data_bearing", a."status",
                a."received_at", a."received_by_user_id", a."updated_at", m."id" as "manifest_item_id"
         from "itad_assets" a
         left join "itad_manifest_items" m
           on m."tenant_id" = a."tenant_id" and m."organization_id" = a."organization_id" and m."job_id" = a."job_id"
          and m."serial_normalized" = a."serial_normalized" and m."deleted_at" is null
         where ${whereSql}
         order by a."received_at" desc, a."id" desc
         limit ? offset ?`,
        [...values, query.pageSize, (query.page - 1) * query.pageSize],
      ),
      em.execute<Array<{ total: string | number }>>(`select count(*) as "total" from "itad_assets" a where ${whereSql}`, values),
    ])
    const names = await loadUserDisplayNames(
      route.container.resolve<QueryEngine>('queryEngine'),
      route.tenantId,
      rows.map((row) => row.received_by_user_id),
    )

    return NextResponse.json({
      items: rows.map((row) => ({
        id: row.id,
        serial: row.serial,
        customerAssetTag: row.customer_asset_tag,
        manufacturer: row.manufacturer,
        model: row.model,
        dataBearing: row.data_bearing,
        status: row.status,
        manifestItemId: row.manifest_item_id,
        receivedAt: new Date(row.received_at).toISOString(),
        receivedBy: { id: row.received_by_user_id, name: names.get(row.received_by_user_id) ?? null },
        updatedAt: new Date(row.updated_at).toISOString(),
      })),
      total: Number(totals[0]?.total ?? 0),
      page: query.page,
      pageSize: query.pageSize,
    })
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.assets.get')
  }
}

const errorSchema = z.object({ error: z.string(), code: z.string().optional() }).passthrough()

export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'ITAD assets of a job',
  methods: {
    GET: {
      summary: 'List the received assets of a job',
      description:
        'Active assets, newest first. `search` matches serials (normalized), customer tags, manufacturers and models within this job. Never includes manifest source data.',
      query: itadAssetListSchema,
      responses: [
        {
          status: 200,
          description: 'Assets',
          schema: z.object({
            items: z.array(
              z.object({
                id: z.string().uuid(),
                serial: z.string(),
                customerAssetTag: z.string().nullable(),
                manufacturer: z.string().nullable(),
                model: z.string().nullable(),
                dataBearing: z.boolean().nullable(),
                status: z.enum(ITAD_ASSET_STATUSES),
                manifestItemId: z.string().uuid().nullable(),
                receivedAt: z.string(),
                receivedBy: z.object({ id: z.string().uuid(), name: z.string().nullable() }),
                updatedAt: z.string(),
              }),
            ),
            total: z.number().int(),
            page: z.number().int(),
            pageSize: z.number().int(),
          }),
        },
      ],
      errors: [
        { status: 400, description: 'Invalid query', schema: errorSchema },
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Missing itad.assets.view', schema: errorSchema },
        { status: 404, description: 'Job not found in scope', schema: errorSchema },
      ],
    },
  },
}

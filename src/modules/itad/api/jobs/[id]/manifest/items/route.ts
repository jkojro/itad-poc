import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { escapeLikePattern } from '@open-mercato/shared/lib/db/escapeLikePattern'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { itadManifestItemListSchema } from '../../../../../data/validators'
import { MANIFEST_ITEM_RECONCILIATION, classifyManifestItem } from '../../../../../domain/reconciliation'
import { normalizeSerial } from '../../../../../domain/serial'
import {
  itadRouteErrorResponse,
  jobIdParamsSchema,
  loadReadableJob,
  resolveItadRouteContext,
} from '../../../../../lib/route-context'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['itad.manifest.view'] },
}

type ItemRow = {
  id: string
  serial: string
  customer_asset_tag: string | null
  manufacturer: string | null
  model: string | null
  data_bearing: boolean | null
  source_row: number
  source_data: Array<{ column: string; value: string }>
  import_id: string
  import_file_name: string
  created_at: Date | string
  asset_id: string | null
}

/** Active asset of the same job with the same normalized serial (reconciliation match). */
const MATCHING_ASSET = `select a."id" from "itad_assets" a
  where a."tenant_id" = i."tenant_id" and a."organization_id" = i."organization_id" and a."job_id" = i."job_id"
    and a."serial_normalized" = i."serial_normalized" and a."deleted_at" is null limit 1`

/**
 * Active manifest items of one job in import and file order. `search` matches the
 * normalized serial, mapped fields and any source data value — within this job only.
 */
export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    const { id } = jobIdParamsSchema.parse({ id: params?.id })
    const query = itadManifestItemListSchema.parse(Object.fromEntries(new URL(request.url).searchParams))
    const route = await resolveItadRouteContext(request)
    const job = await loadReadableJob(route, id)
    const em = route.container.resolve<EntityManager>('em').fork()

    const where: string[] = ['i."tenant_id" = ?', 'i."organization_id" = ?', 'i."job_id" = ?', 'i."deleted_at" is null']
    const values: unknown[] = [route.tenantId, job.organizationId, job.id]
    if (query.id) {
      where.push('i."id" = ?')
      values.push(query.id)
    }
    if (query.reconciliation) {
      where.push(query.reconciliation === 'matched' ? `exists (${MATCHING_ASSET})` : `not exists (${MATCHING_ASSET})`)
    }
    if (query.search) {
      const text = `%${escapeLikePattern(query.search)}%`
      const serial = `%${escapeLikePattern(normalizeSerial(query.search))}%`
      where.push(`(
        i."serial_normalized" like ?
        or i."customer_asset_tag" ilike ?
        or i."manufacturer" ilike ?
        or i."model" ilike ?
        or exists (select 1 from jsonb_array_elements(i."source_data") as e where e->>'value' ilike ?)
      )`)
      values.push(serial, text, text, text, text)
    }
    const whereSql = where.join(' and ')
    const offset = (query.page - 1) * query.pageSize
    const [rows, totals] = await Promise.all([
      em.execute<ItemRow[]>(
        `select i."id", i."serial", i."customer_asset_tag", i."manufacturer", i."model", i."data_bearing", i."source_row",
                i."source_data", i."import_id", m."file_name" as "import_file_name", i."created_at",
                (${MATCHING_ASSET}) as "asset_id"
         from "itad_manifest_items" i
         join "itad_manifest_imports" m on m."id" = i."import_id"
         where ${whereSql}
         order by i."created_at" asc, i."source_row" asc, i."id" asc
         limit ? offset ?`,
        [...values, query.pageSize, offset],
      ),
      em.execute<Array<{ total: string | number }>>(
        `select count(*) as "total" from "itad_manifest_items" i where ${whereSql}`,
        values,
      ),
    ])

    return NextResponse.json({
      items: rows.map((row) => ({
        id: row.id,
        serial: row.serial,
        customerAssetTag: row.customer_asset_tag,
        manufacturer: row.manufacturer,
        model: row.model,
        dataBearing: row.data_bearing,
        sourceRow: Number(row.source_row),
        sourceData: row.source_data,
        importId: row.import_id,
        importFileName: row.import_file_name,
        createdAt: new Date(row.created_at).toISOString(),
        reconciliation: classifyManifestItem(Boolean(row.asset_id)),
        assetId: row.asset_id,
      })),
      total: Number(totals[0]?.total ?? 0),
      page: query.page,
      pageSize: query.pageSize,
    })
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.manifest.items.get')
  }
}

const itemsResponseSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().uuid(),
      serial: z.string(),
      customerAssetTag: z.string().nullable(),
      manufacturer: z.string().nullable(),
      model: z.string().nullable(),
      dataBearing: z.boolean().nullable(),
      sourceRow: z.number().int(),
      sourceData: z.array(z.object({ column: z.string(), value: z.string() })),
      importId: z.string().uuid(),
      importFileName: z.string(),
      createdAt: z.string(),
      reconciliation: z.enum(MANIFEST_ITEM_RECONCILIATION),
      assetId: z.string().uuid().nullable(),
    }),
  ),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
})

const errorSchema = z.object({ error: z.string(), code: z.string().optional() }).passthrough()

export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'ITAD manifest items',
  methods: {
    GET: {
      summary: 'List the manifest items of a job',
      description:
        'Active items with their full source row (`sourceData`, parsed logical values). `search` matches serials, mapped fields and source data values within this job.',
      query: itadManifestItemListSchema,
      responses: [{ status: 200, description: 'Manifest items', schema: itemsResponseSchema }],
      errors: [
        { status: 400, description: 'Invalid query', schema: errorSchema },
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Missing itad.manifest.view', schema: errorSchema },
        { status: 404, description: 'Job not found in scope', schema: errorSchema },
      ],
    },
  },
}

import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { escapeLikePattern } from '@open-mercato/shared/lib/db/escapeLikePattern'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import { itadAssetLookupSchema } from '../../data/validators'
import { ITAD_ASSET_STATUSES, ITAD_JOB_STATUSES } from '../../domain/job-types'
import { normalizeSerial } from '../../domain/serial'
import { assetError } from '../../lib/asset-errors'
import { itadRouteErrorResponse, resolveItadRouteContext } from '../../lib/route-context'
import { loadCompanyNames } from '../../module-integrations/customers'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['itad.assets.view'] },
}

export const SERIAL_LOOKUP_MIN_LENGTH = 3

type LookupRow = {
  id: string
  serial: string
  status: string
  received_at: Date | string
  organization_id: string
  job_id: string
  job_reference: string
  job_status: string
  customer_id: string
}

/**
 * Finds received assets by serial across the jobs the caller can read (manifest spec
 * REQ-107): exact or prefix match on the normalized serial, at least 3 characters.
 * Exact matches come first. Never returns manifest source data.
 */
export async function GET(request: Request) {
  try {
    const query = itadAssetLookupSchema.parse(Object.fromEntries(new URL(request.url).searchParams))
    const serial = normalizeSerial(query.serial)
    if (serial.length < SERIAL_LOOKUP_MIN_LENGTH) return await assetError(400, 'serial_too_short')
    const route = await resolveItadRouteContext(request)
    const em = route.container.resolve<EntityManager>('em').fork()

    const where: string[] = ['a."tenant_id" = ?', 'a."deleted_at" is null', 'j."deleted_at" is null', 'a."serial_normalized" like ?']
    const values: unknown[] = [route.tenantId, `${escapeLikePattern(serial)}%`]
    if (route.readableOrganizationIds !== null) {
      if (route.readableOrganizationIds.length === 0) return NextResponse.json({ items: [], total: 0, page: query.page, pageSize: query.pageSize })
      where.push(`a."organization_id" in (${route.readableOrganizationIds.map(() => '?').join(', ')})`)
      values.push(...route.readableOrganizationIds)
    }
    const whereSql = where.join(' and ')
    const from = `from "itad_assets" a join "itad_jobs" j on j."id" = a."job_id" and j."tenant_id" = a."tenant_id" and j."organization_id" = a."organization_id"`
    const [rows, totals] = await Promise.all([
      em.execute<LookupRow[]>(
        `select a."id", a."serial", a."status", a."received_at", a."organization_id", a."job_id",
                j."internal_reference" as "job_reference", j."status" as "job_status", j."customer_id"
         ${from}
         where ${whereSql}
         order by (a."serial_normalized" = ?) desc, a."serial_normalized" asc, a."received_at" desc
         limit ? offset ?`,
        [...values, serial, query.pageSize, (query.page - 1) * query.pageSize],
      ),
      em.execute<Array<{ total: string | number }>>(`select count(*) as "total" ${from} where ${whereSql}`, values),
    ])

    const queryEngine = route.container.resolve<QueryEngine>('queryEngine')
    const names = new Map<string, string>()
    const byOrganization = new Map<string, string[]>()
    for (const row of rows) byOrganization.set(row.organization_id, [...(byOrganization.get(row.organization_id) ?? []), row.customer_id])
    for (const [organizationId, customerIds] of byOrganization) {
      const found = await loadCompanyNames(queryEngine, { tenantId: route.tenantId, organizationId }, customerIds)
      for (const [customerId, name] of found) names.set(`${organizationId}:${customerId}`, name)
    }

    return NextResponse.json({
      items: rows.map((row) => ({
        id: row.id,
        serial: row.serial,
        status: row.status,
        exactMatch: normalizeSerial(row.serial) === serial,
        receivedAt: new Date(row.received_at).toISOString(),
        jobId: row.job_id,
        jobReference: row.job_reference,
        jobStatus: row.job_status,
        customerName: names.get(`${row.organization_id}:${row.customer_id}`) ?? null,
      })),
      total: Number(totals[0]?.total ?? 0),
      page: query.page,
      pageSize: query.pageSize,
    })
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.assets.lookup')
  }
}

const errorSchema = z.object({ error: z.string(), code: z.string().optional() }).passthrough()

export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'ITAD asset lookup',
  methods: {
    GET: {
      summary: 'Find received assets by serial across jobs',
      description:
        'Exact or prefix match on the normalized serial (at least 3 characters) across the jobs the caller can read; exact matches first. Substring search is available per job.',
      query: itadAssetLookupSchema,
      responses: [
        {
          status: 200,
          description: 'Matching assets',
          schema: z.object({
            items: z.array(
              z.object({
                id: z.string().uuid(),
                serial: z.string(),
                status: z.enum(ITAD_ASSET_STATUSES),
                exactMatch: z.boolean(),
                receivedAt: z.string(),
                jobId: z.string().uuid(),
                jobReference: z.string(),
                jobStatus: z.enum(ITAD_JOB_STATUSES),
                customerName: z.string().nullable(),
              }),
            ),
            total: z.number().int(),
            page: z.number().int(),
            pageSize: z.number().int(),
          }),
        },
      ],
      errors: [
        { status: 400, description: 'Serial shorter than 3 characters (`serial_too_short`)', schema: errorSchema },
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Missing itad.assets.view', schema: errorSchema },
      ],
    },
  },
}

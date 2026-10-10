import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import type { ItadAssetScanResult } from '../../../../commands/assets'
import { itadScanListSchema, type ItadAssetScanInput } from '../../../../data/validators'
import { ITAD_DATA_BEARING_SOURCES } from '../../../../domain/data-bearing'
import { ITAD_ASSET_STATUSES, ITAD_SCAN_RESULTS } from '../../../../domain/job-types'
import { runGuardedCommand } from '../../../../lib/command-route'
import {
  itadRouteErrorResponse,
  jobIdParamsSchema,
  loadReadableJob,
  resolveItadRouteContext,
} from '../../../../lib/route-context'
import { loadUserDisplayNames } from '../../../../module-integrations/users'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['itad.assets.view'] },
  POST: { requireAuth: true, requireFeatures: ['itad.assets.receive'] },
}

type ScanRow = {
  id: string
  raw_serial: string
  result: string
  scanned_at: Date | string
  scanned_by_user_id: string
  asset_id: string
  asset_serial: string
  asset_deleted_at: Date | string | null
  manifest_item_id: string | null
  resolution: string | null
  resolution_note: string | null
  resolved_at: Date | string | null
  resolved_by_user_id: string | null
  flagged_different_device_at: Date | string | null
  flagged_different_device_by_user_id: string | null
  flagged_different_device_note: string | null
}

const iso = (value: Date | string | null) => (value ? new Date(value).toISOString() : null)

/** Receiving scan log of one job, newest first; `pending=true` lists unresolved duplicates. */
export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    const { id } = jobIdParamsSchema.parse({ id: params?.id })
    const query = itadScanListSchema.parse(Object.fromEntries(new URL(request.url).searchParams))
    const route = await resolveItadRouteContext(request)
    const job = await loadReadableJob(route, id)
    const em = route.container.resolve<EntityManager>('em').fork()

    const where: string[] = ['s."tenant_id" = ?', 's."organization_id" = ?', 's."job_id" = ?']
    const values: unknown[] = [route.tenantId, job.organizationId, job.id]
    if (query.result) {
      where.push('s."result" = ?')
      values.push(query.result)
    }
    if (query.pending === 'true') where.push(`s."result" = 'duplicate' and s."resolved_at" is null`)
    const whereSql = where.join(' and ')
    const [rows, totals] = await Promise.all([
      em.execute<ScanRow[]>(
        `select s."id", s."raw_serial", s."result", s."scanned_at", s."scanned_by_user_id", s."asset_id",
                a."serial" as "asset_serial", a."deleted_at" as "asset_deleted_at", s."manifest_item_id",
                s."resolution", s."resolution_note", s."resolved_at", s."resolved_by_user_id",
                s."flagged_different_device_at", s."flagged_different_device_by_user_id", s."flagged_different_device_note"
         from "itad_intake_scans" s
         join "itad_assets" a on a."id" = s."asset_id"
         where ${whereSql}
         order by s."scanned_at" desc, s."id" desc
         limit ? offset ?`,
        [...values, query.pageSize, (query.page - 1) * query.pageSize],
      ),
      em.execute<Array<{ total: string | number }>>(`select count(*) as "total" from "itad_intake_scans" s where ${whereSql}`, values),
    ])
    const names = await loadUserDisplayNames(
      route.container.resolve<QueryEngine>('queryEngine'),
      route.tenantId,
      rows.flatMap((row) => [row.scanned_by_user_id, row.resolved_by_user_id, row.flagged_different_device_by_user_id]),
    )
    const actor = (userId: string | null) => (userId ? { id: userId, name: names.get(userId) ?? null } : null)

    return NextResponse.json({
      items: rows.map((row) => ({
        id: row.id,
        rawSerial: row.raw_serial,
        result: row.result,
        scannedAt: iso(row.scanned_at),
        scannedBy: actor(row.scanned_by_user_id),
        asset: { id: row.asset_id, serial: row.asset_serial, deleted: Boolean(row.asset_deleted_at) },
        manifestItemId: row.manifest_item_id,
        pending: row.result === 'duplicate' && !row.resolved_at,
        resolution: row.resolution,
        resolutionNote: row.resolution_note,
        resolvedAt: iso(row.resolved_at),
        resolvedBy: actor(row.resolved_by_user_id),
        flaggedDifferentDeviceAt: iso(row.flagged_different_device_at),
        flaggedDifferentDeviceBy: actor(row.flagged_different_device_by_user_id),
        flaggedDifferentDeviceNote: row.flagged_different_device_note,
      })),
      total: Number(totals[0]?.total ?? 0),
      page: query.page,
      pageSize: query.pageSize,
    })
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.scans.get')
  }
}

const scanBodySchema = z.object({ serial: z.string().max(500) })

/** One receiving scan through `itad.assets.scan`; 201 for every accepted scan (each is logged). */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const { id } = jobIdParamsSchema.parse({ id: params?.id })
    const route = await resolveItadRouteContext(request)
    await loadReadableJob(route, id)
    const body = scanBodySchema.parse((await readJsonSafe<Record<string, unknown>>(request, {})) ?? {})
    const outcome = await runGuardedCommand<ItadAssetScanInput, ItadAssetScanResult>(route, request, {
      commandId: 'itad.assets.scan',
      input: { jobId: id, serial: body.serial },
      resourceKind: 'itad.intake_scan',
      resourceId: id,
      operation: 'create',
    })
    if (!outcome.ok) return outcome.response
    const { result } = outcome
    return NextResponse.json(
      {
        result: result.result.toUpperCase(),
        scan: result.scan,
        asset: result.asset,
        manifestItem: result.manifestItem,
      },
      { status: 201 },
    )
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.scans.post')
  }
}

const actorSchema = z.object({ id: z.string().uuid(), name: z.string().nullable() }).nullable()
const errorSchema = z.object({ error: z.string(), code: z.string().optional() }).passthrough()

export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'ITAD receiving scans',
  methods: {
    GET: {
      summary: 'List the receiving scans of a job',
      description: 'Scan log, newest first. `pending=true` returns unresolved duplicate scans (including ones flagged as a different device).',
      query: itadScanListSchema,
      responses: [
        {
          status: 200,
          description: 'Scans',
          schema: z.object({
            items: z.array(
              z.object({
                id: z.string().uuid(),
                rawSerial: z.string(),
                result: z.enum(ITAD_SCAN_RESULTS),
                scannedAt: z.string(),
                scannedBy: actorSchema,
                asset: z.object({ id: z.string().uuid(), serial: z.string(), deleted: z.boolean() }),
                manifestItemId: z.string().uuid().nullable(),
                pending: z.boolean(),
                resolution: z.string().nullable(),
                resolutionNote: z.string().nullable(),
                resolvedAt: z.string().nullable(),
                resolvedBy: actorSchema,
                flaggedDifferentDeviceAt: z.string().nullable(),
                flaggedDifferentDeviceBy: actorSchema,
                flaggedDifferentDeviceNote: z.string().nullable(),
              }),
            ),
            total: z.number().int(),
            page: z.number().int(),
            pageSize: z.number().int(),
          }),
        },
      ],
      errors: [
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Missing itad.assets.view', schema: errorSchema },
        { status: 404, description: 'Job not found in scope', schema: errorSchema },
      ],
    },
    POST: {
      summary: 'Scan a serial at receiving',
      description:
        'Creates the asset on the first scan of a serial (MATCHED against the manifest or UNEXPECTED); a repeated serial creates no asset and records a pending DUPLICATE scan.',
      requestBody: { contentType: 'application/json', schema: scanBodySchema },
      responses: [
        {
          status: 201,
          description: 'Scan recorded',
          schema: z.object({
            result: z.enum(['MATCHED', 'UNEXPECTED', 'DUPLICATE']),
            scan: z.object({ id: z.string().uuid(), rawSerial: z.string(), scannedAt: z.string() }),
            asset: z.object({
              id: z.string().uuid(),
              serial: z.string(),
              customerAssetTag: z.string().nullable(),
              manufacturer: z.string().nullable(),
              model: z.string().nullable(),
              dataBearing: z.boolean().nullable(),
              dataBearingSource: z.enum(ITAD_DATA_BEARING_SOURCES).nullable(),
              status: z.enum(ITAD_ASSET_STATUSES),
              deleted: z.boolean(),
            }),
            manifestItem: z.object({ id: z.string().uuid(), serial: z.string() }).nullable(),
          }),
        },
      ],
      errors: [
        { status: 400, description: 'Serial missing or too long', schema: errorSchema },
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Missing itad.assets.receive', schema: errorSchema },
        { status: 404, description: 'Job not found in scope', schema: errorSchema },
        { status: 409, description: 'Job not in receiving, or a concurrent scan of the same serial', schema: errorSchema },
      ],
    },
  },
}

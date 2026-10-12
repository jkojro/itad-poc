import { NextResponse } from 'next/server'
import { z } from 'zod'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { ItadAssetChangeResult } from '../../../../../commands/assets'
import type { ItadAssetDeleteInput, ItadAssetUpdateInput } from '../../../../../data/validators'
import { runGuardedCommand } from '../../../../../lib/command-route'
import type { EntityManager } from '@mikro-orm/postgresql'
import { notFound } from '@open-mercato/shared/lib/crud/errors'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import { ITAD_DATA_BEARING_SOURCES } from '../../../../../domain/data-bearing'
import { ITAD_ASSET_STATUSES, ITAD_JOB_STATUSES } from '../../../../../domain/job-types'
import { classifyAsset, ASSET_RECONCILIATION } from '../../../../../domain/reconciliation'
import { itadRouteErrorResponse, loadReadableJob, resolveItadRouteContext } from '../../../../../lib/route-context'
import { loadUserDisplayNames } from '../../../../../module-integrations/users'
import { loadAssetDetail } from '../../../../../services/asset-detail-reader'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['itad.assets.view'] },
  PUT: { requireAuth: true, requireFeatures: ['itad.assets.receive'] },
  DELETE: { requireAuth: true, requireFeatures: ['itad.assets.manage'] },
}

const paramsSchema = z.object({ id: z.string().uuid(), assetId: z.string().uuid() })
const updateBodySchema = z
  .object({
    customerAssetTag: z.string().max(200).nullable().optional(),
    manufacturer: z.string().max(200).nullable().optional(),
    model: z.string().max(200).nullable().optional(),
    dataBearing: z.boolean().nullable().optional(),
  })
  .passthrough()
const deleteBodySchema = z.object({ reason: z.string().max(1000).nullable().optional() })

/** Asset detail (exceptions spec "Asset detail"): the device, its job and reconciliation, open exceptions. */
export async function GET(request: Request, { params }: { params: { id: string; assetId: string } }) {
  try {
    const { id, assetId } = paramsSchema.parse({ id: params?.id, assetId: params?.assetId })
    const route = await resolveItadRouteContext(request)
    const job = await loadReadableJob(route, id)
    const em = route.container.resolve<EntityManager>('em').fork()
    const row = await loadAssetDetail(em, { tenantId: route.tenantId, organizationId: job.organizationId }, job.id, assetId)
    if (!row) {
      const { translate } = await resolveTranslations()
      throw notFound(translate('itad.assets.errors.asset_not_found', 'Asset not found'))
    }
    const names = await loadUserDisplayNames(route.container.resolve<QueryEngine>('queryEngine'), route.tenantId, [row.received_by_user_id])
    return NextResponse.json({
      id: row.id,
      serial: row.serial,
      customerAssetTag: row.customer_asset_tag,
      manufacturer: row.manufacturer,
      model: row.model,
      dataBearing: row.data_bearing,
      dataBearingSource: row.data_bearing_source,
      status: row.status,
      reconciliation: classifyAsset(Boolean(row.manifest_item_id)),
      receivedAt: new Date(row.received_at).toISOString(),
      receivedBy: { id: row.received_by_user_id, name: names.get(row.received_by_user_id) ?? null },
      deleted: Boolean(row.deleted_at),
      openExceptionCount: Number(row.open_exceptions),
      updatedAt: new Date(row.updated_at).toISOString(),
      job: { id: job.id, internalReference: job.internalReference, name: job.name, status: job.status },
    })
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.assets.detail')
  }
}

/** Edits an asset's details (`itad.assets.update`); send the expected `updatedAt` in the lock header. */
export async function PUT(request: Request, { params }: { params: { id: string; assetId: string } }) {
  try {
    const { id, assetId } = paramsSchema.parse({ id: params?.id, assetId: params?.assetId })
    const route = await resolveItadRouteContext(request)
    await loadReadableJob(route, id)
    const body = updateBodySchema.parse((await readJsonSafe<Record<string, unknown>>(request, {})) ?? {})
    // Passthrough on purpose: the command rejects serial/status with `field_not_writable`.
    const input = { ...body, jobId: id, assetId } as ItadAssetUpdateInput
    const outcome = await runGuardedCommand<ItadAssetUpdateInput, ItadAssetChangeResult>(route, request, {
      commandId: 'itad.assets.update',
      input,
      resourceKind: 'itad.asset',
      resourceId: assetId,
      operation: 'update',
    })
    if (!outcome.ok) return outcome.response
    return NextResponse.json({ updatedAt: outcome.result.updatedAt })
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.assets.put')
  }
}

/** Voids a wrongly scanned asset (`itad.assets.delete`); reason required; lock header expected. */
export async function DELETE(request: Request, { params }: { params: { id: string; assetId: string } }) {
  try {
    const { id, assetId } = paramsSchema.parse({ id: params?.id, assetId: params?.assetId })
    const route = await resolveItadRouteContext(request)
    await loadReadableJob(route, id)
    const body = deleteBodySchema.parse((await readJsonSafe<Record<string, unknown>>(request, {})) ?? {})
    const outcome = await runGuardedCommand<ItadAssetDeleteInput, ItadAssetChangeResult>(route, request, {
      commandId: 'itad.assets.delete',
      input: { jobId: id, assetId, reason: body.reason ?? null },
      resourceKind: 'itad.asset',
      resourceId: assetId,
      operation: 'delete',
    })
    if (!outcome.ok) return outcome.response
    return NextResponse.json({ ok: true })
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.assets.delete')
  }
}

const errorSchema = z.object({ error: z.string(), code: z.string().optional() }).passthrough()

export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'ITAD asset',
  methods: {
    GET: {
      summary: 'Asset detail',
      description: 'The device with its status, data-bearing decision and source, reconciliation state, open exception count and job. A voided asset is returned with `deleted: true`.',
      responses: [
        {
          status: 200,
          description: 'Asset',
          schema: z.object({
            id: z.string().uuid(),
            serial: z.string(),
            customerAssetTag: z.string().nullable(),
            manufacturer: z.string().nullable(),
            model: z.string().nullable(),
            dataBearing: z.boolean().nullable(),
            dataBearingSource: z.enum(ITAD_DATA_BEARING_SOURCES).nullable(),
            status: z.enum(ITAD_ASSET_STATUSES),
            reconciliation: z.enum(ASSET_RECONCILIATION),
            receivedAt: z.string(),
            receivedBy: z.object({ id: z.string().uuid(), name: z.string().nullable() }),
            deleted: z.boolean(),
            openExceptionCount: z.number().int(),
            updatedAt: z.string(),
            job: z.object({ id: z.string().uuid(), internalReference: z.string(), name: z.string(), status: z.enum(ITAD_JOB_STATUSES) }),
          }),
        },
      ],
      errors: [
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Missing itad.assets.view', schema: errorSchema },
        { status: 404, description: 'Job or asset not found in scope', schema: errorSchema },
      ],
    },
    PUT: {
      summary: 'Edit an asset',
      description:
        'Updates the customer tag, manufacturer, model and data-bearing flag while the job is in receiving. Send the expected `updatedAt` in the `x-om-ext-optimistic-lock-expected-updated-at` header. Serial and status cannot be changed.',
      requestBody: { contentType: 'application/json', schema: updateBodySchema },
      responses: [{ status: 200, description: 'Updated', schema: z.object({ updatedAt: z.string() }) }],
      errors: [
        { status: 400, description: 'Invalid input or a system field (`field_not_writable`)', schema: errorSchema },
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Missing itad.assets.receive', schema: errorSchema },
        { status: 404, description: 'Job or asset not found in scope', schema: errorSchema },
        { status: 409, description: 'Stale version, or the job is not in receiving', schema: errorSchema },
      ],
    },
    DELETE: {
      summary: 'Remove (void) an asset',
      description:
        'Soft-deletes a wrongly scanned asset while the job is in receiving. A reason (3–1000 characters) is required. Its scans stay in the log.',
      requestBody: { contentType: 'application/json', schema: deleteBodySchema },
      responses: [{ status: 200, description: 'Removed', schema: z.object({ ok: z.literal(true) }) }],
      errors: [
        { status: 400, description: 'Reason missing or invalid', schema: errorSchema },
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Missing itad.assets.manage', schema: errorSchema },
        { status: 404, description: 'Job or asset not found in scope', schema: errorSchema },
        { status: 409, description: 'Stale version, or the job is not in receiving', schema: errorSchema },
      ],
    },
  },
}

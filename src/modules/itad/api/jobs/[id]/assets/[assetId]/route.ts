import { NextResponse } from 'next/server'
import { z } from 'zod'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { ItadAssetChangeResult } from '../../../../../commands/assets'
import type { ItadAssetDeleteInput, ItadAssetUpdateInput } from '../../../../../data/validators'
import { runGuardedCommand } from '../../../../../lib/command-route'
import { itadRouteErrorResponse, loadReadableJob, resolveItadRouteContext } from '../../../../../lib/route-context'

export const metadata = {
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

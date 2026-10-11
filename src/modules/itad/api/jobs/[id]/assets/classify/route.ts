import { NextResponse } from 'next/server'
import { z } from 'zod'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { ItadAssetClassifyResult } from '../../../../../commands/assets'
import { ITAD_CLASSIFY_MAX_ASSETS, type ItadAssetClassifyInput } from '../../../../../data/validators'
import { runGuardedCommand } from '../../../../../lib/command-route'
import { itadRouteErrorResponse, loadReadableJob, resolveItadRouteContext } from '../../../../../lib/route-context'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['itad.assets.receive'] },
}

const paramsSchema = z.object({ id: z.string().uuid() })
const bodySchema = z.object({
  assetIds: z.array(z.string().uuid()).min(1).max(ITAD_CLASSIFY_MAX_ASSETS),
  dataBearing: z.boolean(),
  reason: z.string().max(1000).nullable().optional(),
})

/** Decides "carries data" for one or many assets at once (`itad.assets.classify`, all-or-nothing). */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const { id } = paramsSchema.parse({ id: params?.id })
    const route = await resolveItadRouteContext(request)
    await loadReadableJob(route, id)
    const body = bodySchema.parse((await readJsonSafe<Record<string, unknown>>(request, {})) ?? {})
    const outcome = await runGuardedCommand<ItadAssetClassifyInput, ItadAssetClassifyResult>(route, request, {
      commandId: 'itad.assets.classify',
      input: { jobId: id, assetIds: body.assetIds, dataBearing: body.dataBearing, reason: body.reason ?? null },
      resourceKind: 'itad.job',
      resourceId: id,
      operation: 'update',
    })
    if (!outcome.ok) return outcome.response
    return NextResponse.json({
      dataBearing: outcome.result.dataBearing,
      changedAssetIds: outcome.result.changedAssetIds,
      unchangedAssetIds: outcome.result.unchangedAssetIds,
    })
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.assets.classify')
  }
}

const errorSchema = z.object({ error: z.string(), code: z.string().optional(), assetIds: z.array(z.string()).optional() }).passthrough()

export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'Classify ITAD assets as carrying data or not',
  methods: {
    POST: {
      summary: 'Classify ITAD assets as carrying data or not',
      description:
        'Sets `dataBearing` for the selected active assets of the job while it is in receiving. All-or-nothing: when any asset is missing or refused, nothing changes and the error lists `assetIds`. Assets that already have the value are reported as unchanged. `true` moves an asset to `sanitization_required`; `false` keeps it on the normal path (`received`).',
      requestBody: { contentType: 'application/json', schema: bodySchema },
      responses: [
        {
          status: 200,
          description: 'Classified',
          schema: z.object({
            dataBearing: z.boolean(),
            changedAssetIds: z.array(z.string().uuid()),
            unchangedAssetIds: z.array(z.string().uuid()),
          }),
        },
      ],
      errors: [
        { status: 400, description: 'Invalid body or reason', schema: errorSchema },
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Missing itad.assets.receive', schema: errorSchema },
        { status: 404, description: 'Job not found in scope', schema: errorSchema },
        {
          status: 409,
          description: 'Job not in receiving (`assets_locked`), assets missing (`assets_not_found`) or refused; `assetIds` lists them',
          schema: errorSchema,
        },
      ],
    },
  },
}

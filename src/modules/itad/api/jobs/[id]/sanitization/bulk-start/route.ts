import { NextResponse } from 'next/server'
import { z } from 'zod'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { ItadBulkRunResult } from '../../../../../commands/sanitization'
import { ITAD_BULK_SANITIZATION_MAX_ASSETS, type ItadSanitizationBulkStartInput } from '../../../../../data/validators'
import { ITAD_SANITIZATION_METHODS } from '../../../../../domain/sanitization-state-machine'
import { runGuardedCommand } from '../../../../../lib/command-route'
import { itadRouteErrorResponse, jobIdParamsSchema, loadReadableJob, resolveItadRouteContext } from '../../../../../lib/route-context'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['itad.sanitization.execute'] },
}

const bodySchema = z.object({
  assetIds: z.array(z.string().uuid()).min(1).max(ITAD_BULK_SANITIZATION_MAX_ASSETS),
  method: z.enum(ITAD_SANITIZATION_METHODS),
  methodDetail: z.string().max(500).nullable().optional(),
  tool: z.string().max(200),
  toolVersion: z.string().max(100),
})

/** Starts one run per selected asset (`itad.sanitization.bulk_start`); all-or-nothing. */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const { id } = jobIdParamsSchema.parse({ id: params?.id })
    const route = await resolveItadRouteContext(request)
    await loadReadableJob(route, id)
    const body = bodySchema.parse((await readJsonSafe<Record<string, unknown>>(request, {})) ?? {})
    const outcome = await runGuardedCommand<ItadSanitizationBulkStartInput, ItadBulkRunResult>(route, request, {
      commandId: 'itad.sanitization.bulk_start',
      input: { jobId: id, ...body },
      resourceKind: 'itad.job',
      resourceId: id,
      operation: 'create',
    })
    if (!outcome.ok) return outcome.response
    return NextResponse.json({ bulkBatchId: outcome.result.bulkBatchId, runs: outcome.result.runs }, { status: 201 })
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.sanitization.bulk_start')
  }
}

const errorSchema = z.object({ error: z.string(), code: z.string().optional(), blockingAssetIds: z.array(z.string()).optional() }).passthrough()

export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'Start ITAD sanitization runs in bulk',
  methods: {
    POST: {
      summary: 'Start one sanitization run per selected asset',
      description:
        'All selected assets (1–200) must be in `sanitization_required` and the job in processing. All-or-nothing: otherwise 409 lists `blockingAssetIds` and nothing starts. The runs share a `bulkBatchId`.',
      requestBody: { contentType: 'application/json', schema: bodySchema },
      responses: [
        {
          status: 201,
          description: 'Runs started',
          schema: z.object({
            bulkBatchId: z.string().uuid(),
            runs: z.array(z.object({ runId: z.string().uuid(), assetId: z.string().uuid() })),
          }),
        },
      ],
      errors: [
        { status: 400, description: 'Invalid body', schema: errorSchema },
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Missing itad.sanitization.execute', schema: errorSchema },
        { status: 404, description: 'Job not found in scope', schema: errorSchema },
        { status: 409, description: 'Job not in processing, or blocking assets (`blockingAssetIds`)', schema: errorSchema },
      ],
    },
  },
}

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { ItadBulkRunResult } from '../../../../../commands/sanitization'
import { ITAD_BULK_SANITIZATION_MAX_ASSETS, type ItadSanitizationBulkResultInput } from '../../../../../data/validators'
import { ITAD_VERIFICATION_METHODS } from '../../../../../domain/sanitization-state-machine'
import { runGuardedCommand } from '../../../../../lib/command-route'
import { itadRouteErrorResponse, jobIdParamsSchema, loadReadableJob, resolveItadRouteContext } from '../../../../../lib/route-context'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['itad.sanitization.execute'] },
}

const bodySchema = z.object({
  assetIds: z.array(z.string().uuid()).min(1).max(ITAD_BULK_SANITIZATION_MAX_ASSETS),
  result: z.enum(['PASS', 'FAIL']),
  verificationMethod: z.enum(ITAD_VERIFICATION_METHODS),
  verificationNotes: z.string().max(2000).nullable().optional(),
})

/** Records the same result for the open run of each selected asset (`itad.sanitization.bulk_record_result`). */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const { id } = jobIdParamsSchema.parse({ id: params?.id })
    const route = await resolveItadRouteContext(request)
    await loadReadableJob(route, id)
    const body = bodySchema.parse((await readJsonSafe<Record<string, unknown>>(request, {})) ?? {})
    const outcome = await runGuardedCommand<ItadSanitizationBulkResultInput, ItadBulkRunResult>(route, request, {
      commandId: 'itad.sanitization.bulk_record_result',
      input: { jobId: id, ...body },
      resourceKind: 'itad.job',
      resourceId: id,
      operation: 'update',
    })
    if (!outcome.ok) return outcome.response
    return NextResponse.json({ result: body.result, runs: outcome.result.runs })
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.sanitization.bulk_result')
  }
}

const errorSchema = z.object({ error: z.string(), code: z.string().optional(), blockingAssetIds: z.array(z.string()).optional() }).passthrough()

export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'Record ITAD sanitization results in bulk',
  methods: {
    POST: {
      summary: 'Record PASS or FAIL for the open run of each selected asset',
      description:
        'All selected assets (1–200) must have an open run and the job must be in processing. FAIL needs verification notes. All-or-nothing: otherwise 409 lists `blockingAssetIds` and nothing changes.',
      requestBody: { contentType: 'application/json', schema: bodySchema },
      responses: [
        {
          status: 200,
          description: 'Results recorded',
          schema: z.object({
            result: z.enum(['PASS', 'FAIL']),
            runs: z.array(z.object({ runId: z.string().uuid(), assetId: z.string().uuid() })),
          }),
        },
      ],
      errors: [
        { status: 400, description: 'Invalid body, or FAIL without verification notes', schema: errorSchema },
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Missing itad.sanitization.execute', schema: errorSchema },
        { status: 404, description: 'Job not found in scope', schema: errorSchema },
        { status: 409, description: 'Job not in processing, or assets without an open run (`blockingAssetIds`)', schema: errorSchema },
      ],
    },
  },
}

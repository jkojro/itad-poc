import { NextResponse } from 'next/server'
import { z } from 'zod'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { ItadRunChangeResult } from '../../../../../../../commands/sanitization'
import type { ItadSanitizationResultInput } from '../../../../../../../data/validators'
import { ITAD_VERIFICATION_METHODS } from '../../../../../../../domain/sanitization-state-machine'
import { runGuardedCommand } from '../../../../../../../lib/command-route'
import { itadRouteErrorResponse, loadReadableJob, resolveItadRouteContext } from '../../../../../../../lib/route-context'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['itad.sanitization.execute'] },
}

const paramsSchema = z.object({ id: z.string().uuid(), runId: z.string().uuid() })
const bodySchema = z.object({
  result: z.enum(['PASS', 'FAIL']),
  verificationMethod: z.enum(ITAD_VERIFICATION_METHODS),
  verificationNotes: z.string().max(2000).nullable().optional(),
  /** Optional identifiers of the media the run covered, e.g. SSD serials (at most 10 × 100 characters). */
  mediaIdentifiers: z.array(z.string().max(200)).max(50).nullable().optional(),
})

/** Records PASS or FAIL for an open run (`itad.sanitization.record_result`). */
export async function POST(request: Request, { params }: { params: { id: string; runId: string } }) {
  try {
    const { id, runId } = paramsSchema.parse({ id: params?.id, runId: params?.runId })
    const route = await resolveItadRouteContext(request)
    await loadReadableJob(route, id)
    const body = bodySchema.parse((await readJsonSafe<Record<string, unknown>>(request, {})) ?? {})
    const outcome = await runGuardedCommand<ItadSanitizationResultInput, ItadRunChangeResult>(route, request, {
      commandId: 'itad.sanitization.record_result',
      input: { jobId: id, runId, ...body },
      resourceKind: 'itad.sanitization_run',
      resourceId: runId,
      operation: 'update',
    })
    if (!outcome.ok) return outcome.response
    const { result } = outcome
    return NextResponse.json({ result: result.result, assetStatus: result.assetStatus, updatedAt: result.updatedAt })
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.sanitization.result')
  }
}

const errorSchema = z.object({ error: z.string(), code: z.string().optional() }).passthrough()

export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'Record an ITAD sanitization result',
  methods: {
    POST: {
      summary: 'Record PASS or FAIL for an open sanitization run',
      description:
        'PASS moves the asset to `sanitized`; FAIL (verification notes required) records `sanitization_failed` and moves it to `review_required`. A run is completed exactly once.',
      requestBody: { contentType: 'application/json', schema: bodySchema },
      responses: [
        {
          status: 200,
          description: 'Result recorded',
          schema: z.object({ result: z.enum(['PASS', 'FAIL']), assetStatus: z.enum(['sanitized', 'review_required']), updatedAt: z.string() }),
        },
      ],
      errors: [
        { status: 400, description: 'Invalid body, or FAIL without verification notes', schema: errorSchema },
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Missing itad.sanitization.execute', schema: errorSchema },
        { status: 404, description: 'Job or run not found in scope', schema: errorSchema },
        { status: 409, description: 'Run already finished, or job not in processing', schema: errorSchema },
      ],
    },
  },
}

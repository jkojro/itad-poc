import { NextResponse } from 'next/server'
import { z } from 'zod'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { ItadRunChangeResult } from '../../../../../../../commands/sanitization'
import type { ItadSanitizationAbortInput } from '../../../../../../../data/validators'
import { runGuardedCommand } from '../../../../../../../lib/command-route'
import { itadRouteErrorResponse, loadReadableJob, resolveItadRouteContext } from '../../../../../../../lib/route-context'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['itad.sanitization.execute'] },
}

const paramsSchema = z.object({ id: z.string().uuid(), runId: z.string().uuid() })
const bodySchema = z.object({ reason: z.string().max(1000).nullable().optional() })

/** Aborts an open run started by mistake (`itad.sanitization.abort`); reason required. */
export async function POST(request: Request, { params }: { params: { id: string; runId: string } }) {
  try {
    const { id, runId } = paramsSchema.parse({ id: params?.id, runId: params?.runId })
    const route = await resolveItadRouteContext(request)
    await loadReadableJob(route, id)
    const body = bodySchema.parse((await readJsonSafe<Record<string, unknown>>(request, {})) ?? {})
    const outcome = await runGuardedCommand<ItadSanitizationAbortInput, ItadRunChangeResult>(route, request, {
      commandId: 'itad.sanitization.abort',
      input: { jobId: id, runId, reason: body.reason ?? null },
      resourceKind: 'itad.sanitization_run',
      resourceId: runId,
      operation: 'update',
    })
    if (!outcome.ok) return outcome.response
    return NextResponse.json({ result: outcome.result.result, assetStatus: outcome.result.assetStatus, updatedAt: outcome.result.updatedAt })
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.sanitization.abort')
  }
}

const errorSchema = z.object({ error: z.string(), code: z.string().optional() }).passthrough()

export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'Abort an ITAD sanitization run',
  methods: {
    POST: {
      summary: 'Abort an open sanitization run',
      description: 'The run becomes ABORTED with the reason (3–1000 characters) and stays in the history; the asset returns to `sanitization_required`.',
      requestBody: { contentType: 'application/json', schema: bodySchema },
      responses: [
        {
          status: 200,
          description: 'Run aborted',
          schema: z.object({ result: z.literal('ABORTED'), assetStatus: z.literal('sanitization_required'), updatedAt: z.string() }),
        },
      ],
      errors: [
        { status: 400, description: 'Reason missing or invalid', schema: errorSchema },
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Missing itad.sanitization.execute', schema: errorSchema },
        { status: 404, description: 'Job or run not found in scope', schema: errorSchema },
        { status: 409, description: 'Run already finished, or job not in processing', schema: errorSchema },
      ],
    },
  },
}

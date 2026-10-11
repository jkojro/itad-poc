import { NextResponse } from 'next/server'
import { z } from 'zod'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { ItadRetryResult } from '../../../../../../../commands/sanitization'
import type { ItadSanitizationRetryInput } from '../../../../../../../data/validators'
import { runGuardedCommand } from '../../../../../../../lib/command-route'
import { itadRouteErrorResponse, loadReadableJob, resolveItadRouteContext } from '../../../../../../../lib/route-context'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['itad.sanitization.manage'] },
}

const paramsSchema = z.object({ id: z.string().uuid(), assetId: z.string().uuid() })
const bodySchema = z.object({ reason: z.string().max(1000).nullable().optional() })

/** Approves a retry after a failed run (`itad.sanitization.approve_retry`); reason required; lock header expected. */
export async function POST(request: Request, { params }: { params: { id: string; assetId: string } }) {
  try {
    const { id, assetId } = paramsSchema.parse({ id: params?.id, assetId: params?.assetId })
    const route = await resolveItadRouteContext(request)
    await loadReadableJob(route, id)
    const body = bodySchema.parse((await readJsonSafe<Record<string, unknown>>(request, {})) ?? {})
    const outcome = await runGuardedCommand<ItadSanitizationRetryInput, ItadRetryResult>(route, request, {
      commandId: 'itad.sanitization.approve_retry',
      input: { jobId: id, assetId, reason: body.reason ?? null },
      resourceKind: 'itad.asset',
      resourceId: assetId,
      operation: 'update',
    })
    if (!outcome.ok) return outcome.response
    return NextResponse.json({ assetStatus: outcome.result.assetStatus, updatedAt: outcome.result.updatedAt })
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.sanitization.retry')
  }
}

const errorSchema = z.object({ error: z.string(), code: z.string().optional() }).passthrough()

export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'Approve an ITAD sanitization retry',
  methods: {
    POST: {
      summary: 'Approve a sanitization retry after a failed run',
      description:
        'Moves an asset from `review_required` back to `sanitization_required` with a reason (3–1000 characters). The failed run stays in the history.',
      requestBody: { contentType: 'application/json', schema: bodySchema },
      responses: [
        { status: 200, description: 'Retry approved', schema: z.object({ assetStatus: z.literal('sanitization_required'), updatedAt: z.string() }) },
      ],
      errors: [
        { status: 400, description: 'Reason missing or invalid', schema: errorSchema },
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Missing itad.sanitization.manage', schema: errorSchema },
        { status: 404, description: 'Job or asset not found in scope', schema: errorSchema },
        { status: 409, description: 'Job not in processing, asset not in review, or a stale version', schema: errorSchema },
      ],
    },
  },
}

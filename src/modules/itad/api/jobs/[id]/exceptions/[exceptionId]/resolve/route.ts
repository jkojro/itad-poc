import { NextResponse } from 'next/server'
import { z } from 'zod'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { ItadExceptionChangeResult } from '../../../../../../commands/exceptions'
import type { ItadExceptionResolveInput } from '../../../../../../data/validators'
import { runGuardedCommand } from '../../../../../../lib/command-route'
import { itadRouteErrorResponse, loadReadableJob, resolveItadRouteContext } from '../../../../../../lib/route-context'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['itad.exceptions.manage'] },
}

const paramsSchema = z.object({ id: z.string().uuid(), exceptionId: z.string().uuid() })
const bodySchema = z.object({ outcome: z.string().max(64), reason: z.string().max(1000).nullable().optional() })

/** Manager resolution of a MISSING / UNEXPECTED exception (`itad.exceptions.resolve`); lock header expected. */
export async function POST(request: Request, { params }: { params: { id: string; exceptionId: string } }) {
  try {
    const { id, exceptionId } = paramsSchema.parse({ id: params?.id, exceptionId: params?.exceptionId })
    const route = await resolveItadRouteContext(request)
    await loadReadableJob(route, id)
    const body = bodySchema.parse((await readJsonSafe<Record<string, unknown>>(request, {})) ?? {})
    const outcome = await runGuardedCommand<ItadExceptionResolveInput, ItadExceptionChangeResult>(route, request, {
      commandId: 'itad.exceptions.resolve',
      input: { jobId: id, exceptionId, outcome: body.outcome, reason: body.reason ?? null },
      resourceKind: 'itad.exception',
      resourceId: exceptionId,
      operation: 'update',
    })
    if (!outcome.ok) return outcome.response
    return NextResponse.json({ status: outcome.result.status, resolutionOutcome: outcome.result.resolutionOutcome, updatedAt: outcome.result.updatedAt })
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.exceptions.resolve')
  }
}

const errorSchema = z.object({ error: z.string(), code: z.string().optional() }).passthrough()

export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'Resolve an ITAD exception',
  methods: {
    POST: {
      summary: 'Resolve a missing or unexpected exception with an outcome',
      description:
        'MISSING_FROM_DELIVERY: `not_shipped`, `lost_in_transit`, `manifest_error`; UNEXPECTED_ASSET: `accepted_into_job`. A reason (3–1000 characters) is required. Manifest and asset data are never changed. DUPLICATE_SERIAL and SANITIZATION_FAILED return 409 `resolve_through_domain_action`.',
      requestBody: { contentType: 'application/json', schema: bodySchema },
      responses: [
        {
          status: 200,
          description: 'Resolved',
          schema: z.object({ status: z.literal('resolved'), resolutionOutcome: z.string(), updatedAt: z.string() }),
        },
      ],
      errors: [
        { status: 400, description: 'Outcome not allowed for the type, or reason missing', schema: errorSchema },
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Missing itad.exceptions.manage', schema: errorSchema },
        { status: 404, description: 'Job or exception not found in scope', schema: errorSchema },
        { status: 409, description: 'Already resolved, resolved through a domain action, or a stale version', schema: errorSchema },
      ],
    },
  },
}

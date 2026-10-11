import { NextResponse } from 'next/server'
import { z } from 'zod'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { ItadExceptionChangeResult } from '../../../../../../commands/exceptions'
import type { ItadExceptionAssignInput } from '../../../../../../data/validators'
import { runGuardedCommand } from '../../../../../../lib/command-route'
import { itadRouteErrorResponse, loadReadableJob, resolveItadRouteContext } from '../../../../../../lib/route-context'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['itad.exceptions.manage'] },
}

const paramsSchema = z.object({ id: z.string().uuid(), exceptionId: z.string().uuid() })
const bodySchema = z.object({ assignedToUserId: z.string().uuid().nullable() })

/** Assigns, reassigns or unassigns an OPEN exception (`itad.exceptions.assign`); lock header expected. */
export async function POST(request: Request, { params }: { params: { id: string; exceptionId: string } }) {
  try {
    const { id, exceptionId } = paramsSchema.parse({ id: params?.id, exceptionId: params?.exceptionId })
    const route = await resolveItadRouteContext(request)
    await loadReadableJob(route, id)
    const body = bodySchema.parse((await readJsonSafe<Record<string, unknown>>(request, {})) ?? {})
    const outcome = await runGuardedCommand<ItadExceptionAssignInput, ItadExceptionChangeResult>(route, request, {
      commandId: 'itad.exceptions.assign',
      input: { jobId: id, exceptionId, assignedToUserId: body.assignedToUserId },
      resourceKind: 'itad.exception',
      resourceId: exceptionId,
      operation: 'update',
    })
    if (!outcome.ok) return outcome.response
    return NextResponse.json({ assignedToUserId: outcome.result.assignedToUserId, updatedAt: outcome.result.updatedAt })
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.exceptions.assign')
  }
}

const errorSchema = z.object({ error: z.string(), code: z.string().optional() }).passthrough()

export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'Assign an ITAD exception',
  methods: {
    POST: {
      summary: 'Assign, reassign or unassign an open exception',
      description:
        '`assignedToUserId` must be an active user of the job organization; `null` unassigns. Recorded in the exception history; never resolves. Send the exception `updatedAt` in the `x-om-ext-optimistic-lock-expected-updated-at` header.',
      requestBody: { contentType: 'application/json', schema: bodySchema },
      responses: [{ status: 200, description: 'Assigned', schema: z.object({ assignedToUserId: z.string().uuid().nullable(), updatedAt: z.string() }) }],
      errors: [
        { status: 400, description: 'Invalid assignee (`assignee_invalid`)', schema: errorSchema },
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Missing itad.exceptions.manage', schema: errorSchema },
        { status: 404, description: 'Job or exception not found in scope', schema: errorSchema },
        { status: 409, description: 'Exception resolved, or a stale version', schema: errorSchema },
      ],
    },
  },
}

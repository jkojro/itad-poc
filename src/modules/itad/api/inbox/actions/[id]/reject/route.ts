import { NextResponse } from 'next/server'
import { z } from 'zod'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { ItadInboxRejectActionInput } from '../../../../../data/validators'
import { runGuardedCommand } from '../../../../../lib/command-route'
import { itadRouteErrorResponse, resolveItadRouteContext } from '../../../../../lib/route-context'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['itad.inbox.manage'] },
}

const paramsSchema = z.object({ id: z.string().uuid() })
const bodySchema = z.object({ reason: z.string().trim().max(1000).nullable().optional() })

/** Reject an Inbox action (`itad.inbox.reject_action`); nothing runs. */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const { id } = paramsSchema.parse({ id: params?.id })
    const route = await resolveItadRouteContext(request)
    const body = bodySchema.parse((await readJsonSafe<Record<string, unknown>>(request, {})) ?? {})
    const outcome = await runGuardedCommand<ItadInboxRejectActionInput, Record<string, unknown>>(route, request, {
      commandId: 'itad.inbox.reject_action',
      input: { actionId: id, reason: body.reason ?? null },
      resourceKind: 'itad.inbox_action',
      resourceId: id,
      operation: 'update',
    })
    if (!outcome.ok) return outcome.response
    return NextResponse.json(outcome.result)
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.inbox.reject_action')
  }
}

const errorSchema = z.object({ error: z.string(), code: z.string().optional() }).passthrough()

export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'Reject an ITAD Inbox action',
  methods: {
    POST: {
      summary: 'Reject a pending Inbox action',
      description: 'The action will not run; the optional reason is kept. Send the action `updatedAt` in the lock header.',
      requestBody: { contentType: 'application/json', schema: bodySchema },
      responses: [{ status: 200, description: 'Rejected', schema: z.object({ actionId: z.string().uuid(), status: z.string() }).passthrough() }],
      errors: [
        { status: 403, description: 'Missing itad.inbox.manage', schema: errorSchema },
        { status: 404, description: 'Action not found in scope', schema: errorSchema },
        { status: 409, description: 'Already decided, or a stale version', schema: errorSchema },
      ],
    },
  },
}

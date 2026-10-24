import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { ItadInboxMessageRefInput } from '../../../../../data/validators'
import { runGuardedCommand } from '../../../../../lib/command-route'
import { itadRouteErrorResponse, resolveItadRouteContext } from '../../../../../lib/route-context'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['itad.inbox.manage'] },
}

const paramsSchema = z.object({ id: z.string().uuid() })

/** Reprocess an inbox message (`itad.inbox.reprocess`); lock header expected. */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const { id } = paramsSchema.parse({ id: params?.id })
    const route = await resolveItadRouteContext(request)
    const outcome = await runGuardedCommand<ItadInboxMessageRefInput, Record<string, unknown>>(route, request, {
      commandId: 'itad.inbox.reprocess',
      input: { messageId: id },
      resourceKind: 'itad.inbox_message',
      resourceId: id,
      operation: 'update',
    })
    if (!outcome.ok) return outcome.response
    return NextResponse.json(outcome.result)
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.inbox.reprocess')
  }
}

const errorSchema = z.object({ error: z.string(), code: z.string().optional() }).passthrough()

export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'Reprocess an inbox message',
  methods: {
    POST: {
      summary: 'Reprocess an inbox message',
      description: 'Starts a new processing generation (matching and interpretation). Allowed when failed, stalled, or proposed without an executed action. Send the message `updatedAt` in the lock header.',
      responses: [{ status: 200, description: 'Done', schema: z.object({ messageId: z.string().uuid(), status: z.string(), generation: z.number() }).passthrough() }],
      errors: [
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Missing itad.inbox.manage', schema: errorSchema },
        { status: 404, description: 'Message not found in scope', schema: errorSchema },
        { status: 409, description: 'Still processing, already executed, or a stale version', schema: errorSchema },
      ],
    },
  },
}

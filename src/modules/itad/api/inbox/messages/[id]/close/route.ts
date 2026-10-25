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

/** Close an Inbox email that needs no action (`itad.inbox.close`). */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const { id } = paramsSchema.parse({ id: params?.id })
    const route = await resolveItadRouteContext(request)
    const outcome = await runGuardedCommand<ItadInboxMessageRefInput, Record<string, unknown>>(route, request, {
      commandId: 'itad.inbox.close',
      input: { messageId: id },
      resourceKind: 'itad.inbox_message',
      resourceId: id,
      operation: 'update',
    })
    if (!outcome.ok) return outcome.response
    return NextResponse.json(outcome.result)
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.inbox.close')
  }
}

const errorSchema = z.object({ error: z.string(), code: z.string().optional() }).passthrough()

export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'Close an ITAD Inbox email',
  methods: {
    POST: {
      summary: 'Close an Inbox email without actions',
      description: 'Allowed when no action is pending. Send the message `updatedAt` in the lock header.',
      responses: [{ status: 200, description: 'Closed', schema: z.object({ messageId: z.string().uuid(), status: z.literal('closed') }).passthrough() }],
      errors: [
        { status: 403, description: 'Missing itad.inbox.manage', schema: errorSchema },
        { status: 404, description: 'Message not found in scope', schema: errorSchema },
        { status: 409, description: 'Pending actions, still processing, or a stale version', schema: errorSchema },
      ],
    },
  },
}

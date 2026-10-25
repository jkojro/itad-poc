import { NextResponse } from 'next/server'
import { z } from 'zod'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { ItadInboxSelectMatchInput } from '../../../../../data/validators'
import { runGuardedCommand } from '../../../../../lib/command-route'
import { itadRouteErrorResponse, resolveItadRouteContext } from '../../../../../lib/route-context'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['itad.inbox.manage'] },
}

const paramsSchema = z.object({ id: z.string().uuid() })
const bodySchema = z.object({
  customerId: z.string().uuid().nullable().optional(),
  jobId: z.string().uuid().nullable().optional(),
  actionTargets: z.array(z.object({ actionId: z.string().uuid(), exceptionId: z.string().uuid() })).max(20).optional(),
})

/** Match panel (`itad.inbox.select_match`): choose the customer / job / exceptions; undecided actions are rebuilt. */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const { id } = paramsSchema.parse({ id: params?.id })
    const route = await resolveItadRouteContext(request)
    const body = bodySchema.parse((await readJsonSafe<Record<string, unknown>>(request, {})) ?? {})
    const outcome = await runGuardedCommand<ItadInboxSelectMatchInput, Record<string, unknown>>(route, request, {
      commandId: 'itad.inbox.select_match',
      input: { messageId: id, ...body },
      resourceKind: 'itad.inbox_message',
      resourceId: id,
      operation: 'update',
    })
    if (!outcome.ok) return outcome.response
    return NextResponse.json(outcome.result)
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.inbox.select_match')
  }
}

const errorSchema = z.object({ error: z.string(), code: z.string().optional() }).passthrough()

export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'Choose the match of an ITAD Inbox email',
  methods: {
    POST: {
      summary: 'Choose the customer, job and exceptions of an Inbox email',
      description:
        'The only way to change an action target. Undecided actions are superseded and rebuilt from the stored interpretation with the new target and its current version (no model call); fields the operator edited are kept. Choosing a job or customer needs `itad.jobs.view`, choosing an exception `itad.exceptions.view`. Send the message `updatedAt` in the lock header.',
      requestBody: { contentType: 'application/json', schema: bodySchema },
      responses: [{ status: 200, description: 'Match chosen, actions rebuilt', schema: z.object({ messageId: z.string().uuid(), status: z.string() }).passthrough() }],
      errors: [
        { status: 403, description: 'Missing a required feature', schema: errorSchema },
        { status: 404, description: 'Message, job or customer not found in scope', schema: errorSchema },
        { status: 409, description: 'Still processing, nothing to rebuild, or a stale version', schema: errorSchema },
      ],
    },
  },
}

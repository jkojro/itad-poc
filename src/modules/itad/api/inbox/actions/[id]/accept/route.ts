import { NextResponse } from 'next/server'
import { z } from 'zod'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { itadInboxAcceptBodySchema } from '../../../../../data/validators'
import { itadRouteErrorResponse, resolveItadRouteContext } from '../../../../../lib/route-context'
import { acceptInboxAction } from '../../../../../services/inbox-decisions'

export const metadata = {
  // The command's own feature and the target's view feature are checked in the record's organization.
  POST: { requireAuth: true, requireFeatures: ['itad.inbox.manage'] },
}

const paramsSchema = z.object({ id: z.string().uuid() })

/** Accept an Inbox action: re-validate and run the domain command with the email audit context. */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const { id } = paramsSchema.parse({ id: params?.id })
    const route = await resolveItadRouteContext(request)
    const body = itadInboxAcceptBodySchema.parse((await readJsonSafe<Record<string, unknown>>(request, {})) ?? {})
    const result = await acceptInboxAction(route, request, { actionId: id, timeZone: body.timeZone })
    if ('response' in result) return result.response
    return NextResponse.json(result, { status: result.status === 'executed' ? 200 : 409 })
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.inbox.accept_action')
  }
}

const errorSchema = z.object({ error: z.string(), code: z.string().optional() }).passthrough()
const resultSchema = z.object({
  actionId: z.string().uuid(),
  status: z.enum(['executed', 'failed']),
  recordId: z.string().uuid().nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
})

export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'Accept an ITAD Inbox action',
  methods: {
    POST: {
      summary: 'Accept a pending Inbox action',
      description:
        'Runs the same command as the UI (update_pickup → itad.jobs.update, resolve_exception → itad.exceptions.resolve) as the operator, after re-checking permissions (the command feature and the target view feature in the record organization), missing fields, the target version and eligibility. The action log carries `{ source: ai, channel: email, actionId, proposalId, origin }`. `timeZone` is the zone of a local pickup time the action does not state. Send the action `updatedAt` in the lock header.',
      requestBody: { contentType: 'application/json', schema: itadInboxAcceptBodySchema },
      responses: [
        { status: 200, description: 'Executed', schema: resultSchema },
        { status: 409, description: 'The domain refused it; the action is failed with the reason', schema: resultSchema },
      ],
      errors: [
        { status: 400, description: 'Missing fields or an invalid value', schema: errorSchema },
        { status: 403, description: 'Missing a required feature', schema: errorSchema },
        { status: 404, description: 'Action or target not found in scope', schema: errorSchema },
        { status: 409, description: 'Already decided, the target changed (`target_changed`), or a stale action version', schema: errorSchema },
      ],
    },
  },
}

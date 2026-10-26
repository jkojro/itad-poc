import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { itadInboxSendReplySchema } from '../../../../../data/validators'
import { itadRouteErrorResponse, resolveItadRouteContext } from '../../../../../lib/route-context'
import { sendInboxReply } from '../../../../../services/inbox-reply'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['itad.inbox.reply'] },
}

const paramsSchema = z.object({ id: z.string().uuid() })

/** Send the reply to the customer (phase 4); lock header = the message `updatedAt`. */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const { id } = paramsSchema.parse({ id: params?.id })
    const body = itadInboxSendReplySchema.parse(await request.json().catch(() => ({})))
    const route = await resolveItadRouteContext(request)
    const outcome = await sendInboxReply(route, request, { ...body, messageId: id })
    if ('response' in outcome) return outcome.response
    return NextResponse.json(outcome)
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.inbox.send_reply')
  }
}

const errorSchema = z.object({ error: z.string(), code: z.string().optional() }).passthrough()

export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'Send the reply to a customer email',
  methods: {
    POST: {
      summary: 'Send the reply to a customer email',
      description:
        'Sends one reply per inbound email through the system email transport: To = the customer sender (fixed), Reply-To = the organization Inbox address. Needs `itad.inbox.reply` and `itad.jobs.view` in the message organization; send the message `updatedAt` in the lock header. An email cannot be recalled.',
      requestBody: { contentType: 'application/json', schema: itadInboxSendReplySchema },
      responses: [{ status: 200, description: 'Sent', schema: z.object({ messageId: z.string().uuid(), sentAt: z.string(), toAddress: z.string() }) }],
      errors: [
        { status: 400, description: 'Invalid subject or body', schema: errorSchema },
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Missing itad.inbox.reply or itad.jobs.view', schema: errorSchema },
        { status: 404, description: 'Message not found in scope', schema: errorSchema },
        { status: 409, description: 'Already sent, being sent, an unfinished earlier send (confirmPossibleDuplicate), still processing, or a stale version', schema: errorSchema },
        { status: 502, description: 'The provider refused the email', schema: errorSchema },
        { status: 503, description: 'Sending email is not configured or disabled', schema: errorSchema },
      ],
    },
  },
}

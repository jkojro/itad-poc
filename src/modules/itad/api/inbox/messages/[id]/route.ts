import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { itadRouteErrorResponse, resolveItadRouteContext } from '../../../../lib/route-context'
import { readInboxMessage } from '../../../../services/inbox-reader'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['itad.inbox.view'] },
}

const paramsSchema = z.object({ id: z.string().uuid() })

/** One inbox message with its match, actions and draft; ITAD record details degraded per the reader's view features. */
export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    const { id } = paramsSchema.parse({ id: params?.id })
    const route = await resolveItadRouteContext(request)
    return NextResponse.json(await readInboxMessage(route, id))
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.inbox.detail')
  }
}

const errorSchema = z.object({ error: z.string(), code: z.string().optional() }).passthrough()

export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'ITAD Inbox message',
  methods: {
    GET: {
      summary: 'Read a customer email and its ITAD proposal',
      description:
        'The email (sender, subject, current text, thread history) and the proposal shape need `itad.inbox.view`. Job details, the I2 *before* value, customer names and the draft reply need `itad.jobs.view`; exception details need `itad.exceptions.view` — otherwise `{ hidden: true }`.',
      responses: [{ status: 200, description: 'Message', schema: z.object({ id: z.string().uuid(), status: z.string(), actions: z.array(z.record(z.string(), z.unknown())) }).passthrough() }],
      errors: [
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Missing itad.inbox.view', schema: errorSchema },
        { status: 404, description: 'Message not found in scope', schema: errorSchema },
      ],
    },
  },
}

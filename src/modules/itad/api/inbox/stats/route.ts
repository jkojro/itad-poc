import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { itadRouteErrorResponse, resolveItadRouteContext } from '../../../lib/route-context'
import { inboxStats } from '../../../services/inbox-reader'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['itad.inbox.view'] },
}

/** Inbox Ops observability for the last 30 days (PDF §5): proposals, decisions, failures, operator corrections. */
export async function GET(request: Request) {
  try {
    const route = await resolveItadRouteContext(request)
    return NextResponse.json(await inboxStats(route))
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.inbox.stats')
  }
}

const errorSchema = z.object({ error: z.string() }).passthrough()

export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'ITAD Inbox statistics',
  methods: {
    GET: {
      summary: 'Inbox Ops statistics for the last 30 days',
      description:
        'Messages, processing failures, and proposed actions by outcome in the readable organizations. `editedBeforeDecision` counts actions whose approved fields differ from what the AI proposed (operator corrections).',
      responses: [
        {
          status: 200,
          description: 'Statistics',
          schema: z.object({
            days: z.number(),
            messages: z.number(),
            failedProcessing: z.number(),
            actions: z.object({
              proposed: z.number(),
              executed: z.number(),
              rejected: z.number(),
              failed: z.number(),
              pending: z.number(),
              editedBeforeDecision: z.number(),
            }),
          }),
        },
      ],
      errors: [{ status: 403, description: 'Missing itad.inbox.view', schema: errorSchema }],
    },
  },
}

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { itadInboxImportSchema, itadInboxListSchema, type ItadInboxImportInput } from '../../../data/validators'
import { runGuardedCommand } from '../../../lib/command-route'
import { itadRouteErrorResponse, resolveItadRouteContext } from '../../../lib/route-context'
import { listInboxMessages } from '../../../services/inbox-reader'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['itad.inbox.view'] },
  POST: { requireAuth: true, requireFeatures: ['itad.inbox.manage'] },
}

/** Inbox list (spec "API Contracts"): customer emails with intents and statuses; job details only with `itad.jobs.view`. */
export async function GET(request: Request) {
  try {
    const query = itadInboxListSchema.parse(Object.fromEntries(new URL(request.url).searchParams))
    const route = await resolveItadRouteContext(request)
    const result = await listInboxMessages(route, query)
    return NextResponse.json({ items: result.items, total: result.total, page: query.page, pageSize: query.pageSize })
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.inbox.list')
  }
}

/** Manual import of a customer email (tests, demo recovery, debugging); processing is asynchronous. */
export async function POST(request: Request) {
  try {
    const route = await resolveItadRouteContext(request)
    const body = itadInboxImportSchema.parse((await readJsonSafe<Record<string, unknown>>(request, {})) ?? {})
    const outcome = await runGuardedCommand<ItadInboxImportInput, { messageId: string }>(route, request, {
      commandId: 'itad.inbox.import',
      input: body,
      resourceKind: 'itad.inbox_message',
      resourceId: 'new',
      operation: 'create',
    })
    if (!outcome.ok) return outcome.response
    return NextResponse.json({ id: outcome.result.messageId }, { status: 202 })
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.inbox.import')
  }
}

const errorSchema = z.object({ error: z.string(), code: z.string().optional() }).passthrough()
const hiddenOr = <T extends z.ZodTypeAny>(schema: T) => z.union([schema, z.object({ hidden: z.literal(true) })])
const listItemSchema = z.object({
  id: z.string().uuid(),
  receivedAt: z.string(),
  source: z.enum(['email', 'manual']),
  customerAddress: z.string(),
  customerName: z.string().nullable(),
  subject: z.string(),
  intents: z.array(z.string()),
  status: z.enum(['processing', 'proposed', 'failed', 'closed']),
  stalled: z.boolean(),
  matchStatus: z.enum(['high', 'needs_review', 'ambiguous']).nullable(),
  pendingActions: z.number().int(),
  job: hiddenOr(z.object({ id: z.string().uuid(), reference: z.string() })).nullable(),
  updatedAt: z.string(),
})

export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'ITAD Inbox messages',
  methods: {
    GET: {
      summary: 'List customer emails and their ITAD proposals',
      description: 'Newest first, in the readable organizations. `job` is `{ hidden: true }` without `itad.jobs.view` in the message organization.',
      query: itadInboxListSchema,
      responses: [{ status: 200, description: 'Messages', schema: z.object({ items: z.array(listItemSchema), total: z.number(), page: z.number(), pageSize: z.number() }) }],
      errors: [
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Missing itad.inbox.view', schema: errorSchema },
      ],
    },
    POST: {
      summary: 'Import a customer email manually',
      description: 'Creates an inbox message in the selected organization and enqueues its processing (matching, interpretation, proposal). `extraction` is accepted only in the integration environment.',
      requestBody: { contentType: 'application/json', schema: itadInboxImportSchema },
      responses: [{ status: 202, description: 'Imported; processing enqueued', schema: z.object({ id: z.string().uuid() }) }],
      errors: [
        { status: 400, description: 'Invalid input or no organization selected', schema: errorSchema },
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Missing itad.inbox.manage', schema: errorSchema },
      ],
    },
  },
}

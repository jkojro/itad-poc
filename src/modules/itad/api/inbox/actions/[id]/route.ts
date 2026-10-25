import { NextResponse } from 'next/server'
import { z } from 'zod'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { ItadInboxEditActionInput } from '../../../../data/validators'
import { runGuardedCommand } from '../../../../lib/command-route'
import { itadRouteErrorResponse, resolveItadRouteContext } from '../../../../lib/route-context'

export const metadata = {
  PUT: { requireAuth: true, requireFeatures: ['itad.inbox.manage'] },
}

const paramsSchema = z.object({ id: z.string().uuid() })
const bodySchema = z.object({ payload: z.record(z.string(), z.unknown()) })

/** Edit an Inbox action's fields (`itad.inbox.edit_action`); targets change only in the Match panel. */
export async function PUT(request: Request, { params }: { params: { id: string } }) {
  try {
    const { id } = paramsSchema.parse({ id: params?.id })
    const route = await resolveItadRouteContext(request)
    const body = bodySchema.parse((await readJsonSafe<Record<string, unknown>>(request, {})) ?? {})
    const outcome = await runGuardedCommand<ItadInboxEditActionInput, Record<string, unknown>>(route, request, {
      commandId: 'itad.inbox.edit_action',
      input: { actionId: id, payload: body.payload },
      resourceKind: 'itad.inbox_action',
      resourceId: id,
      operation: 'update',
    })
    if (!outcome.ok) return outcome.response
    return NextResponse.json(outcome.result)
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.inbox.edit_action')
  }
}

const errorSchema = z.object({ error: z.string(), code: z.string().optional() }).passthrough()

export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'Edit an ITAD Inbox action',
  methods: {
    PUT: {
      summary: 'Edit the fields of a pending Inbox action',
      description:
        'Fields per type: create_job (name, customerReference, expectedAssetEstimate, scheduledPickupAt, timeZone, pickupLocation), update_pickup (scheduledPickupAt, timeZone), resolve_exception (outcome, reason). A target key (customerId, jobId, exceptionId) is refused with `target_not_editable`. Edited fields get provenance `operator`. Send the action `updatedAt` in the lock header.',
      requestBody: { contentType: 'application/json', schema: bodySchema },
      responses: [{ status: 200, description: 'Edited', schema: z.object({ actionId: z.string().uuid(), status: z.string() }).passthrough() }],
      errors: [
        { status: 400, description: 'Invalid field or a target key', schema: errorSchema },
        { status: 403, description: 'Missing itad.inbox.manage', schema: errorSchema },
        { status: 404, description: 'Action not found in scope', schema: errorSchema },
        { status: 409, description: 'Already decided, or a stale version', schema: errorSchema },
      ],
    },
  },
}

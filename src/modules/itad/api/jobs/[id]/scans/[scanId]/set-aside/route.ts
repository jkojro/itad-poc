import { NextResponse } from 'next/server'
import { z } from 'zod'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { ItadScanActionResult } from '../../../../../../commands/assets'
import type { ItadSetAsideDuplicateInput } from '../../../../../../data/validators'
import { runGuardedCommand } from '../../../../../../lib/command-route'
import { itadRouteErrorResponse, loadReadableJob, resolveItadRouteContext } from '../../../../../../lib/route-context'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['itad.exceptions.manage'] },
}

const paramsSchema = z.object({ id: z.string().uuid(), scanId: z.string().uuid() })
const bodySchema = z.object({ reason: z.string().max(1000).nullable().optional() })

/** Closes a different-device duplicate: the second unit is set aside (`itad.assets.set_aside_duplicate`). */
export async function POST(request: Request, { params }: { params: { id: string; scanId: string } }) {
  try {
    const { id, scanId } = paramsSchema.parse({ id: params?.id, scanId: params?.scanId })
    const route = await resolveItadRouteContext(request)
    await loadReadableJob(route, id)
    const body = bodySchema.parse((await readJsonSafe<Record<string, unknown>>(request, {})) ?? {})
    const outcome = await runGuardedCommand<ItadSetAsideDuplicateInput, ItadScanActionResult>(route, request, {
      commandId: 'itad.assets.set_aside_duplicate',
      input: { jobId: id, scanId, reason: body.reason ?? null },
      resourceKind: 'itad.intake_scan',
      resourceId: scanId,
      operation: 'update',
    })
    if (!outcome.ok) return outcome.response
    return NextResponse.json({ ok: true })
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.assets.set_aside_duplicate')
  }
}

const errorSchema = z.object({ error: z.string(), code: z.string().optional() }).passthrough()

export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'Set aside the second device of a duplicate scan',
  methods: {
    POST: {
      summary: 'Set aside the second device of a different-device duplicate',
      description:
        'Only for a duplicate flagged as a different device, while the job is in receiving. The second unit gets no asset; the scan is resolved as `different_device_set_aside` and its DUPLICATE_SERIAL exception as `second_device_set_aside`. Reason required (3–1000 characters).',
      requestBody: { contentType: 'application/json', schema: bodySchema },
      responses: [{ status: 200, description: 'Set aside', schema: z.object({ ok: z.literal(true) }) }],
      errors: [
        { status: 400, description: 'Reason missing or invalid', schema: errorSchema },
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Missing itad.exceptions.manage', schema: errorSchema },
        { status: 404, description: 'Job or scan not found in scope', schema: errorSchema },
        { status: 409, description: 'Job not in receiving, or the scan is not a flagged pending duplicate', schema: errorSchema },
      ],
    },
  },
}

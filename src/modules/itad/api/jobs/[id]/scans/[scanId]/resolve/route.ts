import { NextResponse } from 'next/server'
import { z } from 'zod'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { ItadScanActionResult } from '../../../../../../commands/assets'
import type { ItadScanActionInput } from '../../../../../../data/validators'
import { runGuardedCommand } from '../../../../../../lib/command-route'
import { itadRouteErrorResponse, loadReadableJob, resolveItadRouteContext } from '../../../../../../lib/route-context'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['itad.assets.receive'] },
}

const paramsSchema = z.object({ id: z.string().uuid(), scanId: z.string().uuid() })
const bodySchema = z.object({ note: z.string().max(1000).nullable().optional() })

/** Closes a pending duplicate scan as the same device scanned again. */
export async function POST(request: Request, { params }: { params: { id: string; scanId: string } }) {
  try {
    const { id, scanId } = paramsSchema.parse({ id: params?.id, scanId: params?.scanId })
    const route = await resolveItadRouteContext(request)
    await loadReadableJob(route, id)
    const body = bodySchema.parse((await readJsonSafe<Record<string, unknown>>(request, {})) ?? {})
    const outcome = await runGuardedCommand<ItadScanActionInput, ItadScanActionResult>(route, request, {
      commandId: 'itad.assets.resolve_duplicate',
      input: { jobId: id, scanId, note: body.note ?? null },
      resourceKind: 'itad.intake_scan',
      resourceId: scanId,
      operation: 'update',
    })
    if (!outcome.ok) return outcome.response
    return NextResponse.json({ ok: true })
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.assets.resolve_duplicate')
  }
}

const errorSchema = z.object({ error: z.string(), code: z.string().optional() }).passthrough()

export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'Resolve a duplicate scan as the same device',
  methods: {
    POST: {
      summary: 'Resolve a duplicate scan as the same device',
      description: 'Closes a pending duplicate scan (also one flagged as a different device by mistake). The note is optional (3–1000 characters).',
      requestBody: { contentType: 'application/json', schema: bodySchema },
      responses: [{ status: 200, description: 'Done', schema: z.object({ ok: z.literal(true) }) }],
      errors: [
        { status: 400, description: 'Note missing or invalid', schema: errorSchema },
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Missing itad.assets.receive', schema: errorSchema },
        { status: 404, description: 'Job or scan not found in scope', schema: errorSchema },
        { status: 409, description: 'Job not in receiving, or the scan is not a pending duplicate', schema: errorSchema },
      ],
    },
  },
}

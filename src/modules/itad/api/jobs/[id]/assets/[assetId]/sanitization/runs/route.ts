import { NextResponse } from 'next/server'
import { z } from 'zod'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { ItadRunChangeResult } from '../../../../../../../commands/sanitization'
import type { ItadSanitizationStartInput } from '../../../../../../../data/validators'
import { ITAD_SANITIZATION_METHODS } from '../../../../../../../domain/sanitization-state-machine'
import { runGuardedCommand } from '../../../../../../../lib/command-route'
import { itadRouteErrorResponse, loadReadableJob, resolveItadRouteContext } from '../../../../../../../lib/route-context'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['itad.sanitization.execute'] },
}

const paramsSchema = z.object({ id: z.string().uuid(), assetId: z.string().uuid() })
const bodySchema = z.object({
  method: z.enum(ITAD_SANITIZATION_METHODS),
  methodDetail: z.string().max(500).nullable().optional(),
  tool: z.string().max(200),
  toolVersion: z.string().max(100),
})

/** Starts a sanitization run (`itad.sanitization.start`); send the asset's `updatedAt` in the lock header. */
export async function POST(request: Request, { params }: { params: { id: string; assetId: string } }) {
  try {
    const { id, assetId } = paramsSchema.parse({ id: params?.id, assetId: params?.assetId })
    const route = await resolveItadRouteContext(request)
    await loadReadableJob(route, id)
    const body = bodySchema.parse((await readJsonSafe<Record<string, unknown>>(request, {})) ?? {})
    const outcome = await runGuardedCommand<ItadSanitizationStartInput, ItadRunChangeResult>(route, request, {
      commandId: 'itad.sanitization.start',
      input: { jobId: id, assetId, ...body },
      resourceKind: 'itad.asset',
      resourceId: assetId,
      operation: 'create',
    })
    if (!outcome.ok) return outcome.response
    const { result } = outcome
    return NextResponse.json({ runId: result.runId, assetStatus: result.assetStatus, updatedAt: result.updatedAt }, { status: 201 })
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.sanitization.start')
  }
}

const errorSchema = z.object({ error: z.string(), code: z.string().optional() }).passthrough()

export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'Start an ITAD sanitization run',
  methods: {
    POST: {
      summary: 'Start a sanitization run for one asset',
      description:
        'Opens a run for an asset in `sanitization_required` while the job is in processing; the asset moves to `sanitization_in_progress`. Send the asset `updatedAt` in the `x-om-ext-optimistic-lock-expected-updated-at` header.',
      requestBody: { contentType: 'application/json', schema: bodySchema },
      responses: [
        {
          status: 201,
          description: 'Run started',
          schema: z.object({ runId: z.string().uuid(), assetStatus: z.literal('sanitization_in_progress'), updatedAt: z.string() }),
        },
      ],
      errors: [
        { status: 400, description: 'Invalid method, tool or version', schema: errorSchema },
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Missing itad.sanitization.execute', schema: errorSchema },
        { status: 404, description: 'Job or asset not found in scope', schema: errorSchema },
        { status: 409, description: 'Job not in processing, asset not waiting for sanitization, or a stale version', schema: errorSchema },
      ],
    },
  },
}

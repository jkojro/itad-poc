import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import {
  runCrudMutationGuardAfterSuccess,
  validateCrudMutationGuard,
} from '@open-mercato/shared/lib/crud/mutation-guard'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { ItadManifestItemDeleteResult } from '../../../../../../commands/manifest'
import type { ItadManifestItemDeleteInput } from '../../../../../../data/validators'
import { itadRouteErrorResponse, loadReadableJob, resolveItadRouteContext } from '../../../../../../lib/route-context'

export const metadata = {
  DELETE: { requireAuth: true, requireFeatures: ['itad.manifest.manage'] },
}

const paramsSchema = z.object({ id: z.string().uuid(), itemId: z.string().uuid() })
const bodySchema = z.object({ reason: z.string().max(1000).nullable().optional() })

const MANIFEST_ITEM_RESOURCE_KIND = 'itad.manifest_item'

/** Removes one manifest item through `itad.manifest.delete_item` (reason required while receiving). */
export async function DELETE(request: Request, { params }: { params: { id: string; itemId: string } }) {
  try {
    const { id, itemId } = paramsSchema.parse({ id: params?.id, itemId: params?.itemId })
    const route = await resolveItadRouteContext(request)
    await loadReadableJob(route, id)
    const body = bodySchema.parse((await readJsonSafe<Record<string, unknown>>(request, {})) ?? {})
    const input: ItadManifestItemDeleteInput = { jobId: id, itemId, reason: body.reason ?? null }

    const guardInput = {
      tenantId: route.tenantId,
      organizationId: route.ctx.selectedOrganizationId ?? null,
      userId: route.userId,
      resourceKind: MANIFEST_ITEM_RESOURCE_KIND,
      resourceId: itemId,
      operation: 'delete' as const,
      requestMethod: request.method,
      requestHeaders: request.headers,
    }
    const guardResult = await validateCrudMutationGuard(route.container, { ...guardInput, mutationPayload: input })
    if (guardResult && !guardResult.ok) {
      return NextResponse.json(guardResult.body, { status: guardResult.status })
    }

    const commandBus = route.container.resolve<CommandBus>('commandBus')
    await commandBus.execute<ItadManifestItemDeleteInput, ItadManifestItemDeleteResult>('itad.manifest.delete_item', {
      input,
      ctx: route.ctx,
    })

    if (guardResult?.ok && guardResult.shouldRunAfterSuccess) {
      await runCrudMutationGuardAfterSuccess(route.container, { ...guardInput, metadata: guardResult.metadata ?? null })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.manifest.items.delete')
  }
}

const errorSchema = z.object({ error: z.string(), code: z.string().optional() }).passthrough()

export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'ITAD manifest item',
  methods: {
    DELETE: {
      summary: 'Remove a manifest item',
      description:
        'Soft-deletes one expected device. A reason (3–1000 characters) is required while the job is in receiving (also when held from receiving) and is shown in the job history.',
      requestBody: { contentType: 'application/json', schema: bodySchema },
      responses: [{ status: 200, description: 'Removed', schema: z.object({ ok: z.literal(true) }) }],
      errors: [
        { status: 400, description: 'Reason missing or invalid', schema: errorSchema },
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Missing itad.manifest.manage', schema: errorSchema },
        { status: 404, description: 'Job or item not found in scope', schema: errorSchema },
        { status: 409, description: 'Manifest locked in the current job status', schema: errorSchema },
      ],
    },
  },
}

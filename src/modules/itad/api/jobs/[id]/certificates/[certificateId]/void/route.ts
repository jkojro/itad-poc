import { NextResponse } from 'next/server'
import { z } from 'zod'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { ItadCertificateVoidResult } from '../../../../../../commands/certificates'
import type { ItadCertificateVoidInput } from '../../../../../../data/validators'
import { runGuardedCommand } from '../../../../../../lib/command-route'
import { itadRouteErrorResponse, loadReadableJob, resolveItadRouteContext } from '../../../../../../lib/route-context'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['itad.certificates.manage'] },
}

const paramsSchema = z.object({ id: z.string().uuid(), certificateId: z.string().uuid() })
const bodySchema = z.object({ reason: z.string().max(2000).nullable().optional() })

/** Voids an issued certificate (`itad.certificates.void`); lock header expected. */
export async function POST(request: Request, { params }: { params: { id: string; certificateId: string } }) {
  try {
    const { id, certificateId } = paramsSchema.parse({ id: params?.id, certificateId: params?.certificateId })
    const route = await resolveItadRouteContext(request)
    await loadReadableJob(route, id)
    const body = bodySchema.parse((await readJsonSafe<Record<string, unknown>>(request, {})) ?? {})
    const outcome = await runGuardedCommand<ItadCertificateVoidInput, ItadCertificateVoidResult>(route, request, {
      commandId: 'itad.certificates.void',
      input: { jobId: id, certificateId, reason: body.reason ?? '' },
      resourceKind: 'itad.certificate',
      resourceId: certificateId,
      operation: 'update',
    })
    if (!outcome.ok) return outcome.response
    return NextResponse.json({ id: outcome.result.certificateId, status: outcome.result.status, updatedAt: outcome.result.updatedAt })
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.certificates.void')
  }
}

const errorSchema = z.object({ error: z.string(), code: z.string().optional() }).passthrough()

export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'Void an ITAD certificate',
  methods: {
    POST: {
      summary: 'Void an issued certificate',
      description:
        'Sets an issued certificate to `void` with a required reason (3–1000 characters). The snapshot and the PDF stay. If the asset still requires a certificate, it counts as missing again. Send the certificate `updatedAt` in the `x-om-ext-optimistic-lock-expected-updated-at` header.',
      requestBody: { contentType: 'application/json', schema: bodySchema },
      responses: [
        { status: 200, description: 'Voided', schema: z.object({ id: z.string().uuid(), status: z.literal('void'), updatedAt: z.string() }) },
      ],
      errors: [
        { status: 400, description: 'reason_required', schema: errorSchema },
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Missing itad.certificates.manage', schema: errorSchema },
        { status: 404, description: 'Job or certificate not found in scope', schema: errorSchema },
        { status: 409, description: 'certificate_not_issued, certificate_not_eligible (job_status), or a stale version', schema: errorSchema },
      ],
    },
  },
}

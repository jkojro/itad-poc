import { NextResponse } from 'next/server'
import { z } from 'zod'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { ItadCertificateReissueResult } from '../../../../../../commands/certificates'
import type { ItadCertificateReissueInput } from '../../../../../../data/validators'
import { CERTIFICATE_LOCALES } from '../../../../../../domain/certificates'
import { certificateError } from '../../../../../../lib/certificate-errors'
import { runGuardedCommand } from '../../../../../../lib/command-route'
import { itadRouteErrorResponse, loadReadableJob, resolveItadRouteContext } from '../../../../../../lib/route-context'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['itad.certificates.manage'] },
}

const paramsSchema = z.object({ id: z.string().uuid(), certificateId: z.string().uuid() })
const bodySchema = z.object({
  reason: z.string().max(2000).nullable().optional(),
  locale: z.string().max(8).optional(),
  previewHash: z.string().max(128).optional(),
})

/** Reissues an issued certificate (`itad.certificates.reissue`); lock header expected. */
export async function POST(request: Request, { params }: { params: { id: string; certificateId: string } }) {
  try {
    const { id, certificateId } = paramsSchema.parse({ id: params?.id, certificateId: params?.certificateId })
    const route = await resolveItadRouteContext(request)
    await loadReadableJob(route, id)
    const body = bodySchema.parse((await readJsonSafe<Record<string, unknown>>(request, {})) ?? {})
    const locale = CERTIFICATE_LOCALES.find((entry) => entry === body.locale)
    if (!locale) return await certificateError('locale_invalid')
    const outcome = await runGuardedCommand<ItadCertificateReissueInput, ItadCertificateReissueResult>(route, request, {
      commandId: 'itad.certificates.reissue',
      input: { jobId: id, certificateId, locale, reason: body.reason ?? '', previewHash: body.previewHash ?? '' },
      resourceKind: 'itad.certificate',
      resourceId: certificateId,
      operation: 'update',
    })
    if (!outcome.ok) return outcome.response
    return NextResponse.json(
      {
        id: outcome.result.certificateId,
        certificateNumber: outcome.result.certificateNumber,
        supersededCertificateId: outcome.result.supersededCertificateId,
      },
      { status: 201 },
    )
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.certificates.reissue')
  }
}

const errorSchema = z.object({ error: z.string(), code: z.string().optional() }).passthrough()

export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'Reissue an ITAD certificate',
  methods: {
    POST: {
      summary: 'Reissue a certificate with a fresh snapshot',
      description:
        'Supersedes the issued certificate and issues a new one with a new number from the current source data, in one transaction with the new PDF. A reason (3–1000 characters) and the `previewHash` from the reissue preview are required; if the source data changed since the preview, 409 `certificate_preview_stale`. Send the certificate `updatedAt` in the `x-om-ext-optimistic-lock-expected-updated-at` header.',
      requestBody: { contentType: 'application/json', schema: bodySchema },
      responses: [
        {
          status: 201,
          description: 'Reissued',
          schema: z.object({ id: z.string().uuid(), certificateNumber: z.string(), supersededCertificateId: z.string().uuid() }),
        },
      ],
      errors: [
        { status: 400, description: 'reason_required or locale_invalid', schema: errorSchema },
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Missing itad.certificates.manage', schema: errorSchema },
        { status: 404, description: 'Job or certificate not found in scope', schema: errorSchema },
        {
          status: 409,
          description: 'certificate_not_issued, certificate_not_eligible (with detail), certificate_preview_stale, or a stale version',
          schema: errorSchema,
        },
        { status: 422, description: 'certificate_unprintable_characters (with fields)', schema: errorSchema },
      ],
    },
  },
}

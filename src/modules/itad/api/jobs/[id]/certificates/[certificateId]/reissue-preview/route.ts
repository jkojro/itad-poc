import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import { CERTIFICATE_SOURCE_FIELDS, decideCertificateChange } from '../../../../../../domain/certificates'
import { certificateError } from '../../../../../../lib/certificate-errors'
import { itadRouteErrorResponse, loadReadableJob, resolveItadRouteContext } from '../../../../../../lib/route-context'
import { findCertificate, loadReissueSource } from '../../../../../../services/certificate-reader'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['itad.certificates.manage'] },
}

const paramsSchema = z.object({ id: z.string().uuid(), certificateId: z.string().uuid() })

/**
 * What a reissue would carry now (certificates spec "Reissue preview"): source data,
 * differences against the current certificate and the `previewHash`. Writes nothing and
 * has no number, issue time or issuer.
 */
export async function GET(request: Request, { params }: { params: { id: string; certificateId: string } }) {
  try {
    const { id, certificateId } = paramsSchema.parse({ id: params?.id, certificateId: params?.certificateId })
    const route = await resolveItadRouteContext(request)
    const job = await loadReadableJob(route, id)
    const scope = { tenantId: route.tenantId, organizationId: job.organizationId }
    const em = route.container.resolve<EntityManager>('em').fork()
    const certificate = await findCertificate(em, scope, job.id, certificateId)
    if (!certificate) return await certificateError('certificate_not_found')
    const change = decideCertificateChange(certificate, job, 'reissue')
    if (!change.ok) {
      return change.code === 'certificate_not_issued'
        ? await certificateError('certificate_not_issued')
        : await certificateError('certificate_not_eligible', { detail: change.detail })
    }
    const reissue = await loadReissueSource(em, route.container.resolve<QueryEngine>('queryEngine'), scope, job, certificate)
    if (!reissue.ok) {
      return reissue.decision.code === 'certificate_already_issued'
        ? await certificateError('certificate_already_issued')
        : await certificateError('certificate_not_eligible', { detail: reissue.decision.detail })
    }
    return NextResponse.json(reissue.preview)
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.certificates.reissue_preview')
  }
}

const errorSchema = z.object({ error: z.string(), code: z.string().optional() }).passthrough()
const sourceValue = z.union([z.string(), z.array(z.string()), z.null()])

export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'ITAD certificate reissue preview',
  methods: {
    GET: {
      summary: 'Preview the data a reissue would carry',
      description:
        'Builds the source data from the current job, asset and latest PASS run, lists the differences against the current certificate and returns a `previewHash` to send with the reissue. Writes nothing; there is no number, issue time or issuer.',
      responses: [
        {
          status: 200,
          description: 'Preview',
          schema: z.object({
            certificateId: z.string().uuid(),
            certificateNumber: z.string(),
            source: z.record(z.string(), sourceValue),
            differences: z.array(z.object({ field: z.enum(CERTIFICATE_SOURCE_FIELDS), from: sourceValue, to: sourceValue })),
            previewHash: z.string(),
          }),
        },
      ],
      errors: [
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Missing itad.certificates.manage', schema: errorSchema },
        { status: 404, description: 'Job or certificate not found in scope', schema: errorSchema },
        { status: 409, description: 'certificate_not_issued or certificate_not_eligible (with detail)', schema: errorSchema },
      ],
    },
  },
}

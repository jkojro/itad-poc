import { z } from 'zod'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { ItadCertificate } from '../../../../../../data/entities'
import { certificateError } from '../../../../../../lib/certificate-errors'
import { ITAD_JOB_ENTITY_ID } from '../../../../../../lib/constants'
import { itadRouteErrorResponse, loadReadableJob, resolveItadRouteContext } from '../../../../../../lib/route-context'
import { resolveAttachmentService } from '../../../../../../module-integrations/attachments'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['itad.certificates.view'] },
}

const paramsSchema = z.object({ id: z.string().uuid(), certificateId: z.string().uuid() })

/** The certificate PDF exactly as stored at issue (REQ-619); reading changes nothing (REQ-620). */
export async function GET(request: Request, { params }: { params: { id: string; certificateId: string } }) {
  try {
    const { id, certificateId } = paramsSchema.parse({ id: params?.id, certificateId: params?.certificateId })
    const route = await resolveItadRouteContext(request)
    const job = await loadReadableJob(route, id)
    const em = route.container.resolve<EntityManager>('em').fork()
    const certificate = await em.findOne(ItadCertificate, {
      id: certificateId,
      tenantId: route.tenantId,
      organizationId: job.organizationId,
      job: job.id,
    } as FilterQuery<ItadCertificate>)
    if (!certificate) return await certificateError('certificate_not_found')
    const auth = route.ctx.auth
    if (!auth) throw new Error('[internal] Authenticated route without auth context')
    const file = await resolveAttachmentService(route.container).readScoped({
      attachmentId: certificate.pdfAttachmentId,
      auth: { ...auth, orgId: job.organizationId },
      expectedOwner: { entityId: ITAD_JOB_ENTITY_ID, recordId: job.id },
      requirePrivatePartition: true,
      forceDownload: false,
    })
    return new Response(new Uint8Array(file.buffer), {
      status: 200,
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `inline; filename="${certificate.certificateNumber}.pdf"`,
        'cache-control': 'private, no-store',
      },
    })
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.certificates.pdf')
  }
}

const errorSchema = z.object({ error: z.string(), code: z.string().optional() }).passthrough()

export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'ITAD certificate PDF',
  methods: {
    GET: {
      summary: 'Download a certificate PDF',
      description: 'The PDF bytes stored when the certificate was issued, for any status (issued, superseded, void).',
      responses: [{ status: 200, description: 'PDF', schema: z.string().describe('application/pdf') }],
      errors: [
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Missing itad.certificates.view', schema: errorSchema },
        { status: 404, description: 'Job or certificate not found in scope', schema: errorSchema },
      ],
    },
  },
}

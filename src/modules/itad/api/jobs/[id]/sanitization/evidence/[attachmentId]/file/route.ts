import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { notFound } from '@open-mercato/shared/lib/crud/errors'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { ITAD_JOB_ENTITY_ID } from '../../../../../../../lib/constants'
import { itadRouteErrorResponse, loadReadableJob, resolveItadRouteContext } from '../../../../../../../lib/route-context'
import { resolveAttachmentService } from '../../../../../../../module-integrations/attachments'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['itad.sanitization.view'] },
}

const paramsSchema = z.object({ id: z.string().uuid(), attachmentId: z.string().uuid() })

/** Downloads an evidence file; only files linked to a run of this job are served. */
export async function GET(request: Request, { params }: { params: { id: string; attachmentId: string } }) {
  try {
    const { id, attachmentId } = paramsSchema.parse({ id: params?.id, attachmentId: params?.attachmentId })
    const route = await resolveItadRouteContext(request)
    const job = await loadReadableJob(route, id)
    const em = route.container.resolve<EntityManager>('em').fork()
    const linked = await em.execute<{ found: number }>(
      `select 1 as "found" from "itad_sanitization_evidence"
       where "tenant_id" = ? and "organization_id" = ? and "job_id" = ? and "attachment_id" = ? limit 1`,
      [route.tenantId, job.organizationId, job.id, attachmentId],
      'get',
    )
    if (!linked) {
      const { translate } = await resolveTranslations()
      throw notFound(translate('itad.sanitization.errors.evidence_not_found', 'Evidence file not found'))
    }
    const auth = route.ctx.auth
    if (!auth) throw new Error('[internal] Authenticated route without auth context')
    const file = await resolveAttachmentService(route.container).readScoped({
      attachmentId,
      auth: { ...auth, orgId: job.organizationId },
      expectedOwner: { entityId: ITAD_JOB_ENTITY_ID, recordId: job.id },
      requirePrivatePartition: true,
      forceDownload: true,
    })
    return new Response(new Uint8Array(file.buffer), {
      status: 200,
      headers: {
        'content-type': file.contentType,
        'content-disposition': file.contentDisposition,
        'cache-control': 'private, no-store',
      },
    })
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.sanitization.evidence.file')
  }
}

const errorSchema = z.object({ error: z.string(), code: z.string().optional() }).passthrough()

export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'Download ITAD sanitization evidence',
  methods: {
    GET: {
      summary: 'Download one evidence file of a job',
      description: 'Byte-for-byte file as uploaded. Only files linked to a sanitization run of this job are served.',
      responses: [{ status: 200, description: 'File', schema: z.string().describe('Binary file') }],
      errors: [
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Missing itad.sanitization.view', schema: errorSchema },
        { status: 404, description: 'Job or file not found in scope', schema: errorSchema },
      ],
    },
  },
}

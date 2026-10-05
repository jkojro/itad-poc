import { z } from 'zod'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { notFound } from '@open-mercato/shared/lib/crud/errors'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { ItadManifestImport } from '../../../../../../../data/entities'
import { ITAD_MANIFEST_IMPORT_ENTITY_ID } from '../../../../../../../lib/constants'
import { itadRouteErrorResponse, loadReadableJob, resolveItadRouteContext } from '../../../../../../../lib/route-context'
import { resolveAttachmentService } from '../../../../../../../module-integrations/attachments'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['itad.manifest.view'] },
}

const paramsSchema = z.object({ id: z.string().uuid(), importId: z.string().uuid() })

/** Downloads the byte-for-byte original manifest file of one import. */
export async function GET(request: Request, { params }: { params: { id: string; importId: string } }) {
  try {
    const { id, importId } = paramsSchema.parse({ id: params?.id, importId: params?.importId })
    const route = await resolveItadRouteContext(request)
    const job = await loadReadableJob(route, id)
    const em = route.container.resolve<EntityManager>('em').fork()
    const record = await em.findOne(ItadManifestImport, {
      id: importId,
      tenantId: route.tenantId,
      organizationId: job.organizationId,
      job: job.id,
    } as FilterQuery<ItadManifestImport>)
    if (!record) {
      const { translate } = await resolveTranslations()
      throw notFound(translate('itad.manifest.errors.import_not_found', 'Manifest import not found'))
    }
    const auth = route.ctx.auth
    if (!auth) throw new Error('[internal] Authenticated route without auth context')
    // The job (and so the import) was already checked against the request scope; the
    // attachment service re-checks tenant/organization and the owning record.
    const file = await resolveAttachmentService(route.container).readScoped({
      attachmentId: record.attachmentId,
      auth: { ...auth, orgId: job.organizationId },
      expectedOwner: { entityId: ITAD_MANIFEST_IMPORT_ENTITY_ID, recordId: record.id },
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
    return itadRouteErrorResponse(err, 'itad.manifest.imports.file')
  }
}

const errorSchema = z.object({ error: z.string(), code: z.string().optional() }).passthrough()

export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'ITAD manifest original file',
  methods: {
    GET: {
      summary: 'Download the original manifest file of an import',
      description: 'Returns the uploaded file byte for byte as an attachment download.',
      responses: [{ status: 200, description: 'File content', schema: z.string().describe('Binary file') }],
      errors: [
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Missing itad.manifest.view', schema: errorSchema },
        { status: 404, description: 'Job, import or file not found in scope', schema: errorSchema },
      ],
    },
  },
}

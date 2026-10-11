import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import { runCrudMutationGuardAfterSuccess, validateCrudMutationGuard } from '@open-mercato/shared/lib/crud/mutation-guard'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { ITAD_EVIDENCE_UPLOAD_CONTEXT, type ItadEvidenceResult } from '../../../../../commands/sanitization'
import type { ItadSanitizationEvidenceInput } from '../../../../../data/validators'
import { itadRouteErrorResponse, jobIdParamsSchema, loadReadableJob, resolveItadRouteContext } from '../../../../../lib/route-context'
import { sanitizationError } from '../../../../../lib/sanitization-errors'
import { readAttachmentUploadForm, resolveAttachmentService } from '../../../../../module-integrations/attachments'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['itad.sanitization.execute'] },
}

/**
 * Uploads one evidence file and links it to runs of the job
 * (`itad.sanitization.attach_evidence`). Multipart: `file` and one or more `runIds`.
 */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const { id } = jobIdParamsSchema.parse({ id: params?.id })
    const route = await resolveItadRouteContext(request)
    await loadReadableJob(route, id)
    const attachments = resolveAttachmentService(route.container)
    const form = await readAttachmentUploadForm(attachments, request)
    const file = form.get('file')
    if (!(file instanceof File)) return await sanitizationError(400, 'evidence_file_required')
    attachments.validateUpload({ fileName: file.name, fileSize: file.size })
    const runIds = form.getAll('runIds').filter((value): value is string => typeof value === 'string' && value.length > 0)
    const buffer = Buffer.from(await file.arrayBuffer())
    const input: ItadSanitizationEvidenceInput = {
      jobId: id,
      runIds,
      fileName: file.name,
      fileType: file.type || null,
      fileSize: buffer.byteLength,
    }

    const guardInput = {
      tenantId: route.tenantId,
      organizationId: route.ctx.selectedOrganizationId ?? null,
      userId: route.userId,
      resourceKind: 'itad.sanitization_evidence',
      resourceId: id,
      operation: 'create' as const,
      requestMethod: request.method,
      requestHeaders: request.headers,
    }
    const guardResult = await validateCrudMutationGuard(route.container, { ...guardInput, mutationPayload: input })
    if (guardResult && !guardResult.ok) return NextResponse.json(guardResult.body, { status: guardResult.status })
    // The bytes ride in the runtime context, outside the durable (audited) command input.
    const commandContext = { ...route.ctx, [ITAD_EVIDENCE_UPLOAD_CONTEXT]: { buffer } }
    const commandBus = route.container.resolve<CommandBus>('commandBus')
    const { result } = await commandBus.execute<ItadSanitizationEvidenceInput, ItadEvidenceResult>('itad.sanitization.attach_evidence', {
      input,
      ctx: commandContext,
    })
    if (guardResult?.ok && guardResult.shouldRunAfterSuccess) {
      await runCrudMutationGuardAfterSuccess(route.container, { ...guardInput, metadata: guardResult.metadata ?? null })
    }
    return NextResponse.json({ attachmentId: result.attachmentId, fileName: result.fileName, runIds: result.runIds }, { status: 201 })
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.sanitization.evidence')
  }
}

const errorSchema = z.object({ error: z.string(), code: z.string().optional() }).passthrough()

export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'Attach ITAD sanitization evidence',
  methods: {
    POST: {
      summary: 'Upload one evidence file and link it to sanitization runs',
      description:
        'Multipart form-data: `file` (at most 10 MB) and `runIds` (1–200, repeated). The file is stored once, owned by the job, and linked to every listed run of this job. Not possible for completed or cancelled jobs.',
      requestBody: {
        contentType: 'multipart/form-data',
        schema: z.object({ file: z.string().describe('Evidence file'), runIds: z.array(z.string().uuid()).describe('Runs to link') }),
      },
      responses: [
        {
          status: 201,
          description: 'Evidence attached',
          schema: z.object({ attachmentId: z.string().uuid(), fileName: z.string(), runIds: z.array(z.string().uuid()) }),
        },
      ],
      errors: [
        { status: 400, description: 'File missing, too large or invalid run list', schema: errorSchema },
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Missing itad.sanitization.execute', schema: errorSchema },
        { status: 404, description: 'Job not found in scope', schema: errorSchema },
        { status: 409, description: 'Job completed or cancelled, or runs not found in this job (`runIds`)', schema: errorSchema },
      ],
    },
  },
}

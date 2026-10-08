import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import {
  runCrudMutationGuardAfterSuccess,
  validateCrudMutationGuard,
} from '@open-mercato/shared/lib/crud/mutation-guard'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import { ITAD_MANIFEST_UPLOAD_CONTEXT, type ItadManifestImportResult } from '../../../../../commands/manifest'
import { ItadManifestImport } from '../../../../../data/entities'
import type { ItadManifestImportInput } from '../../../../../data/validators'
import { ITAD_JOB_STATUSES } from '../../../../../domain/job-types'
import { manifestError } from '../../../../../lib/manifest-errors'
import { manifestUploadBodySchema, readManifestUpload } from '../../../../../lib/manifest-upload'
import {
  itadRouteErrorResponse,
  jobIdParamsSchema,
  loadReadableJob,
  resolveItadRouteContext,
} from '../../../../../lib/route-context'
import { resolveAttachmentService } from '../../../../../module-integrations/attachments'
import { loadUserDisplayNames } from '../../../../../module-integrations/users'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['itad.manifest.view'] },
  POST: { requireAuth: true, requireFeatures: ['itad.manifest.manage'] },
}

const MANIFEST_IMPORT_RESOURCE_KIND = 'itad.manifest_import'

/** Imports of one job, newest first, with the importer's display name. */
export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    const { id } = jobIdParamsSchema.parse({ id: params?.id })
    const route = await resolveItadRouteContext(request)
    const job = await loadReadableJob(route, id)
    const em = route.container.resolve<EntityManager>('em').fork()
    const imports = await em.find(
      ItadManifestImport,
      { tenantId: route.tenantId, organizationId: job.organizationId, job: job.id } as FilterQuery<ItadManifestImport>,
      { orderBy: { createdAt: 'desc' } },
    )
    const names = await loadUserDisplayNames(
      route.container.resolve<QueryEngine>('queryEngine'),
      route.tenantId,
      imports.map((entry) => entry.importedByUserId),
    )
    return NextResponse.json({
      items: imports.map((entry) => ({
        id: entry.id,
        fileName: entry.fileName,
        format: entry.format,
        sheetName: entry.sheetName ?? null,
        totalRows: entry.totalRows,
        importedCount: entry.importedCount,
        skippedCount: entry.skippedCount,
        warningCount: entry.warnings.length,
        unusedColumns: entry.mapping.unused,
        importedBy: { id: entry.importedByUserId, name: names.get(entry.importedByUserId) ?? null },
        jobStatusAtChange: entry.jobStatusAtChange,
        createdAt: entry.createdAt.toISOString(),
      })),
    })
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.manifest.imports.get')
  }
}

/** Imports a previewed file through the `itad.manifest.import` command (spec "Import flow", step 3). */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const { id } = jobIdParamsSchema.parse({ id: params?.id })
    const route = await resolveItadRouteContext(request)
    await loadReadableJob(route, id)
    const upload = await readManifestUpload(resolveAttachmentService(route.container), request)
    if (!upload.mapping) return await manifestError(400, 'mapping_invalid')
    if (!upload.expectedSha256 || !/^[a-f0-9]{64}$/.test(upload.expectedSha256)) return await manifestError(400, 'file_changed')

    const input: ItadManifestImportInput = {
      jobId: id,
      fileName: upload.fileName,
      fileType: upload.fileType,
      fileSize: upload.buffer.byteLength,
      mapping: upload.mapping,
      sheet: upload.sheet,
      expectedSha256: upload.expectedSha256,
      acceptWarnings: upload.acceptWarnings,
    }
    const guardInput = {
      tenantId: route.tenantId,
      organizationId: route.ctx.selectedOrganizationId ?? null,
      userId: route.userId,
      resourceKind: MANIFEST_IMPORT_RESOURCE_KIND,
      resourceId: id,
      operation: 'create' as const,
      requestMethod: request.method,
      requestHeaders: request.headers,
    }
    const guardResult = await validateCrudMutationGuard(route.container, { ...guardInput, mutationPayload: input })
    if (guardResult && !guardResult.ok) {
      return NextResponse.json(guardResult.body, { status: guardResult.status })
    }

    // The bytes ride in the runtime context, outside the durable (audited) command input.
    const commandContext = { ...route.ctx, [ITAD_MANIFEST_UPLOAD_CONTEXT]: { buffer: upload.buffer } }
    const commandBus = route.container.resolve<CommandBus>('commandBus')
    const { result } = await commandBus.execute<ItadManifestImportInput, ItadManifestImportResult>('itad.manifest.import', {
      input,
      ctx: commandContext,
    })

    if (guardResult?.ok && guardResult.shouldRunAfterSuccess) {
      await runCrudMutationGuardAfterSuccess(route.container, { ...guardInput, metadata: guardResult.metadata ?? null })
    }
    return NextResponse.json(
      {
        importId: result.importId,
        importedCount: result.importedCount,
        skippedCount: result.skippedCount,
        skippedRows: result.skippedRows,
      },
      { status: 201 },
    )
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.manifest.imports.post')
  }
}

const importListSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().uuid(),
      fileName: z.string(),
      format: z.enum(['csv', 'xlsx']),
      sheetName: z.string().nullable(),
      totalRows: z.number().int(),
      importedCount: z.number().int(),
      skippedCount: z.number().int(),
      warningCount: z.number().int(),
      unusedColumns: z.array(z.string()),
      importedBy: z.object({ id: z.string().uuid(), name: z.string().nullable() }),
      jobStatusAtChange: z.enum(ITAD_JOB_STATUSES),
      createdAt: z.string(),
    }),
  ),
})

const importResultSchema = z.object({
  importId: z.string().uuid(),
  importedCount: z.number().int(),
  skippedCount: z.number().int(),
  skippedRows: z.array(z.object({ row: z.number().int(), serial: z.string() })),
})

const errorSchema = z.object({ error: z.string(), code: z.string().optional() }).passthrough()

export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'ITAD manifest imports',
  methods: {
    GET: {
      summary: 'List manifest imports of a job',
      description: 'Committed imports, newest first, with counts, unused source columns and the importer.',
      responses: [{ status: 200, description: 'Imports', schema: importListSchema }],
      errors: [
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Missing itad.manifest.view', schema: errorSchema },
        { status: 404, description: 'Job not found in scope', schema: errorSchema },
      ],
    },
    POST: {
      summary: 'Import a manifest file into a job',
      description:
        'Re-validates the previewed file and stores it (attachment), the import record and one manifest item per new row in one transaction. Invalid rows block the import; warnings must be accepted; rows whose serial is already in the job are skipped.',
      requestBody: { contentType: 'multipart/form-data', schema: manifestUploadBodySchema },
      responses: [{ status: 201, description: 'Imported', schema: importResultSchema }],
      errors: [
        {
          status: 400,
          description: 'File error, invalid mapping, invalid rows (`rowErrors`), unaccepted warnings, or file changed since preview',
          schema: errorSchema,
        },
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Missing itad.manifest.manage', schema: errorSchema },
        { status: 404, description: 'Job not found in scope', schema: errorSchema },
        { status: 409, description: 'Manifest locked, or the same file and sheet already imported', schema: errorSchema },
        { status: 413, description: 'File exceeds the attachment upload limit', schema: errorSchema },
      ],
    },
  },
}

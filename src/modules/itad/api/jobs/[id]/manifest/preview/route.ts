import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { assertManifestEditable, manifestError } from '../../../../../lib/manifest-errors'
import { MANIFEST_LIMITS, type ManifestFieldMapping } from '../../../../../domain/manifest-mapping'
import { manifestUploadBodySchema, readManifestUpload } from '../../../../../lib/manifest-upload'
import {
  itadRouteErrorResponse,
  jobIdParamsSchema,
  loadReadableJob,
  resolveItadRouteContext,
} from '../../../../../lib/route-context'
import { resolveAttachmentService } from '../../../../../module-integrations/attachments'
import { prepareManifest } from '../../../../../services/manifest-import'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['itad.manifest.manage'] },
}

/** Stateless preview: parses the file and validates every row; stores nothing (spec "Import flow", step 1). */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const { id } = jobIdParamsSchema.parse({ id: params?.id })
    const route = await resolveItadRouteContext(request)
    const job = await loadReadableJob(route, id)
    await assertManifestEditable(job)
    const upload = await readManifestUpload(resolveAttachmentService(route.container), request)

    const em = route.container.resolve<EntityManager>('em').fork()
    const result = await prepareManifest({
      em,
      scope: { tenantId: route.tenantId, organizationId: job.organizationId },
      jobId: job.id,
      fileName: upload.fileName,
      buffer: upload.buffer,
      mapping: upload.mapping as ManifestFieldMapping | null,
    })
    if (!result.ok) return await manifestError(400, result.code)
    const { prepared } = result
    const evaluation = prepared.evaluation

    return NextResponse.json({
      format: prepared.format,
      sha256: prepared.sha256,
      sheets: prepared.sheets,
      sheetName: prepared.sheetName,
      columns: prepared.table.columns,
      suggestedMapping: prepared.suggestedMapping,
      mapping: prepared.mapping,
      mappingError: prepared.mappingError,
      unusedColumns: prepared.unusedColumns,
      totalRows: prepared.table.rows.length,
      counts: evaluation?.counts ?? null,
      rows: (evaluation?.rows ?? []).slice(0, MANIFEST_LIMITS.previewRows).map((row) => ({
        rowNumber: row.rowNumber,
        state: row.state,
        serial: row.serial,
        customerAssetTag: row.customerAssetTag,
        manufacturer: row.manufacturer,
        model: row.model,
        errors: row.errors,
      })),
      errors: (evaluation?.errors ?? []).slice(0, MANIFEST_LIMITS.maxReportedErrors),
      errorCount: evaluation?.errors.length ?? 0,
      warnings: (evaluation?.warnings ?? []).slice(0, MANIFEST_LIMITS.maxReportedErrors),
      warningCount: evaluation?.warnings.length ?? 0,
    })
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.manifest.preview')
  }
}

const mappingSchema = z.object({
  serial: z.string().optional(),
  customerAssetTag: z.string().optional(),
  manufacturer: z.string().optional(),
  model: z.string().optional(),
})
const issueSchema = z.object({ row: z.number().int(), code: z.string(), column: z.string().optional() })

export const manifestPreviewResponseSchema = z.object({
  format: z.enum(['csv', 'xlsx']),
  sha256: z.string(),
  sheets: z.array(z.string()),
  sheetName: z.string().nullable(),
  columns: z.array(z.string()),
  suggestedMapping: mappingSchema,
  mapping: mappingSchema,
  mappingError: z.enum(['serial_required', 'unknown_column', 'column_used_twice']).nullable(),
  unusedColumns: z.array(z.string()),
  totalRows: z.number().int(),
  counts: z
    .object({ valid: z.number(), invalid: z.number(), skippedExisting: z.number(), blankIgnored: z.number() })
    .nullable(),
  rows: z.array(
    z.object({
      rowNumber: z.number().int(),
      state: z.enum(['valid', 'invalid', 'skipped_existing']),
      serial: z.string().nullable(),
      customerAssetTag: z.string().nullable(),
      manufacturer: z.string().nullable(),
      model: z.string().nullable(),
      errors: z.array(z.string()),
    }),
  ),
  errors: z.array(issueSchema),
  errorCount: z.number().int(),
  warnings: z.array(issueSchema),
  warningCount: z.number().int(),
})

const errorSchema = z.object({ error: z.string(), code: z.string().optional() }).passthrough()

export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'ITAD manifest preview',
  methods: {
    POST: {
      summary: 'Preview a manifest file before importing it',
      description:
        'Parses the uploaded file, suggests or applies a column mapping, and validates every row against the job manifest. Stores nothing.',
      requestBody: { contentType: 'multipart/form-data', schema: manifestUploadBodySchema },
      responses: [{ status: 200, description: 'Preview', schema: manifestPreviewResponseSchema }],
      errors: [
        { status: 400, description: 'Missing, unreadable, empty or oversized file; invalid mapping', schema: errorSchema },
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Missing itad.manifest.manage', schema: errorSchema },
        { status: 404, description: 'Job not found in scope', schema: errorSchema },
        { status: 409, description: 'Manifest locked in the current job status', schema: errorSchema },
      ],
    },
  },
}

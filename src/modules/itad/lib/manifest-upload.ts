import { z } from 'zod'
import { itadManifestMappingSchema, type ItadManifestMappingInput } from '../data/validators'
import { manifestError } from './manifest-errors'
import { readAttachmentUploadForm, type AttachmentServicePort } from '../module-integrations/attachments'

/** Parsed multipart body shared by the manifest preview and import routes. */
export type ManifestUpload = {
  fileName: string
  fileType: string | null
  buffer: Buffer
  mapping: ItadManifestMappingInput | null
  sheet: string | null
  expectedSha256: string | null
  acceptWarnings: boolean
}

function readText(form: FormData, key: string): string | null {
  const value = form.get(key)
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export async function readManifestUpload(service: AttachmentServicePort, request: Request): Promise<ManifestUpload> {
  const form = await readAttachmentUploadForm(service, request)
  const file = form.get('file')
  if (!(file instanceof File)) return await manifestError(400, 'file_required')
  service.validateUpload({ fileName: file.name, fileSize: file.size })

  let mapping: ItadManifestMappingInput | null = null
  const rawMapping = readText(form, 'mapping')
  if (rawMapping) {
    let parsed: unknown
    try {
      parsed = JSON.parse(rawMapping)
    } catch {
      return await manifestError(400, 'mapping_invalid')
    }
    const result = itadManifestMappingSchema.safeParse(parsed)
    if (!result.success) return await manifestError(400, 'mapping_invalid')
    mapping = result.data
  }

  return {
    fileName: file.name,
    fileType: file.type || null,
    buffer: Buffer.from(await file.arrayBuffer()),
    mapping,
    sheet: readText(form, 'sheet'),
    expectedSha256: readText(form, 'expectedSha256'),
    acceptWarnings: readText(form, 'acceptWarnings') === 'true',
  }
}

/** OpenAPI description of the multipart body (the file itself is binary). */
export const manifestUploadBodySchema = z.object({
  file: z.string().describe('CSV file (multipart form-data, at most 10 MB)'),
  mapping: z
    .string()
    .optional()
    .describe('JSON `{ serial, customerAssetTag?, manufacturer?, model? }` mapping target fields to source column names'),
  sheet: z.string().optional().describe('Sheet name (XLSX only)'),
  expectedSha256: z.string().optional().describe('Import only: `sha256` returned by the preview'),
  acceptWarnings: z.enum(['true', 'false']).optional().describe('Import only: required as `true` when the preview reported warnings'),
})

import type { EntityManager } from '@mikro-orm/postgresql'
import type { AuthContext } from '@open-mercato/shared/lib/auth/server'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'

/**
 * Structural port onto the installed `attachments` module's `attachmentService` (DI).
 * The original manifest file is stored and read only through it — never through the
 * module's ORM classes. Mirrors the port the installed `documents` module uses.
 */
export const MANIFEST_ATTACHMENT_PARTITION = 'privateAttachments'

export type AttachmentServicePort = {
  validateUpload(input: { contentLength?: string | null; fileName?: string; fileSize?: number }): void
  readUploadForm?(request: Request): Promise<FormData>
  createScoped(input: {
    tenantId: string
    organizationId: string
    entityId: string
    recordId: string
    partitionCode: string
    fileName: string
    declaredMimeType?: string | null
    buffer: Buffer
    /** Runs inside the attachment row's transaction; a throw rolls both back and removes the bytes. */
    persistLink?: (tx: EntityManager, attachmentId: string) => Promise<void> | void
  }): Promise<{ id: string; fileName: string; mimeType: string; fileSize: number }>
  readScoped(input: {
    attachmentId: string
    auth: NonNullable<AuthContext>
    expectedOwner: { entityId: string; recordId: string }
    requirePrivatePartition?: boolean
    forceDownload?: boolean
  }): Promise<{ buffer: Buffer; contentType: string; contentDisposition: string }>
}

export function resolveAttachmentService(container: { resolve: (name: string) => unknown }): AttachmentServicePort {
  let candidate: Partial<AttachmentServicePort> | null = null
  try {
    candidate = container.resolve('attachmentService') as Partial<AttachmentServicePort> | null
  } catch {
    candidate = null
  }
  if (
    candidate &&
    typeof candidate.validateUpload === 'function' &&
    typeof candidate.createScoped === 'function' &&
    typeof candidate.readScoped === 'function'
  ) {
    return candidate as AttachmentServicePort
  }
  throw new CrudHttpError(503, { error: 'Attachment service is unavailable' })
}

/** Reads a multipart body within the platform upload limit. */
export async function readAttachmentUploadForm(service: AttachmentServicePort, request: Request): Promise<FormData> {
  if (typeof service.readUploadForm !== 'function') {
    throw new CrudHttpError(503, { error: 'Attachment service is unavailable' })
  }
  return service.readUploadForm(request)
}

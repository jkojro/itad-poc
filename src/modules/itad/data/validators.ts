import { z } from 'zod'
import { CERTIFICATE_LOCALES } from '../domain/certificates'
import { ITAD_ASSET_STATUSES, ITAD_JOB_STATUSES } from '../domain/job-types'
import { ITAD_EXCEPTION_STATUSES, ITAD_EXCEPTION_TYPES } from '../domain/exceptions'
import {
  ITAD_SANITIZATION_METHODS,
  ITAD_VERIFICATION_METHODS,
  SANITIZATION_TEXT_LIMITS,
} from '../domain/sanitization-state-machine'

export const itadJobStatusSchema = z.enum(ITAD_JOB_STATUSES)

/**
 * Fields a CRUD body may never carry. The transition command (status, hold fields,
 * started/completed timestamps) and the reference allocator own them; sending one
 * is rejected with `field_not_writable` rather than silently ignored.
 */
export const ITAD_JOB_SYSTEM_FIELDS = [
  'status',
  'internalReference',
  'statusBeforeHold',
  'heldAt',
  'heldByUserId',
  'holdReason',
  'startedAt',
  'completedAt',
] as const

/** Empty strings from form inputs mean "cleared". */
function emptyToNull(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

const nameSchema = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim() : value),
  z.string().min(1).max(200),
)

const customerReferenceSchema = z.preprocess(emptyToNull, z.string().min(1).max(64).nullable())

const expectedAssetEstimateSchema = z.preprocess(
  (value) => (value === '' ? null : value),
  z.number().int().min(0).nullable(),
)

/** Tri-state; an empty form value means "no default". */
const defaultDataBearingSchema = z.preprocess((value) => (value === '' ? null : value), z.boolean().nullable())

const scheduledPickupAtSchema = z.preprocess(
  emptyToNull,
  z
    .string()
    .refine((value) => !Number.isNaN(Date.parse(value)), { message: 'Invalid date' })
    .nullable(),
)

/** Organization user who coordinates the pickup (pickup calendar spec); empty = none. */
const pickupCoordinatorUserIdSchema = z.preprocess(emptyToNull, z.string().uuid().nullable())

export const itadJobCreateSchema = z.object({
  customerId: z.string().uuid(),
  name: nameSchema,
  customerReference: customerReferenceSchema.optional(),
  expectedAssetEstimate: expectedAssetEstimateSchema.optional(),
  scheduledPickupAt: scheduledPickupAtSchema.optional(),
  defaultDataBearing: defaultDataBearingSchema.optional(),
  pickupCoordinatorUserId: pickupCoordinatorUserIdSchema.optional(),
})

export const itadJobUpdateSchema = z.object({
  id: z.string().uuid(),
  customerId: z.string().uuid().optional(),
  name: nameSchema.optional(),
  customerReference: customerReferenceSchema.optional(),
  expectedAssetEstimate: expectedAssetEstimateSchema.optional(),
  scheduledPickupAt: scheduledPickupAtSchema.optional(),
  defaultDataBearing: defaultDataBearingSchema.optional(),
  pickupCoordinatorUserId: pickupCoordinatorUserIdSchema.optional(),
})

export const itadJobListSchema = z.object({
  id: z.string().uuid().optional(),
  page: z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(1).max(100).default(50),
  search: z.string().trim().max(200).optional(),
  status: z.string().optional(),
  customerId: z.string().uuid().optional(),
  sortField: z
    .enum(['reference', 'name', 'status', 'scheduledPickupAt', 'createdAt', 'updatedAt'])
    .optional()
    .default('reference'),
  sortDir: z.enum(['asc', 'desc']).optional().default('desc'),
})

export type ItadJobCreateInput = z.infer<typeof itadJobCreateSchema>
export type ItadJobUpdateInput = z.infer<typeof itadJobUpdateSchema>
export type ItadJobListQuery = z.infer<typeof itadJobListSchema>

const optionalColumnSchema = z.preprocess(emptyToNull, z.string().min(1).max(300).nullable().optional())

/** Target field → source column chosen in the import wizard (`serial` required). */
export const itadManifestMappingSchema = z.object({
  serial: z.string().trim().min(1).max(300),
  customerAssetTag: optionalColumnSchema,
  manufacturer: optionalColumnSchema,
  model: optionalColumnSchema,
  dataBearing: optionalColumnSchema,
})

export type ItadManifestMappingInput = z.infer<typeof itadManifestMappingSchema>

/**
 * Durable input of `itad.manifest.import`. The file bytes travel in the command
 * context, never in this payload, so audit records hold no customer source data.
 */
export const itadManifestImportSchema = z.object({
  jobId: z.string().uuid(),
  fileName: z.string().trim().min(1).max(255),
  fileType: z.string().max(255).nullable(),
  fileSize: z.number().int().nonnegative(),
  mapping: itadManifestMappingSchema,
  sheet: z.string().max(200).nullable().optional(),
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
  acceptWarnings: z.boolean().default(false),
})

export type ItadManifestImportInput = z.infer<typeof itadManifestImportSchema>

/** Durable input of `itad.manifest.delete_item`; the reason is required while the job is receiving. */
export const itadManifestItemDeleteSchema = z.object({
  jobId: z.string().uuid(),
  itemId: z.string().uuid(),
  reason: z.string().max(1000).nullable().optional(),
})

export type ItadManifestItemDeleteInput = z.infer<typeof itadManifestItemDeleteSchema>

export const itadManifestItemListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  search: z.string().trim().max(200).optional(),
  id: z.string().uuid().optional(),
  reconciliation: z.enum(['matched', 'missing']).optional(),
})

/** Durable input of `itad.assets.scan`; the raw serial as scanned or typed. */
export const itadAssetScanSchema = z.object({
  jobId: z.string().uuid(),
  serial: z.string().max(500),
})

export type ItadAssetScanInput = z.infer<typeof itadAssetScanSchema>

/** Input of the duplicate actions (`itad.assets.resolve_duplicate`, `itad.assets.flag_different_device`). */
export const itadScanActionSchema = z.object({
  jobId: z.string().uuid(),
  scanId: z.string().uuid(),
  note: z.string().max(1000).nullable().optional(),
})

export type ItadScanActionInput = z.infer<typeof itadScanActionSchema>

/** System fields of an asset that edits may never carry (rejected with `field_not_writable`). */
export const ITAD_ASSET_SYSTEM_FIELDS = ['serial', 'serialNormalized', 'status', 'receivedAt', 'receivedByUserId'] as const

const optionalAssetText = z.preprocess(emptyToNull, z.string().min(1).max(200).nullable().optional())

/** Durable input of `itad.assets.update`; omitted keys stay unchanged, `null` clears. */
export const itadAssetUpdateSchema = z.object({
  jobId: z.string().uuid(),
  assetId: z.string().uuid(),
  customerAssetTag: optionalAssetText,
  manufacturer: optionalAssetText,
  model: optionalAssetText,
  dataBearing: z.boolean().nullable().optional(),
})

export type ItadAssetUpdateInput = z.infer<typeof itadAssetUpdateSchema>

export const ITAD_CLASSIFY_MAX_ASSETS = 500

/** Durable input of `itad.assets.classify` (single or bulk; all-or-nothing). */
export const itadAssetClassifySchema = z.object({
  jobId: z.string().uuid(),
  assetIds: z
    .array(z.string().uuid())
    .min(1)
    .max(ITAD_CLASSIFY_MAX_ASSETS)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'Duplicate asset ids' }),
  dataBearing: z.boolean(),
  reason: z.string().max(1000).nullable().optional(),
})

export type ItadAssetClassifyInput = z.infer<typeof itadAssetClassifySchema>

export const itadAssetDeleteSchema = z.object({
  jobId: z.string().uuid(),
  assetId: z.string().uuid(),
  reason: z.string().max(1000).nullable().optional(),
})

export type ItadAssetDeleteInput = z.infer<typeof itadAssetDeleteSchema>

export const itadAssetListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  search: z.string().trim().max(200).optional(),
  id: z.string().uuid().optional(),
  reconciliation: z.enum(['matched', 'unexpected']).optional(),
  dataBearing: z.enum(['unknown', 'true', 'false']).optional(),
  status: z.enum(ITAD_ASSET_STATUSES).optional(),
})

/** Cross-job serial lookup: exact or prefix match on the normalized serial. */
export const itadAssetLookupSchema = z.object({
  /** Serial number or customer asset tag (operations dashboard spec "Asset search"). */
  q: z.string().trim().max(200).optional(),
  /** Alias of `q`, kept for compatibility. */
  serial: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
})

export const itadScanListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  result: z.enum(['matched', 'unexpected', 'duplicate']).optional(),
  pending: z.enum(['true', 'false']).optional(),
})

const requiredText = (max: number) =>
  z.preprocess((value) => (typeof value === 'string' ? value.trim() : value), z.string().min(1).max(max))
const optionalText = (max: number) => z.preprocess(emptyToNull, z.string().min(1).max(max).nullable().optional())

/** Durable input of `itad.sanitization.start` (sanitization spec "Run data", at start). */
export const itadSanitizationStartSchema = z.object({
  jobId: z.string().uuid(),
  assetId: z.string().uuid(),
  method: z.enum(ITAD_SANITIZATION_METHODS),
  methodDetail: optionalText(SANITIZATION_TEXT_LIMITS.methodDetail),
  tool: requiredText(SANITIZATION_TEXT_LIMITS.tool),
  toolVersion: requiredText(SANITIZATION_TEXT_LIMITS.toolVersion),
})
export type ItadSanitizationStartInput = z.infer<typeof itadSanitizationStartSchema>

/** Durable input of `itad.sanitization.record_result`; notes are required for FAIL. */
export const itadSanitizationResultSchema = z.object({
  jobId: z.string().uuid(),
  runId: z.string().uuid(),
  result: z.enum(['PASS', 'FAIL']),
  verificationMethod: z.enum(ITAD_VERIFICATION_METHODS),
  verificationNotes: optionalText(SANITIZATION_TEXT_LIMITS.verificationNotes),
  /** Identifiers of the media the run covered (certificates spec Q1); optional, ≤ 10 × 100. */
  mediaIdentifiers: z.array(z.string().max(200)).max(50).nullable().optional(),
})
export type ItadSanitizationResultInput = z.infer<typeof itadSanitizationResultSchema>

/** Durable input of `itad.sanitization.abort`. */
export const itadSanitizationAbortSchema = z.object({
  jobId: z.string().uuid(),
  runId: z.string().uuid(),
  reason: z.string().max(1000).nullable().optional(),
})
export type ItadSanitizationAbortInput = z.infer<typeof itadSanitizationAbortSchema>

/** Durable input of `itad.sanitization.approve_retry`. */
export const itadSanitizationRetrySchema = z.object({
  jobId: z.string().uuid(),
  assetId: z.string().uuid(),
  reason: z.string().max(1000).nullable().optional(),
})
export type ItadSanitizationRetryInput = z.infer<typeof itadSanitizationRetrySchema>

export const ITAD_EVIDENCE_MAX_RUNS = 200

/** Durable input of `itad.sanitization.attach_evidence`; the bytes travel in the command context. */
export const itadSanitizationEvidenceSchema = z.object({
  jobId: z.string().uuid(),
  runIds: z
    .array(z.string().uuid())
    .min(1)
    .max(ITAD_EVIDENCE_MAX_RUNS)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'Duplicate run ids' }),
  fileName: z.string().trim().min(1).max(255),
  fileType: z.string().max(255).nullable(),
  fileSize: z.number().int().nonnegative(),
})
export type ItadSanitizationEvidenceInput = z.infer<typeof itadSanitizationEvidenceSchema>

export const itadSanitizationListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  search: z.string().trim().max(200).optional(),
  status: z.enum(ITAD_ASSET_STATUSES).optional(),
})

export const itadSanitizationToolsSchema = z.object({
  search: z.string().trim().max(200).optional(),
})

export const ITAD_BULK_SANITIZATION_MAX_ASSETS = 200

const bulkAssetIds = z
  .array(z.string().uuid())
  .min(1)
  .max(ITAD_BULK_SANITIZATION_MAX_ASSETS)
  .refine((ids) => new Set(ids).size === ids.length, { message: 'Duplicate asset ids' })

/** Durable input of `itad.sanitization.bulk_start` (one run per asset, shared batch id). */
export const itadSanitizationBulkStartSchema = itadSanitizationStartSchema.omit({ assetId: true }).extend({ assetIds: bulkAssetIds })
export type ItadSanitizationBulkStartInput = z.infer<typeof itadSanitizationBulkStartSchema>

/** Durable input of `itad.sanitization.bulk_record_result` (the open run of each asset). */
export const itadSanitizationBulkResultSchema = itadSanitizationResultSchema.omit({ runId: true }).extend({ assetIds: bulkAssetIds })
export type ItadSanitizationBulkResultInput = z.infer<typeof itadSanitizationBulkResultSchema>

export const itadExceptionListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  status: z.enum(ITAD_EXCEPTION_STATUSES).optional(),
  type: z.enum(ITAD_EXCEPTION_TYPES).optional(),
  /** `me`, `unassigned` or a user id. */
  assignedTo: z.union([z.enum(['me', 'unassigned']), z.string().uuid()]).optional(),
  assetId: z.string().uuid().optional(),
})

/** Durable input of `itad.exceptions.assign` (`null` unassigns). */
export const itadExceptionAssignSchema = z.object({
  jobId: z.string().uuid(),
  exceptionId: z.string().uuid(),
  assignedToUserId: z.string().uuid().nullable(),
})
export type ItadExceptionAssignInput = z.infer<typeof itadExceptionAssignSchema>

/** Durable input of `itad.exceptions.resolve` (MISSING / UNEXPECTED only). */
export const itadExceptionResolveSchema = z.object({
  jobId: z.string().uuid(),
  exceptionId: z.string().uuid(),
  outcome: z.string().max(64),
  reason: z.string().max(1000).nullable().optional(),
})
export type ItadExceptionResolveInput = z.infer<typeof itadExceptionResolveSchema>

/** Durable input of `itad.assets.set_aside_duplicate`. */
export const itadSetAsideDuplicateSchema = z.object({
  jobId: z.string().uuid(),
  scanId: z.string().uuid(),
  reason: z.string().max(1000).nullable().optional(),
})
export type ItadSetAsideDuplicateInput = z.infer<typeof itadSetAsideDuplicateSchema>

export const itadAssigneeSearchSchema = z.object({ search: z.string().trim().max(200).optional() })

/** Durable input of `itad.certificates.issue` (certificates spec "Issue"). */
export const itadCertificateIssueSchema = z.object({
  jobId: z.string().uuid(),
  assetId: z.string().uuid(),
  locale: z.enum(CERTIFICATE_LOCALES),
})
export type ItadCertificateIssueInput = z.infer<typeof itadCertificateIssueSchema>

/** Durable input of `itad.certificates.reissue` (certificates spec "Reissue and void"). */
export const itadCertificateReissueSchema = z.object({
  jobId: z.string().uuid(),
  certificateId: z.string().uuid(),
  locale: z.enum(CERTIFICATE_LOCALES),
  reason: z.string().max(2000),
  /** From the reissue preview; empty or different → `certificate_preview_stale`. */
  previewHash: z.string().max(128),
})
export type ItadCertificateReissueInput = z.infer<typeof itadCertificateReissueSchema>

/** Durable input of `itad.certificates.void`. */
export const itadCertificateVoidSchema = z.object({
  jobId: z.string().uuid(),
  certificateId: z.string().uuid(),
  reason: z.string().max(2000),
})
export type ItadCertificateVoidInput = z.infer<typeof itadCertificateVoidSchema>

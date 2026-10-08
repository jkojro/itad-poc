import { z } from 'zod'
import { ITAD_JOB_STATUSES } from '../domain/job-types'

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

const scheduledPickupAtSchema = z.preprocess(
  emptyToNull,
  z
    .string()
    .refine((value) => !Number.isNaN(Date.parse(value)), { message: 'Invalid date' })
    .nullable(),
)

export const itadJobCreateSchema = z.object({
  customerId: z.string().uuid(),
  name: nameSchema,
  customerReference: customerReferenceSchema.optional(),
  expectedAssetEstimate: expectedAssetEstimateSchema.optional(),
  scheduledPickupAt: scheduledPickupAtSchema.optional(),
})

export const itadJobUpdateSchema = z.object({
  id: z.string().uuid(),
  customerId: z.string().uuid().optional(),
  name: nameSchema.optional(),
  customerReference: customerReferenceSchema.optional(),
  expectedAssetEstimate: expectedAssetEstimateSchema.optional(),
  scheduledPickupAt: scheduledPickupAtSchema.optional(),
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

export const itadManifestItemListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  search: z.string().trim().max(200).optional(),
  id: z.string().uuid().optional(),
})

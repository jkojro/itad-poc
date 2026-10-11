import { z } from 'zod'
import { ITAD_EXCEPTION_OUTCOMES, ITAD_EXCEPTION_STATUSES, ITAD_EXCEPTION_TYPES } from '../domain/exceptions'

/** OpenAPI response shapes shared by the exception routes. */
const actorSchema = z.object({ id: z.string().uuid(), name: z.string().nullable() }).nullable()

export const exceptionItemSchema = z.object({
  id: z.string().uuid(),
  type: z.enum(ITAD_EXCEPTION_TYPES),
  status: z.enum(ITAD_EXCEPTION_STATUSES),
  serial: z.string(),
  assetId: z.string().uuid().nullable(),
  manifestItemId: z.string().uuid().nullable(),
  intakeScanId: z.string().uuid().nullable(),
  sanitizationRunId: z.string().uuid().nullable(),
  context: z.object({
    flaggedDifferentDevice: z.boolean().optional(),
    scanResolution: z.string().nullable().optional(),
    runTool: z.string().nullable().optional(),
    runFinishedAt: z.string().nullable().optional(),
  }),
  assignedTo: actorSchema,
  createdAt: z.string(),
  resolutionOutcome: z.enum(ITAD_EXCEPTION_OUTCOMES).nullable(),
  resolutionReason: z.string().nullable(),
  resolvedBy: actorSchema,
  resolvedAt: z.string().nullable(),
  updatedAt: z.string(),
})


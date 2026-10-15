import { z } from 'zod'
import { ATTENTION_SIGNAL_KEYS } from '../domain/job-overview'

/** OpenAPI shapes of the operations overview, shared by the job overview and the dashboard routes. */
export const jobOverviewCountersSchema = z.object({
  expected: z.number(),
  received: z.number(),
  missing: z.number(),
  unexpected: z.number(),
  totalIntake: z.number(),
  awaitingWipe: z.number(),
  sanitized: z.number(),
  failed: z.number(),
  sanitizationScope: z.number(),
  dataBearingUnknown: z.number(),
  unresolvedDuplicates: z.number(),
  openExceptions: z.number(),
  openMissingExceptions: z.number(),
  openUnexpectedExceptions: z.number(),
  certificatesRequired: z.number(),
  certificatesIssued: z.number(),
  certificatesMissing: z.number(),
})

export const jobOverviewSignalSchema = z.object({
  key: z.enum(ATTENTION_SIGNAL_KEYS),
  severity: z.enum(['red', 'orange']),
  count: z.number(),
  href: z.string(),
})

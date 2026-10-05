/**
 * ITAD job vocabulary owned by the domain. `data/entities.ts` persists these values;
 * it depends on this file, never the other way round.
 */
export const ITAD_JOB_STATUSES = [
  'draft',
  'scheduled',
  'in_transit',
  'receiving',
  'processing',
  'closeout_review',
  'completed',
  'on_hold',
  'cancelled',
] as const

export type ItadJobStatus = (typeof ITAD_JOB_STATUSES)[number]

import type { ItadJobConditionKey } from '../lib/job-conditions'
import type { ItadJobAction } from '../lib/job-state-machine'

export type ItadJobActionId = ItadJobAction
export type ItadJobConditionId = ItadJobConditionKey

/** English fallbacks; translations live in `i18n/*.json` under `itad.jobs.actions.*`. */
export const ITAD_JOB_ACTION_FALLBACK_LABELS: Record<ItadJobActionId, string> = {
  schedule: 'Schedule',
  unschedule: 'Back to draft',
  dispatch: 'Dispatch',
  return_to_scheduled: 'Back to scheduled',
  start_receiving: 'Start receiving',
  start_processing: 'Start processing',
  start_closeout: 'Start closeout review',
  complete: 'Complete',
  hold: 'Put on hold',
  resume: 'Resume',
  cancel: 'Cancel job',
}

/** English fallbacks; translations live in `i18n/*.json` under `itad.jobs.conditions.*`. */
export const ITAD_JOB_CONDITION_FALLBACK_LABELS: Record<ItadJobConditionId, string> = {
  schedulingDataComplete: 'Customer, name and scheduled pickup set',
  receivingComplete: 'Receiving complete',
  allAssetsProcessed: 'All assets processed',
  noBlockingExceptions: 'No blocking exceptions',
  requiredDocumentsComplete: 'Required documents complete',
}

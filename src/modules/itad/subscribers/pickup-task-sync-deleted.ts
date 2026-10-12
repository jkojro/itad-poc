import { handleJobEvent } from './pickup-task-sync'

/** A deleted draft cancels a planned pickup task left behind by a failed sync. */
export const metadata = {
  event: 'itad.job.deleted',
  persistent: true,
  id: 'itad:pickup-task-sync-deleted',
}

export default handleJobEvent

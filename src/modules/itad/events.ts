import { createModuleEvents } from '@open-mercato/shared/modules/events'

const events = [
  { id: 'itad.job.created', label: 'ITAD Job Created', entity: 'job', category: 'crud', clientBroadcast: true },
  { id: 'itad.job.updated', label: 'ITAD Job Updated', entity: 'job', category: 'crud', clientBroadcast: true },
  { id: 'itad.job.deleted', label: 'ITAD Job Deleted', entity: 'job', category: 'crud', clientBroadcast: true },
  // Payload: { jobId, transitionId, action, from, to, actorUserId, tenantId, organizationId };
  // `transitionId` is the idempotency key for consumers.
  { id: 'itad.job.status_changed', label: 'ITAD Job Status Changed', entity: 'job', category: 'lifecycle', clientBroadcast: true },
  // Payload: { jobId, transitionId, condition, confirmedByUserId, tenantId, organizationId }.
  { id: 'itad.job.condition_manually_confirmed', label: 'ITAD Job Condition Manually Confirmed', entity: 'job', category: 'lifecycle' },
] as const

export const eventsConfig = createModuleEvents({
  moduleId: 'itad',
  events,
})

export const emitItadEvent = eventsConfig.emit

export type ItadEventId = typeof events[number]['id']

export default eventsConfig

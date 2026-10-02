import { createModuleEvents } from '@open-mercato/shared/modules/events'

const events = [
  { id: 'itad.job.created', label: 'ITAD Job Created', entity: 'job', category: 'crud', clientBroadcast: true },
  { id: 'itad.job.updated', label: 'ITAD Job Updated', entity: 'job', category: 'crud', clientBroadcast: true },
  { id: 'itad.job.deleted', label: 'ITAD Job Deleted', entity: 'job', category: 'crud', clientBroadcast: true },
] as const

export const eventsConfig = createModuleEvents({
  moduleId: 'itad',
  events,
})

export const emitItadEvent = eventsConfig.emit

export type ItadEventId = typeof events[number]['id']

export default eventsConfig

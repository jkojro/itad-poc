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
  // Payload: { jobId, importId, importedCount, skippedCount, actorUserId, tenantId, organizationId }.
  // Ids and counts only: manifest source data never travels in events.
  { id: 'itad.manifest.imported', label: 'ITAD Manifest Imported', entity: 'manifest_import', category: 'lifecycle' },
  // Payload: { jobId, itemId, serialNormalized, reason, actorUserId, tenantId, organizationId }; no source data.
  { id: 'itad.manifest.item_deleted', label: 'ITAD Manifest Item Deleted', entity: 'manifest_item', category: 'lifecycle' },
  // Receiving (all payloads also carry jobId, actorUserId, tenantId, organizationId; never source data).
  // itad.asset.received: { assetId, scanId, result }.
  { id: 'itad.asset.received', label: 'ITAD Asset Received', entity: 'asset', category: 'lifecycle', clientBroadcast: true },
  // itad.asset.updated: { assetId }; itad.asset.deleted: { assetId, reason }.
  { id: 'itad.asset.updated', label: 'ITAD Asset Updated', entity: 'asset', category: 'lifecycle', clientBroadcast: true },
  { id: 'itad.asset.deleted', label: 'ITAD Asset Deleted', entity: 'asset', category: 'lifecycle', clientBroadcast: true },
  // itad.intake_scan.duplicate_detected: { scanId, assetId }; .resolved: { scanId, resolution };
  // .flagged_different_device: { scanId, assetId } (input for the exceptions epic).
  { id: 'itad.intake_scan.duplicate_detected', label: 'ITAD Duplicate Scan Detected', entity: 'intake_scan', category: 'lifecycle', clientBroadcast: true },
  { id: 'itad.intake_scan.resolved', label: 'ITAD Duplicate Scan Resolved', entity: 'intake_scan', category: 'lifecycle', clientBroadcast: true },
  { id: 'itad.intake_scan.flagged_different_device', label: 'ITAD Duplicate Scan Flagged As Different Device', entity: 'intake_scan', category: 'lifecycle' },
] as const

export const eventsConfig = createModuleEvents({
  moduleId: 'itad',
  events,
})

export const emitItadEvent = eventsConfig.emit

export type ItadEventId = typeof events[number]['id']

export default eventsConfig

import type { ItadJobStatus } from '../domain/job-types'

/** Shape of one item returned by `GET /api/itad/jobs`. */
export type ItadJobListItem = {
  id: string
  organizationId: string
  customerId: string
  customerName: string | null
  internalReference: string
  customerReference: string | null
  name: string
  status: ItadJobStatus
  statusBeforeHold: ItadJobStatus | null
  heldAt: string | null
  heldByUserId: string | null
  holdReason: string | null
  heldBy: { id: string; name: string | null } | null
  expectedAssetEstimate: number | null
  /** Derived: active manifest items of the job. */
  expectedAssetCount: number
  /** Derived, deprecated: every active asset of the job (Total intake), unexpected included. */
  receivedAssetCount: number
  /** Derived: Received = active manifest items matched by an active asset (operations dashboard spec Q3). */
  matchedAssetCount: number
  /** Derived: active assets without an active manifest item. */
  unexpectedAssetCount: number
  /** Derived: active data-bearing assets not yet sanitized (sanitization spec Q14). */
  sanitizationPendingCount: number
  /** Derived: OPEN exceptions of the job (exceptions spec). */
  openExceptionCount: number
  scheduledPickupAt: string | null
  pickupLocation: string | null
  /** Applied to later scans when the manifest gives no value; `null` = no default. */
  defaultDataBearing: boolean | null
  startedAt: string | null
  completedAt: string | null
  createdAt: string | null
  updatedAt: string | null
  /** Organization user who coordinates the pickup (pickup calendar spec). */
  pickupCoordinatorUserId: string | null
  pickupCoordinator?: { id: string; name: string | null } | null
  /** Single-record reads only: the pickup task in the calendar and how many the job had. */
  pickupTask?: {
    interactionId: string
    state: 'creating' | 'planned' | 'completed' | 'cancelled' | 'lost'
    scheduledAt: string
    lastError: string | null
    lastSyncedAt: string | null
  } | null
  pickupTaskHistoryCount?: number
  editableFields?: string[]
}

import type { ItadJobStatus } from '../data/entities'

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
  expectedAssetEstimate: number | null
  scheduledPickupAt: string | null
  startedAt: string | null
  completedAt: string | null
  createdAt: string | null
  updatedAt: string | null
  editableFields?: string[]
}

import type { ItadExceptionEventKind, ItadExceptionOutcome, ItadExceptionStatus, ItadExceptionType } from '../domain/exceptions'

/** Client shapes of the exception API responses (see the route `openApi` schemas). */
type Actor = { id: string; name: string | null } | null

export type ExceptionRow = {
  id: string
  type: ItadExceptionType
  status: ItadExceptionStatus
  serial: string
  assetId: string | null
  manifestItemId: string | null
  intakeScanId: string | null
  sanitizationRunId: string | null
  context: { flaggedDifferentDevice?: boolean; scanResolution?: string | null; runTool?: string | null; runFinishedAt?: string | null }
  assignedTo: Actor
  createdAt: string
  resolutionOutcome: ItadExceptionOutcome | null
  resolutionReason: string | null
  resolvedBy: Actor
  resolvedAt: string | null
  updatedAt: string
}

export type ExceptionList = { items: ExceptionRow[]; total: number; openCounts: Record<ItadExceptionType, number> }

export type ExceptionDetail = ExceptionRow & {
  events: Array<{
    id: string
    kind: ItadExceptionEventKind
    assignedTo: Actor
    previousAssignedTo: Actor
    outcome: ItadExceptionOutcome | null
    reason: string | null
    actor: Actor
    createdAt: string
  }>
}

export type Assignee = { id: string; name: string | null; email: string | null }

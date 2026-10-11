import type { ItadAssetHistoryStatus, ItadAssetStatus, ItadAssetTransitionAction } from '../domain/job-types'
import type { ItadRunResult, ItadSanitizationMethod, ItadVerificationMethod } from '../domain/sanitization-state-machine'

/** Client shapes of the sanitization API responses (see the route `openApi` schemas). */
type Actor = { id: string; name: string | null } | null

export type SanitizationRow = {
  id: string
  serial: string
  manufacturer: string | null
  model: string | null
  status: ItadAssetStatus
  updatedAt: string
  runsCount: number
  lastRun: {
    id: string
    method: ItadSanitizationMethod
    tool: string
    toolVersion: string
    result: ItadRunResult | null
    startedAt: string
    finishedAt: string | null
    operator: { id: string; name: string | null }
  } | null
}

export type SanitizationCounts = { required: number; inProgress: number; sanitized: number; reviewRequired: number }

export type SanitizationList = { items: SanitizationRow[]; total: number; counts: SanitizationCounts }

export type SanitizationRun = {
  id: string
  method: ItadSanitizationMethod
  methodDetail: string | null
  tool: string
  toolVersion: string
  operator: Actor
  startedAt: string
  finishedAt: string | null
  finishedBy: Actor
  result: ItadRunResult | null
  verificationMethod: ItadVerificationMethod | null
  verificationNotes: string | null
  abortReason: string | null
  evidence: Array<{ attachmentId: string; fileName: string; addedBy: Actor; addedAt: string }>
}

export type SanitizationHistoryEntry = {
  id: string
  action: ItadAssetTransitionAction
  fromStatus: ItadAssetHistoryStatus | null
  toStatus: ItadAssetHistoryStatus
  dataBearingFrom: boolean | null
  dataBearingTo: boolean | null
  runId: string | null
  reason: string | null
  actor: Actor
  createdAt: string
}

export type AssetSanitization = {
  asset: { id: string; serial: string; status: ItadAssetStatus; dataBearing: boolean | null; updatedAt: string }
  runs: SanitizationRun[]
  history: SanitizationHistoryEntry[]
}

export type ToolSuggestion = { tool: string; toolVersion: string; uses: number }

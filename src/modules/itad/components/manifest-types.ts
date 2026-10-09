import type { ItadJobStatus } from '../domain/job-types'

/** Client shapes of the manifest API responses (see the route `openApi` schemas). */
export type ManifestMappingValue = {
  serial?: string
  customerAssetTag?: string
  manufacturer?: string
  model?: string
}

export type ManifestIssue = { row: number; code: string; column?: string }

export type ManifestPreview = {
  format: 'csv' | 'xlsx'
  sha256: string
  sheets: string[]
  sheetName: string | null
  columns: string[]
  suggestedMapping: ManifestMappingValue
  mapping: ManifestMappingValue
  mappingError: 'serial_required' | 'unknown_column' | 'column_used_twice' | null
  unusedColumns: string[]
  totalRows: number
  counts: { valid: number; invalid: number; skippedExisting: number; blankIgnored: number } | null
  rows: Array<{
    rowNumber: number
    state: 'valid' | 'invalid' | 'skipped_existing'
    serial: string | null
    customerAssetTag: string | null
    manufacturer: string | null
    model: string | null
    errors: string[]
  }>
  errors: ManifestIssue[]
  errorCount: number
  warnings: ManifestIssue[]
  warningCount: number
}

export type ManifestImportResult = {
  importId: string
  importedCount: number
  skippedCount: number
  skippedRows: Array<{ row: number; serial: string }>
}

export type ManifestImportListItem = {
  id: string
  fileName: string
  format: 'csv' | 'xlsx'
  sheetName: string | null
  totalRows: number
  importedCount: number
  skippedCount: number
  warningCount: number
  unusedColumns: string[]
  importedBy: { id: string; name: string | null }
  jobStatusAtChange: ItadJobStatus
  createdAt: string
}

export type ManifestItemRow = {
  id: string
  serial: string
  customerAssetTag: string | null
  manufacturer: string | null
  model: string | null
  sourceRow: number
  sourceData: Array<{ column: string; value: string }>
  importId: string
  importFileName: string
  createdAt: string
  reconciliation: 'matched' | 'missing'
  assetId: string | null
}

export const MANIFEST_TARGET_FIELD_IDS = ['serial', 'customerAssetTag', 'manufacturer', 'model'] as const
export type ManifestTargetFieldId = (typeof MANIFEST_TARGET_FIELD_IDS)[number]

export const MANIFEST_FIELD_FALLBACK_LABELS: Record<ManifestTargetFieldId, string> = {
  serial: 'Serial number',
  customerAssetTag: 'Customer asset tag',
  manufacturer: 'Manufacturer',
  model: 'Model',
}

export const MANIFEST_ISSUE_FALLBACK_LABELS: Record<string, string> = {
  serial_missing: 'Serial number is missing',
  serial_too_long: 'Serial number is longer than 100 characters',
  serial_invalid_cell: 'Serial number cell holds a date',
  serial_duplicate_in_file: 'Serial number appears more than once in the file',
  field_too_long: 'Value is too long',
  numeric_serial_cell: 'Serial number is stored as a number; leading zeros may be lost',
  formula_cell: 'Cell holds a formula; its last calculated value is used',
}

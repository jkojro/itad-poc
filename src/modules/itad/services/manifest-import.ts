import type { EntityManager } from '@mikro-orm/postgresql'
import {
  buildManifestTable,
  evaluateManifestRows,
  suggestMapping,
  unusedColumns,
  validateMapping,
  type ManifestEvaluation,
  type ManifestFieldMapping,
  type ManifestTable,
  type MappingErrorCode,
} from '../domain/manifest-mapping'
import { readManifestFile, type ManifestFileErrorCode, type ManifestFileFormat } from './manifest-file/read-manifest-file'

/**
 * Shared read side of manifest preview and import: bytes → table → mapping →
 * row evaluation against the job's current manifest. No writes; the import command
 * re-runs `evaluateManifestRows` under the job lock before persisting.
 */
export type ManifestScope = { tenantId: string; organizationId: string }

export type PreparedManifest = {
  format: ManifestFileFormat
  sha256: string
  sheets: string[]
  sheetName: string | null
  table: ManifestTable
  suggestedMapping: ManifestFieldMapping
  mapping: ManifestFieldMapping
  mappingError: MappingErrorCode | null
  unusedColumns: string[]
  /** `null` while the mapping is invalid. */
  evaluation: ManifestEvaluation | null
}

export type PrepareManifestResult =
  | { ok: true; prepared: PreparedManifest }
  | { ok: false; code: ManifestFileErrorCode }

/** Normalized serials of the job's active manifest items. */
export async function loadActiveManifestSerials(
  em: EntityManager,
  scope: ManifestScope,
  jobId: string,
): Promise<Set<string>> {
  const rows = await em.execute<Array<{ serial_normalized: string }>>(
    `select "serial_normalized" from "itad_manifest_items"
     where "tenant_id" = ? and "organization_id" = ? and "job_id" = ? and "deleted_at" is null`,
    [scope.tenantId, scope.organizationId, jobId],
  )
  return new Set(rows.map((row) => row.serial_normalized))
}

/** `expectedAssetCount` per job: active manifest items, one grouped query. */
export async function countActiveManifestItems(
  em: EntityManager,
  tenantId: string,
  jobIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  if (!jobIds.length) return counts
  const rows = await em.execute<Array<{ job_id: string; count: string | number }>>(
    `select "job_id", count(*) as "count" from "itad_manifest_items"
     where "tenant_id" = ? and "job_id" in (${jobIds.map(() => '?').join(', ')}) and "deleted_at" is null
     group by "job_id"`,
    [tenantId, ...jobIds],
  )
  for (const row of rows) counts.set(String(row.job_id), Number(row.count))
  return counts
}

export async function prepareManifest(input: {
  em: EntityManager
  scope: ManifestScope
  jobId: string
  fileName: string
  buffer: Buffer
  sheet?: string | null
  mapping?: ManifestFieldMapping | null
}): Promise<PrepareManifestResult> {
  const file = await readManifestFile({ fileName: input.fileName, buffer: input.buffer, sheet: input.sheet })
  if (!file.ok) return file
  const built = buildManifestTable(file.sheet)
  if (!built.ok) return built
  const { table } = built

  const suggestedMapping = suggestMapping(table.columns)
  const mapping = input.mapping ?? suggestedMapping
  const mappingError = validateMapping(mapping, table.columns)
  const evaluation = mappingError
    ? null
    : evaluateManifestRows({
        table,
        mapping,
        existingSerials: await loadActiveManifestSerials(input.em, input.scope, input.jobId),
      })

  return {
    ok: true,
    prepared: {
      format: file.format,
      sha256: file.sha256,
      sheets: file.sheets,
      sheetName: file.sheetName,
      table,
      suggestedMapping,
      mapping,
      mappingError,
      unusedColumns: unusedColumns(mapping, table.columns),
      evaluation,
    },
  }
}

import { E } from '@/.mercato/generated/entities.ids.generated'

/** Generated entity id of `ItadJob` (`itad:itad_job`); never hand-typed. */
export const ITAD_JOB_ENTITY_ID = E.itad.itad_job

/** Generated entity ids of the manifest entities; the import id owns the original file attachment. */
export const ITAD_MANIFEST_IMPORT_ENTITY_ID = E.itad.itad_manifest_import
export const ITAD_MANIFEST_ITEM_ENTITY_ID = E.itad.itad_manifest_item

/** Generated entity ids of the receiving entities. */
export const ITAD_ASSET_ENTITY_ID = E.itad.itad_asset
export const ITAD_INTAKE_SCAN_ENTITY_ID = E.itad.itad_intake_scan

/** Generated entity id of `ItadSanitizationRun`. Evidence files are owned by the job (`ITAD_JOB_ENTITY_ID`). */
export const ITAD_SANITIZATION_RUN_ENTITY_ID = E.itad.itad_sanitization_run

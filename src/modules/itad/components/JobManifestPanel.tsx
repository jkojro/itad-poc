"use client"
import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { LegacyColumnDef as ColumnDef } from '@tanstack/react-table/legacy'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import { RowActions } from '@open-mercato/ui/backend/RowActions'
import { SectionHeader } from '@open-mercato/ui/backend/SectionHeader'
import { Button } from '@open-mercato/ui/primitives/button'
import { Alert, AlertDescription } from '@open-mercato/ui/primitives/alert'
import { Spinner } from '@open-mercato/ui/primitives/spinner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@open-mercato/ui/primitives/dialog'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { canChangeManifest } from '../domain/manifest-rules'
import { ITAD_MANIFEST_ITEM_ENTITY_ID } from '../lib/constants'
import { ITAD_JOB_STATUS_FALLBACK_LABELS, itadJobStatusLabelKey } from './job-status'
import { ManifestImportDialog } from './ManifestImportDialog'
import {
  MANIFEST_FIELD_FALLBACK_LABELS,
  type ManifestImportListItem,
  type ManifestItemRow,
} from './manifest-types'
import type { ItadJobListItem } from './types'

type Translate = ReturnType<typeof useT>

const PAGE_SIZE = 50

type ItemsResponse = { items: ManifestItemRow[]; total: number; page: number; pageSize: number }

function formatDateTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()
}

function buildItemColumns(t: Translate): ColumnDef<ManifestItemRow>[] {
  const label = (field: keyof typeof MANIFEST_FIELD_FALLBACK_LABELS) =>
    t(`itad.manifest.field.${field}`, MANIFEST_FIELD_FALLBACK_LABELS[field])
  return [
    {
      id: 'serial',
      accessorKey: 'serial',
      header: label('serial'),
      cell: ({ row }) => <span className="font-mono">{row.original.serial}</span>,
    },
    { id: 'customerAssetTag', accessorKey: 'customerAssetTag', header: label('customerAssetTag'), cell: ({ row }) => row.original.customerAssetTag ?? '—' },
    { id: 'manufacturer', accessorKey: 'manufacturer', header: label('manufacturer'), cell: ({ row }) => row.original.manufacturer ?? '—' },
    { id: 'model', accessorKey: 'model', header: label('model'), cell: ({ row }) => row.original.model ?? '—' },
    {
      id: 'source',
      header: t('itad.manifest.items.source', 'Source'),
      cell: ({ row }) => (
        <span className="text-muted-foreground">
          {t('itad.manifest.items.sourceValue', '{file}, row {row}', { file: row.original.importFileName, row: row.original.sourceRow })}
        </span>
      ),
    },
  ]
}

function SourceDataDialog({ item, onClose }: { item: ManifestItemRow | null; onClose: () => void }) {
  const t = useT()
  return (
    <Dialog open={item !== null} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent>
        {item ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('itad.manifest.sourceData.title', 'Source data of {serial}', { serial: item.serial })}</DialogTitle>
              <DialogDescription>
                {t('itad.manifest.sourceData.description', 'All columns of row {row} in {file}, as imported.', {
                  row: item.sourceRow,
                  file: item.importFileName,
                })}
              </DialogDescription>
            </DialogHeader>
            <dl className="grid max-h-96 grid-cols-1 gap-x-4 gap-y-2 overflow-y-auto text-sm sm:grid-cols-3">
              {item.sourceData.map((entry) => (
                <React.Fragment key={entry.column}>
                  <dt className="text-muted-foreground">{entry.column}</dt>
                  <dd className="break-words sm:col-span-2">{entry.value === '' ? '—' : entry.value}</dd>
                </React.Fragment>
              ))}
            </dl>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function ImportsList({ t, jobId, imports }: { t: Translate; jobId: string; imports: ManifestImportListItem[] }) {
  if (!imports.length) return null
  return (
    <section className="space-y-2" aria-label={t('itad.manifest.imports.title', 'Imported files')}>
      <h3 className="text-sm font-medium">{t('itad.manifest.imports.title', 'Imported files')}</h3>
      <ul className="space-y-2">
        {imports.map((entry) => (
          <li key={entry.id} className="rounded-md border p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <a
                className="font-medium underline underline-offset-2"
                href={`/api/itad/jobs/${encodeURIComponent(jobId)}/manifest/imports/${encodeURIComponent(entry.id)}/file`}
                download={entry.fileName}
              >
                {entry.fileName}
              </a>
              <span className="text-muted-foreground">
                {formatDateTime(entry.createdAt)} · {entry.importedBy.name ?? t('itad.jobs.history.unknownUser', 'unknown user')}
              </span>
            </div>
            <p className="text-muted-foreground">
              {t('itad.manifest.imports.counts', '{imported} imported, {skipped} skipped of {total} rows · job status: {status}', {
                imported: entry.importedCount,
                skipped: entry.skippedCount,
                total: entry.totalRows,
                status: t(itadJobStatusLabelKey(entry.jobStatusAtChange), ITAD_JOB_STATUS_FALLBACK_LABELS[entry.jobStatusAtChange]),
              })}
            </p>
            {entry.unusedColumns.length ? (
              <p className="text-muted-foreground">
                {t('itad.manifest.imports.unused', 'Unused columns: {columns}', { columns: entry.unusedColumns.join(', ') })}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Manifest tab of a job (spec "UI and Interaction Contracts"): import, items with source data, imported files. */
export function JobManifestPanel({
  job,
  canManage,
  onChanged,
}: {
  job: ItadJobListItem
  canManage: boolean
  /** Reloads the job so its derived counters follow an import. */
  onChanged: () => void
}) {
  const t = useT()
  const queryClient = useQueryClient()
  const [search, setSearch] = React.useState('')
  const [page, setPage] = React.useState(1)
  const [importOpen, setImportOpen] = React.useState(false)
  const [sourceItem, setSourceItem] = React.useState<ManifestItemRow | null>(null)
  const columns = React.useMemo(() => buildItemColumns(t), [t])
  const basePath = `/api/itad/jobs/${encodeURIComponent(job.id)}/manifest`
  const editable = canChangeManifest(job)

  const itemsQuery = useQuery<ItemsResponse>({
    queryKey: ['itad-manifest-items', job.id, page, search],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) })
      if (search.trim()) params.set('search', search.trim())
      return readApiResultOrThrow<ItemsResponse>(`${basePath}/items?${params.toString()}`, undefined, {
        errorMessage: t('itad.manifest.items.error', 'Could not load the manifest'),
      })
    },
  })
  const importsQuery = useQuery<{ items: ManifestImportListItem[] }>({
    queryKey: ['itad-manifest-imports', job.id],
    queryFn: async () =>
      readApiResultOrThrow<{ items: ManifestImportListItem[] }>(`${basePath}/imports`, undefined, {
        errorMessage: t('itad.manifest.imports.error', 'Could not load the imported files'),
      }),
  })

  const refresh = React.useCallback(() => {
    setPage(1)
    void queryClient.invalidateQueries({ queryKey: ['itad-manifest-items', job.id] })
    void queryClient.invalidateQueries({ queryKey: ['itad-manifest-imports', job.id] })
    onChanged()
  }, [job.id, onChanged, queryClient])

  const total = itemsQuery.data?.total ?? 0
  const searching = search.trim().length > 0

  return (
    <section className="space-y-4 rounded-lg border bg-card p-4" aria-label={t('itad.manifest.title', 'Manifest')}>
      <SectionHeader title={t('itad.manifest.title', 'Manifest')} />
      <p className="text-sm">
        {t('itad.manifest.expectedCount', 'Expected devices (manifest): {count}', { count: job.expectedAssetCount })}
        {job.expectedAssetEstimate !== null ? (
          <span className="text-muted-foreground">
            {' · '}
            {t('itad.manifest.estimate', 'Estimate before the manifest: {count}', { count: job.expectedAssetEstimate })}
          </span>
        ) : null}
      </p>
      {!editable ? (
        <Alert status="information">
          <AlertDescription>{t('itad.manifest.locked', 'The manifest can no longer be changed in the current job status.')}</AlertDescription>
        </Alert>
      ) : null}

      {itemsQuery.error ? (
        <Alert status="error">
          <AlertDescription>{t('itad.manifest.items.error', 'Could not load the manifest')}</AlertDescription>
        </Alert>
      ) : (
        <DataTable<ManifestItemRow>
          title={t('itad.manifest.items.title', 'Expected devices')}
          actions={
            canManage && editable ? (
              <Button type="button" onClick={() => setImportOpen(true)}>
                {t('itad.manifest.actions.import', 'Import manifest')}
              </Button>
            ) : undefined
          }
          columns={columns}
          data={itemsQuery.data?.items ?? []}
          searchValue={search}
          searchPlaceholder={t('itad.manifest.items.search', 'Search serial, tag, model or any source column')}
          onSearchChange={(value) => {
            setSearch(value)
            setPage(1)
          }}
          searchAlign="right"
          entityId={ITAD_MANIFEST_ITEM_ENTITY_ID}
          extensionTableId="itad.manifest.items"
          emptyState={(
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <p className="text-sm text-muted-foreground">
                {searching
                  ? t('itad.manifest.items.noMatches', 'No manifest items match the search.')
                  : t('itad.manifest.items.empty', 'No manifest imported yet.')}
              </p>
              {!searching && canManage && editable ? (
                <Button type="button" variant="outline" onClick={() => setImportOpen(true)}>
                  {t('itad.manifest.actions.import', 'Import manifest')}
                </Button>
              ) : null}
            </div>
          )}
          rowActions={(row) => (
            <RowActions
              items={[{ id: 'itad.manifest.sourceData', label: t('itad.manifest.actions.sourceData', 'Source data'), onSelect: () => setSourceItem(row) }]}
            />
          )}
          onRowClick={(row) => setSourceItem(row)}
          pagination={{
            page,
            pageSize: PAGE_SIZE,
            total,
            totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
            onPageChange: setPage,
          }}
          isLoading={itemsQuery.isLoading}
        />
      )}

      {importsQuery.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="h-4 w-4" /> {t('itad.manifest.imports.loading', 'Loading imported files…')}
        </div>
      ) : importsQuery.error ? (
        <Alert status="error">
          <AlertDescription>{t('itad.manifest.imports.error', 'Could not load the imported files')}</AlertDescription>
        </Alert>
      ) : (
        <ImportsList t={t} jobId={job.id} imports={importsQuery.data?.items ?? []} />
      )}

      <SourceDataDialog item={sourceItem} onClose={() => setSourceItem(null)} />
      {canManage && editable ? (
        <ManifestImportDialog jobId={job.id} open={importOpen} onOpenChange={setImportOpen} onImported={refresh} />
      ) : null}
    </section>
  )
}

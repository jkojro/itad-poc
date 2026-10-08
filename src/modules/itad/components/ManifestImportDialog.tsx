"use client"
import * as React from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Alert, AlertDescription, AlertTitle } from '@open-mercato/ui/primitives/alert'
import { Checkbox } from '@open-mercato/ui/primitives/checkbox'
import { Label } from '@open-mercato/ui/primitives/label'
import { FormField } from '@open-mercato/ui/primitives/form-field'
import { FileUploadArea } from '@open-mercato/ui/primitives/file-upload'
import { StatusBadge, type StatusBadgeVariant } from '@open-mercato/ui/primitives/status-badge'
import { Spinner } from '@open-mercato/ui/primitives/spinner'
import { StepIndicator, type StepIndicatorStep } from '@open-mercato/ui/primitives/step-indicator'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@open-mercato/ui/primitives/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@open-mercato/ui/primitives/table'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@open-mercato/ui/primitives/dialog'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import {
  MANIFEST_FIELD_FALLBACK_LABELS,
  MANIFEST_ISSUE_FALLBACK_LABELS,
  MANIFEST_TARGET_FIELD_IDS,
  type ManifestImportResult,
  type ManifestIssue,
  type ManifestMappingValue,
  type ManifestPreview,
  type ManifestTargetFieldId,
} from './manifest-types'

type Translate = ReturnType<typeof useT>
type Step = 'file' | 'mapping' | 'preview'

const NOT_MAPPED = '__not_mapped__'
const MAX_FILE_BYTES = 10 * 1024 * 1024
const ROW_STATE_VARIANTS: Record<ManifestPreview['rows'][number]['state'], StatusBadgeVariant> = {
  valid: 'success',
  invalid: 'error',
  skipped_existing: 'neutral',
}

export function issueLabel(t: Translate, code: string): string {
  return t(`itad.manifest.issue.${code}`, MANIFEST_ISSUE_FALLBACK_LABELS[code] ?? code)
}

function fieldLabel(t: Translate, field: ManifestTargetFieldId): string {
  return t(`itad.manifest.field.${field}`, MANIFEST_FIELD_FALLBACK_LABELS[field])
}

type MappingProblem = 'serial_required' | 'column_used_twice' | 'unknown_column'

const MAPPING_PROBLEM_FALLBACK_LABELS: Record<MappingProblem, string> = {
  serial_required: 'Choose the column that holds the serial number.',
  column_used_twice: 'Each column can be assigned to only one field.',
  unknown_column: 'A selected column is not in the file. Choose the columns again.',
}

function mappingErrorLabel(t: Translate, problem: MappingProblem): string {
  return t(`itad.manifest.import.mapping.error.${problem}`, MAPPING_PROBLEM_FALLBACK_LABELS[problem])
}

/** Mirrors the server's mapping validation so the operator sees the problem before previewing. */
function findMappingProblem(mapping: ManifestMappingValue): MappingProblem | null {
  if (!mapping.serial) return 'serial_required'
  const used = MANIFEST_TARGET_FIELD_IDS.map((field) => mapping[field]).filter((column): column is string => Boolean(column))
  return new Set(used).size === used.length ? null : 'column_used_twice'
}

function rowStateLabel(t: Translate, state: ManifestPreview['rows'][number]['state']): string {
  if (state === 'valid') return t('itad.manifest.rowState.valid', 'Will be imported')
  if (state === 'invalid') return t('itad.manifest.rowState.invalid', 'Error')
  return t('itad.manifest.rowState.skipped_existing', 'Already in the job')
}

function IssueList({ t, issues, total, title, status }: { t: Translate; issues: ManifestIssue[]; total: number; title: string; status: 'error' | 'warning' }) {
  if (total === 0) return null
  return (
    <Alert status={status}>
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <ul className="mt-1 max-h-40 list-disc space-y-0.5 overflow-y-auto pl-4">
          {issues.map((issue, index) => (
            <li key={`${issue.row}-${issue.code}-${index}`}>
              {t('itad.manifest.issue.row', 'Row {row}', { row: issue.row })}
              {issue.column ? ` · ${issue.column}` : ''}: {issueLabel(t, issue.code)}
            </li>
          ))}
        </ul>
        {total > issues.length ? (
          <p className="mt-1">{t('itad.manifest.issue.more', 'and {count} more', { count: total - issues.length })}</p>
        ) : null}
      </AlertDescription>
    </Alert>
  )
}

/**
 * Manifest import wizard (spec "Import flow"): file → column mapping → preview with row
 * validation → import. Preview stores nothing; the import re-validates on the server.
 */
export function ManifestImportDialog({
  jobId,
  open,
  onOpenChange,
  onImported,
}: {
  jobId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onImported: () => void
}) {
  const t = useT()
  const [step, setStep] = React.useState<Step>('file')
  const [file, setFile] = React.useState<File | null>(null)
  const [preview, setPreview] = React.useState<ManifestPreview | null>(null)
  const [mapping, setMapping] = React.useState<ManifestMappingValue>({})
  const [acceptWarnings, setAcceptWarnings] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const basePath = `/api/itad/jobs/${encodeURIComponent(jobId)}/manifest`
  const mappingProblem = findMappingProblem(mapping)

  React.useEffect(() => {
    if (open) return
    setStep('file')
    setFile(null)
    setPreview(null)
    setMapping({})
    setAcceptWarnings(false)
    setBusy(false)
    setError(null)
  }, [open])

  const errorMessage = (body: { error?: unknown } | null, fallback: string) =>
    typeof body?.error === 'string' && body.error ? body.error : fallback

  const runPreview = React.useCallback(
    async (target: File, nextMapping: ManifestMappingValue | null, sheet: string | null): Promise<ManifestPreview | null> => {
      setBusy(true)
      setError(null)
      const form = new FormData()
      form.append('file', target)
      if (nextMapping) form.append('mapping', JSON.stringify(nextMapping))
      if (sheet) form.append('sheet', sheet)
      const call = await apiCall<ManifestPreview & { error?: string }>(`${basePath}/preview`, { method: 'POST', body: form })
      setBusy(false)
      if (!call.ok || !call.result) {
        setError(errorMessage(call.result, t('itad.manifest.import.error.preview', 'Could not read the file')))
        return null
      }
      setPreview(call.result)
      setAcceptWarnings(false)
      return call.result
    },
    [basePath, t],
  )

  const onFileSelected = async (files: File[]) => {
    const selected = files[0]
    if (!selected) return
    setFile(selected)
    const result = await runPreview(selected, null, null)
    if (result) {
      setMapping(result.mapping)
      setStep('mapping')
    }
  }

  // Another sheet has other columns: preview it again and start from its suggested mapping.
  const onSheetChange = async (sheet: string) => {
    if (!file || sheet === preview?.sheetName) return
    const result = await runPreview(file, null, sheet)
    if (result) setMapping(result.mapping)
  }

  const goToPreview = async () => {
    if (!file || mappingProblem) return
    const result = await runPreview(file, mapping, preview?.sheetName ?? null)
    if (!result) return
    // The server re-validates the mapping; an invalid one yields no row evaluation.
    if (result.mappingError) {
      setError(mappingErrorLabel(t, result.mappingError))
      return
    }
    setStep('preview')
  }

  const submit = async () => {
    if (!file || !preview || busy) return
    setBusy(true)
    setError(null)
    const form = new FormData()
    form.append('file', file)
    form.append('mapping', JSON.stringify(mapping))
    form.append('expectedSha256', preview.sha256)
    if (preview.sheetName) form.append('sheet', preview.sheetName)
    form.append('acceptWarnings', acceptWarnings ? 'true' : 'false')
    const call = await apiCall<ManifestImportResult & { error?: string; code?: string }>(`${basePath}/imports`, {
      method: 'POST',
      body: form,
    })
    setBusy(false)
    if (call.ok && call.result) {
      flash(
        t('itad.manifest.import.flash.done', 'Imported {imported} items, skipped {skipped} already in the job', {
          imported: call.result.importedCount,
          skipped: call.result.skippedCount,
        }),
        'success',
      )
      onOpenChange(false)
      onImported()
      return
    }
    if (call.result?.code === 'itad.manifest.errors.file_changed') setStep('file')
    setError(errorMessage(call.result, t('itad.manifest.import.error.submit', 'Could not import the manifest')))
  }

  const counts = preview?.counts ?? null
  const canImport =
    step === 'preview' &&
    !busy &&
    counts !== null &&
    counts.invalid === 0 &&
    (preview?.warningCount === 0 || acceptWarnings)
  const mappedColumns = new Set(MANIFEST_TARGET_FIELD_IDS.map((field) => mapping[field]).filter(Boolean))
  const unused = preview ? preview.columns.filter((column) => !mappedColumns.has(column)) : []

  const steps: StepIndicatorStep[] = [
    { id: 'file', label: t('itad.manifest.import.step.file', 'File'), status: step === 'file' ? 'current' : 'complete' },
    {
      id: 'mapping',
      label: t('itad.manifest.import.step.mapping', 'Columns'),
      status: step === 'mapping' ? 'current' : step === 'preview' ? 'complete' : 'pending',
    },
    { id: 'preview', label: t('itad.manifest.import.step.preview', 'Preview'), status: step === 'preview' ? 'current' : 'pending' },
  ]

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next) }}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>{t('itad.manifest.import.title', 'Import manifest')}</DialogTitle>
          <DialogDescription>
            {t('itad.manifest.import.description', 'Upload the customer file, map its columns and check the rows before importing.')}
          </DialogDescription>
        </DialogHeader>
        <StepIndicator steps={steps} size="sm" />

        <div className="space-y-4 py-2">
          {step === 'file' ? (
            <FileUploadArea
              className="w-full"
              accept=".csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              multiple={false}
              maxSizeBytes={MAX_FILE_BYTES}
              disabled={busy}
              heading={t('itad.manifest.import.file.heading', 'Choose a CSV or XLSX file or drag & drop it here.')}
              description={t('itad.manifest.import.file.hint', 'CSV (UTF-8) or XLSX, up to 10 MB and 5,000 rows. The first non-empty row must hold the column names.')}
              onFilesSelected={(files) => void onFileSelected(files)}
            />
          ) : null}

          {step === 'mapping' && preview ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                {t('itad.manifest.import.mapping.summary', '{file}: {rows} data rows, {columns} columns', {
                  file: file?.name ?? '',
                  rows: preview.totalRows,
                  columns: preview.columns.length,
                })}
              </p>
              {preview.sheets.length > 1 ? (
                <FormField
                  label={t('itad.manifest.import.mapping.sheet', 'Sheet')}
                  description={t('itad.manifest.import.mapping.sheetHint', 'Each sheet is imported separately.')}
                >
                  <Select value={preview.sheetName ?? undefined} onValueChange={(value) => void onSheetChange(value)}>
                    <SelectTrigger aria-label={t('itad.manifest.import.mapping.sheet', 'Sheet')} disabled={busy}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {preview.sheets.map((sheet) => (
                        <SelectItem key={sheet} value={sheet}>{sheet}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormField>
              ) : null}
              <div className="grid gap-4 sm:grid-cols-2">
                {MANIFEST_TARGET_FIELD_IDS.map((field) => (
                  <FormField key={field} label={fieldLabel(t, field)} required={field === 'serial'}>
                    <Select
                      value={mapping[field] ?? NOT_MAPPED}
                      onValueChange={(value) =>
                        setMapping((current) => ({ ...current, [field]: value === NOT_MAPPED ? undefined : value }))
                      }
                    >
                      <SelectTrigger aria-label={fieldLabel(t, field)}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {field !== 'serial' ? (
                          <SelectItem value={NOT_MAPPED}>{t('itad.manifest.import.mapping.notMapped', 'Not mapped')}</SelectItem>
                        ) : null}
                        {preview.columns.map((column) => (
                          <SelectItem key={column} value={column}>{column}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormField>
                ))}
              </div>
              {mappingProblem ? (
                <Alert status="warning"><AlertDescription>{mappingErrorLabel(t, mappingProblem)}</AlertDescription></Alert>
              ) : null}
              <div className="rounded-md border p-3 text-sm">
                <p className="font-medium">{t('itad.manifest.import.mapping.unused', 'Kept as source data only (not used by the process)')}</p>
                <p className="text-muted-foreground">
                  {unused.length ? unused.join(', ') : t('itad.manifest.import.mapping.unusedNone', 'None — every column is mapped.')}
                </p>
              </div>
            </div>
          ) : null}

          {step === 'preview' && preview ? (
            <div className="space-y-4">
              {counts ? (
                <p className="text-sm" role="status">
                  {t('itad.manifest.import.preview.counts', '{valid} to import · {invalid} with errors · {skipped} already in the job · {blank} blank rows ignored', {
                    valid: counts.valid,
                    invalid: counts.invalid,
                    skipped: counts.skippedExisting,
                    blank: counts.blankIgnored,
                  })}
                </p>
              ) : null}
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('itad.manifest.import.preview.row', 'Row')}</TableHead>
                      <TableHead>{fieldLabel(t, 'serial')}</TableHead>
                      <TableHead>{fieldLabel(t, 'customerAssetTag')}</TableHead>
                      <TableHead>{fieldLabel(t, 'manufacturer')}</TableHead>
                      <TableHead>{fieldLabel(t, 'model')}</TableHead>
                      <TableHead>{t('itad.manifest.import.preview.state', 'Result')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {preview.rows.map((row) => (
                      <TableRow key={row.rowNumber}>
                        <TableCell>{row.rowNumber}</TableCell>
                        <TableCell className="font-mono">{row.serial ?? '—'}</TableCell>
                        <TableCell>{row.customerAssetTag ?? '—'}</TableCell>
                        <TableCell>{row.manufacturer ?? '—'}</TableCell>
                        <TableCell>{row.model ?? '—'}</TableCell>
                        <TableCell>
                          <StatusBadge variant={ROW_STATE_VARIANTS[row.state]} dot>{rowStateLabel(t, row.state)}</StatusBadge>
                          {row.errors.length ? (
                            <span className="ml-2 text-xs text-muted-foreground">{row.errors.map((code) => issueLabel(t, code)).join('; ')}</span>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              {counts && preview.totalRows > preview.rows.length ? (
                <p className="text-xs text-muted-foreground">
                  {t('itad.manifest.import.preview.firstRows', 'Showing the first {shown} of {total} rows; all rows were validated.', {
                    shown: preview.rows.length,
                    total: preview.totalRows,
                  })}
                </p>
              ) : null}
              <IssueList
                t={t}
                issues={preview.errors}
                total={preview.errorCount}
                status="error"
                title={t('itad.manifest.import.preview.errorsTitle', 'Fix these rows in the file before importing')}
              />
              <IssueList
                t={t}
                issues={preview.warnings}
                total={preview.warningCount}
                status="warning"
                title={t('itad.manifest.import.preview.warningsTitle', 'Warnings')}
              />
              {preview.warningCount > 0 && counts?.invalid === 0 ? (
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="itad-manifest-accept-warnings"
                    checked={acceptWarnings}
                    onCheckedChange={(checked) => setAcceptWarnings(checked === true)}
                  />
                  <Label htmlFor="itad-manifest-accept-warnings">
                    {t('itad.manifest.import.preview.acceptWarnings', 'I have reviewed the warnings')}
                  </Label>
                </div>
              ) : null}
            </div>
          ) : null}

          {busy ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <Spinner className="h-4 w-4" /> {t('itad.manifest.import.busy', 'Working…')}
            </div>
          ) : null}
          {error ? (
            <Alert status="error"><AlertDescription>{error}</AlertDescription></Alert>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('itad.manifest.import.cancel', 'Cancel')}
          </Button>
          {step === 'mapping' ? (
            <>
              <Button type="button" variant="outline" onClick={() => setStep('file')} disabled={busy}>
                {t('itad.manifest.import.back', 'Back')}
              </Button>
              <Button type="button" onClick={() => void goToPreview()} disabled={busy || mappingProblem !== null}>
                {t('itad.manifest.import.toPreview', 'Preview rows')}
              </Button>
            </>
          ) : null}
          {step === 'preview' ? (
            <>
              <Button type="button" variant="outline" onClick={() => setStep('mapping')} disabled={busy}>
                {t('itad.manifest.import.back', 'Back')}
              </Button>
              <Button type="button" onClick={() => void submit()} disabled={!canImport}>
                {busy ? <Spinner className="mr-2 h-4 w-4" /> : null}
                {t('itad.manifest.import.submit', 'Import')}
              </Button>
            </>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

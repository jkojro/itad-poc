"use client"
import * as React from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { CrudForm, type CrudField, type CrudFormGroup } from '@open-mercato/ui/backend/CrudForm'
import { ErrorMessage, RecordNotFoundState } from '@open-mercato/ui/backend/detail'
import { createCrud, deleteCrud, fetchCrudList, updateCrud } from '@open-mercato/ui/backend/utils/crud'
import { withFlash } from '@open-mercato/ui/backend/utils/flash'
import { StatusBadge } from '@open-mercato/ui/primitives/status-badge'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { CompanySelectField } from '@open-mercato/core/modules/customers/components/formConfig'
import {
  ITAD_JOB_STATUS_FALLBACK_LABELS,
  ITAD_JOB_STATUS_VARIANTS,
  itadJobStatusLabelKey,
} from './jobStatus'
import type { ItadJobListItem } from './types'
import { ITAD_JOB_ENTITY_ID } from '../lib/constants'

const API_PATH = 'itad/jobs'
const LIST_HREF = '/backend/itad/jobs'
const ENTITY_ID = ITAD_JOB_ENTITY_ID

type Translate = ReturnType<typeof useT>

export type JobFormValues = {
  id?: string
  customerId: string
  name: string
  customerReference: string
  expectedAssetEstimate: number | string | null
  scheduledPickupAt: string | null
  // Carries the optimistic-lock version: `CrudForm` derives the expected-version
  // header from `initialValues.updatedAt` for update AND delete.
  updatedAt?: string | null
}

type JobPayload = {
  customerId: string
  name: string
  customerReference: string | null
  expectedAssetEstimate: number | null
  scheduledPickupAt: string | null
}

/**
 * Normalizes form values into the API payload. Cleared inputs become explicit `null`
 * (the datetime picker reports a cleared value as `undefined`, number inputs as `''`),
 * so clearing a field is a real write instead of a silently ignored key.
 */
export function toJobPayload(values: Partial<JobFormValues>): JobPayload {
  const estimate = values.expectedAssetEstimate
  const reference = typeof values.customerReference === 'string' ? values.customerReference.trim() : ''
  return {
    customerId: String(values.customerId ?? ''),
    name: String(values.name ?? '').trim(),
    customerReference: reference.length ? reference : null,
    expectedAssetEstimate: estimate === '' || estimate == null ? null : Number(estimate),
    scheduledPickupAt: typeof values.scheduledPickupAt === 'string' && values.scheduledPickupAt ? values.scheduledPickupAt : null,
  }
}

export function toJobFormValues(item: ItadJobListItem): JobFormValues {
  return {
    id: item.id,
    customerId: item.customerId,
    name: item.name,
    customerReference: item.customerReference ?? '',
    expectedAssetEstimate: item.expectedAssetEstimate,
    scheduledPickupAt: item.scheduledPickupAt,
    updatedAt: item.updatedAt,
  }
}

function useCompanyLabels(t: Translate) {
  return React.useMemo(
    () => ({
      placeholder: t('itad.jobs.form.customer.placeholder', 'Select a customer company'),
      addLabel: t('itad.jobs.form.customer.add', 'Add company'),
      dialogTitle: t('itad.jobs.form.customer.dialogTitle', 'Add company'),
      inputLabel: t('itad.jobs.form.customer.inputLabel', 'Company name'),
      inputPlaceholder: t('itad.jobs.form.customer.inputPlaceholder', 'e.g. ACME Bank'),
      emptyError: t('itad.jobs.form.customer.emptyError', 'Enter a company name'),
      cancelLabel: t('itad.jobs.form.customer.cancel', 'Cancel'),
      saveLabel: t('itad.jobs.form.customer.save', 'Save'),
      errorLoad: t('itad.jobs.form.customer.errorLoad', 'Could not load customers'),
      errorSave: t('itad.jobs.form.customer.errorSave', 'Could not save the company'),
      loadingLabel: t('itad.jobs.form.customer.loading', 'Loading customers…'),
    }),
    [t],
  )
}

function useJobFields(
  t: Translate,
  editable: readonly string[] | null,
  customerName: string | null,
): CrudField[] {
  const companyLabels = useCompanyLabels(t)
  return React.useMemo<CrudField[]>(() => {
    // `null` means "create": every field is editable.
    const locked = (field: string) => editable !== null && !editable.includes(field)
    const customerLocked = locked('customerId')
    return [
      {
        id: 'customerId',
        label: t('itad.jobs.form.fields.customer', 'Customer'),
        type: 'custom',
        required: true,
        description: customerLocked
          ? t('itad.jobs.form.fields.customer.lockedHint', 'The customer can be changed only while the job is a draft.')
          : undefined,
        component: ({ value, setValue }) =>
          customerLocked ? (
            <p className="text-sm">
              {customerName ?? t('itad.jobs.customer.deleted', 'Deleted customer')}
            </p>
          ) : (
            <CompanySelectField
              value={typeof value === 'string' && value ? value : undefined}
              onChange={(next) => setValue(next ?? '')}
              labels={companyLabels}
            />
          ),
      },
      {
        id: 'name',
        label: t('itad.jobs.form.fields.name', 'Name'),
        type: 'text',
        required: true,
        maxLength: 200,
        readOnly: locked('name'),
        placeholder: t('itad.jobs.form.fields.name.placeholder', 'e.g. Branch laptop refresh 2026'),
      },
      {
        id: 'customerReference',
        label: t('itad.jobs.form.fields.customerReference', 'Customer reference'),
        type: 'text',
        maxLength: 64,
        readOnly: locked('customerReference'),
        description: t('itad.jobs.form.fields.customerReference.hint', 'Optional reference from the customer, unique in this organization.'),
      },
      {
        id: 'expectedAssetEstimate',
        label: t('itad.jobs.form.fields.expectedAssetEstimate', 'Expected asset estimate'),
        type: 'number',
        readOnly: locked('expectedAssetEstimate'),
        description: t('itad.jobs.form.fields.expectedAssetEstimate.hint', 'Rough estimate before the manifest arrives.'),
      },
      {
        id: 'scheduledPickupAt',
        label: t('itad.jobs.form.fields.scheduledPickupAt', 'Scheduled pickup at'),
        type: 'datetime',
        readOnly: locked('scheduledPickupAt'),
        description: t('itad.jobs.form.fields.scheduledPickupAt.hint', 'Planned pickup / handover of the equipment. Required to schedule the job.'),
      },
    ]
  }, [companyLabels, customerName, editable, t])
}

function formatDateTime(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()
}

function JobSummary({ job, t }: { job: ItadJobListItem; t: Translate }) {
  return (
    <dl className="grid grid-cols-1 gap-3 text-sm">
      <div>
        <dt className="text-muted-foreground">{t('itad.jobs.detail.status', 'Status')}</dt>
        <dd>
          <StatusBadge variant={ITAD_JOB_STATUS_VARIANTS[job.status] ?? 'neutral'} dot>
            {t(itadJobStatusLabelKey(job.status), ITAD_JOB_STATUS_FALLBACK_LABELS[job.status])}
          </StatusBadge>
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground">{t('itad.jobs.detail.internalReference', 'Internal reference')}</dt>
        <dd className="font-medium">{job.internalReference}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">{t('itad.jobs.detail.customer', 'Customer')}</dt>
        <dd>
          {job.customerName ? (
            <Link className="underline underline-offset-2" href={`/backend/customers/companies/${job.customerId}`}>
              {job.customerName}
            </Link>
          ) : (
            <span className="text-muted-foreground">{t('itad.jobs.customer.deleted', 'Deleted customer')}</span>
          )}
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground">{t('itad.jobs.detail.startedAt', 'Started')}</dt>
        <dd>{formatDateTime(job.startedAt)}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">{t('itad.jobs.detail.completedAt', 'Completed')}</dt>
        <dd>{formatDateTime(job.completedAt)}</dd>
      </div>
    </dl>
  )
}

function useJobGroups(t: Translate, summary: CrudFormGroup | null): CrudFormGroup[] {
  return React.useMemo<CrudFormGroup[]>(() => {
    const groups: CrudFormGroup[] = [
      {
        id: 'details',
        title: t('itad.jobs.form.groups.details', 'Details'),
        column: 1,
        fields: ['customerId', 'name', 'customerReference'],
      },
      {
        id: 'planning',
        title: t('itad.jobs.form.groups.planning', 'Planning'),
        column: 1,
        fields: ['scheduledPickupAt', 'expectedAssetEstimate'],
      },
    ]
    if (summary) groups.push(summary)
    return groups
  }, [summary, t])
}

export function JobCreateForm() {
  const t = useT()
  const router = useRouter()
  const searchParams = useSearchParams()
  const preselectedCustomerId = searchParams?.get('customerId') ?? ''
  const fields = useJobFields(t, null, null)
  const groups = useJobGroups(t, null)
  const initialValues = React.useMemo<JobFormValues>(
    () => ({
      customerId: preselectedCustomerId,
      name: '',
      customerReference: '',
      expectedAssetEstimate: null,
      scheduledPickupAt: null,
    }),
    [preselectedCustomerId],
  )

  return (
    <CrudForm<JobFormValues>
      title={t('itad.jobs.create.title', 'New ITAD job')}
      titleHeadingLevel={1}
      backHref={LIST_HREF}
      entityId={ENTITY_ID}
      injectionSpotId="crud-form:itad.itad_job"
      fields={fields}
      groups={groups}
      initialValues={initialValues}
      submitLabel={t('itad.jobs.create.submit', 'Create job')}
      cancelHref={LIST_HREF}
      onSubmit={async (values) => {
        const response = await createCrud<{ id?: string }>(API_PATH, toJobPayload(values))
        const createdId = response.result?.id
        router.push(
          withFlash(createdId ? `${LIST_HREF}/${createdId}` : LIST_HREF, t('itad.jobs.flash.created', 'Job created'), 'success'),
        )
      }}
    />
  )
}

export function JobDetailForm({ id }: { id: string }) {
  const t = useT()
  const [job, setJob] = React.useState<ItadJobListItem | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [notFound, setNotFound] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setLoadError(null)
      setNotFound(false)
      try {
        const data = await fetchCrudList<ItadJobListItem>(API_PATH, { id, pageSize: 1 })
        const item = data?.items?.[0]
        if (cancelled) return
        if (!item) setNotFound(true)
        else setJob(item)
      } catch (error: unknown) {
        if (cancelled) return
        if ((error as { status?: number }).status === 404) setNotFound(true)
        else setLoadError(error instanceof Error && error.message ? error.message : t('itad.jobs.form.error.load', 'Could not load the job'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [id, t])

  const editable = job?.editableFields ?? []
  const fields = useJobFields(t, editable, job?.customerName ?? null)
  const summaryGroup = React.useMemo<CrudFormGroup | null>(
    () =>
      job
        ? {
            id: 'summary',
            title: t('itad.jobs.form.groups.summary', 'Summary'),
            column: 2,
            component: () => <JobSummary job={job} t={t} />,
          }
        : null,
    [job, t],
  )
  const groups = useJobGroups(t, summaryGroup)
  const successRedirect = React.useMemo(
    () => withFlash(`${LIST_HREF}/${id}`, t('itad.jobs.flash.saved', 'Job saved'), 'success'),
    [id, t],
  )
  const deleteRedirect = React.useMemo(
    () => withFlash(LIST_HREF, t('itad.jobs.flash.deleted', 'Job deleted'), 'success'),
    [t],
  )

  if (notFound) {
    return (
      <RecordNotFoundState
        label={t('itad.jobs.form.error.notFound', 'ITAD job not found')}
        backHref={LIST_HREF}
        backLabel={t('itad.jobs.form.actions.backToList', 'Back to ITAD jobs')}
      />
    )
  }
  if (loadError) return <ErrorMessage label={loadError} />

  const terminal = job?.status === 'completed' || job?.status === 'cancelled'
  const initialValues: JobFormValues = job
    ? toJobFormValues(job)
    : { id, customerId: '', name: '', customerReference: '', expectedAssetEstimate: null, scheduledPickupAt: null, updatedAt: null }

  return (
    <CrudForm<JobFormValues>
      key={job?.updatedAt ?? 'loading'}
      title={job ? `${job.internalReference} · ${job.name}` : t('itad.jobs.detail.title', 'ITAD job')}
      titleHeadingLevel={1}
      backHref={LIST_HREF}
      entityId={ENTITY_ID}
      injectionSpotId="crud-form:itad.itad_job"
      fields={fields}
      groups={groups}
      initialValues={initialValues}
      submitLabel={t('itad.jobs.detail.submit', 'Save')}
      cancelHref={LIST_HREF}
      successRedirect={successRedirect}
      deleteRedirect={deleteRedirect}
      isLoading={loading}
      loadingMessage={t('itad.jobs.form.loading', 'Loading job…')}
      readOnly={terminal}
      onSubmit={async (values) => {
        await updateCrud(API_PATH, { id, ...toJobPayload(values) })
      }}
      onDelete={job?.status === 'draft' ? async () => { await deleteCrud(API_PATH, id) } : undefined}
    />
  )
}

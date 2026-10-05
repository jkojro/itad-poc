"use client"
import * as React from 'react'
import type { LegacyColumnDef as ColumnDef } from '@tanstack/react-table/legacy'
import { StatusBadge } from '@open-mercato/ui/primitives/status-badge'
import type { useT } from '@open-mercato/shared/lib/i18n/context'
import {
  ITAD_JOB_STATUS_FALLBACK_LABELS,
  ITAD_JOB_STATUS_VARIANTS,
  itadJobStatusLabelKey,
} from './job-status'
import type { ItadJobListItem } from './types'

type Translate = ReturnType<typeof useT>

function formatDateTime(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()
}

/** Shared ITAD job table columns (main list and the company "ITAD Jobs" tab). */
export function buildJobColumns(
  t: Translate,
  options: { includeCustomer?: boolean } = {},
): ColumnDef<ItadJobListItem>[] {
  const includeCustomer = options.includeCustomer ?? true
  return [
    {
      id: 'reference',
      accessorKey: 'internalReference',
      header: t('itad.jobs.table.column.reference', 'Reference'),
      meta: { priority: 1 },
      cell: ({ row }) => (
        <span className="flex flex-col">
          <span className="font-medium">{row.original.internalReference}</span>
          {row.original.customerReference ? (
            <span className="text-xs text-muted-foreground">{row.original.customerReference}</span>
          ) : null}
        </span>
      ),
    },
    { accessorKey: 'name', header: t('itad.jobs.table.column.name', 'Name'), meta: { priority: 2 } },
    ...(!includeCustomer ? [] : [{
      accessorKey: 'customerName',
      header: t('itad.jobs.table.column.customer', 'Customer'),
      enableSorting: false,
      meta: { priority: 3 },
      cell: ({ row }) =>
        row.original.customerName ?? (
          <span className="text-muted-foreground">{t('itad.jobs.customer.deleted', 'Deleted customer')}</span>
        ),
    } satisfies ColumnDef<ItadJobListItem>]),
    {
      accessorKey: 'status',
      header: t('itad.jobs.table.column.status', 'Status'),
      meta: { priority: 1 },
      cell: ({ row }) => (
        <StatusBadge variant={ITAD_JOB_STATUS_VARIANTS[row.original.status] ?? 'neutral'} dot>
          {t(itadJobStatusLabelKey(row.original.status), ITAD_JOB_STATUS_FALLBACK_LABELS[row.original.status])}
        </StatusBadge>
      ),
    },
    {
      id: 'scheduledPickupAt',
      accessorKey: 'scheduledPickupAt',
      header: t('itad.jobs.table.column.scheduledPickupAt', 'Scheduled pickup'),
      meta: { priority: 4 },
      cell: ({ row }) => formatDateTime(row.original.scheduledPickupAt),
    },
    {
      id: 'updatedAt',
      accessorKey: 'updatedAt',
      header: t('itad.jobs.table.column.updatedAt', 'Updated'),
      meta: { priority: 5 },
      cell: ({ row }) => formatDateTime(row.original.updatedAt),
    },
  ]
}

"use client"
import * as React from 'react'
import { useSearchParams } from 'next/navigation'
import type { FilterValues } from '@open-mercato/ui/backend/FilterBar'

/**
 * Initial filter values of a job tab, read once from the URL (operations dashboard spec
 * "Job Overview"): a link such as `?tab=manifest&reconciliation=missing` opens the tab
 * already filtered. Only the listed keys and values are accepted; anything else is ignored.
 */
export function useInitialUrlFilters(allowed: Record<string, readonly string[]>, defaults: FilterValues = {}): FilterValues {
  const searchParams = useSearchParams()
  const [initial] = React.useState<FilterValues>(() => {
    const values: FilterValues = { ...defaults }
    for (const [key, options] of Object.entries(allowed)) {
      const value = searchParams?.get(key)
      if (value && options.includes(value)) values[key] = value
    }
    return values
  })
  return initial
}

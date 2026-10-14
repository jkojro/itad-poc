"use client"

import * as React from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import type { InjectionWidgetComponentProps } from '@open-mercato/shared/modules/widgets/injection'
import { Alert, AlertDescription, AlertTitle } from '@open-mercato/ui/primitives/alert'
import { Button } from '@open-mercato/ui/primitives/button'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { PICKUP_TASK_INTERACTION_TYPE } from '../../../domain/pickup-task'

type FormData = { id?: unknown; category?: unknown; interactionType?: unknown }
type LookupResult = { jobId: string; reference: string }

/**
 * The calendar editor passes the interaction type as `category`, other interaction forms
 * as `interactionType`; only a saved pickup task (with an `id`) is looked up.
 */
function pickupTaskId(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null
  const values = data as FormData
  const type = typeof values.category === 'string' ? values.category : values.interactionType
  if (type !== PICKUP_TASK_INTERACTION_TYPE) return null
  return typeof values.id === 'string' && values.id ? values.id : null
}

export default function PickupTaskJobLinkWidget({ data }: InjectionWidgetComponentProps) {
  const t = useT()
  const interactionId = pickupTaskId(data)
  const lookup = useQuery<LookupResult | null>({
    queryKey: ['itad-pickup-task-lookup', interactionId],
    enabled: Boolean(interactionId),
    staleTime: 60 * 1000,
    queryFn: async () => {
      const call = await apiCall<LookupResult>(
        `/api/itad/pickup-tasks/lookup?interactionId=${encodeURIComponent(interactionId ?? '')}`,
      )
      return call.ok && call.result ? call.result : null
    },
  })
  if (!interactionId || !lookup.data) return null
  const { jobId, reference } = lookup.data
  return (
    <Alert status="information" data-testid="itad-pickup-task-job-link">
      <AlertTitle>{t('itad.pickupTask.widget.title', 'ITAD pickup {reference}', { reference })}</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>
          {t(
            'itad.pickupTask.widget.description',
            'This entry comes from an ITAD job. Change the pickup date and details on the job.',
          )}
        </p>
        <Button asChild size="sm" variant="outline">
          <Link href={`/backend/itad/jobs/${encodeURIComponent(jobId)}`}>
            {t('itad.pickupTask.widget.goToJob', 'Go to job')}
          </Link>
        </Button>
      </AlertDescription>
    </Alert>
  )
}

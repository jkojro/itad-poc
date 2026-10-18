"use client"
import * as React from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Alert, AlertDescription } from '@open-mercato/ui/primitives/alert'
import { Spinner } from '@open-mercato/ui/primitives/spinner'
import { AiIcon } from '@open-mercato/ui/ai/AiIcon'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { ITAD_JOB_ENTITY_ID } from '../lib/constants'
import { ITAD_ASSISTANT_AGENT_ID, useItadAssistant } from './use-itad-assistant'

// The chat surface (AI SDK + streaming runtime) loads only when the panel is opened.
const LazyAiChat = React.lazy(async () => {
  const mod = await import('@open-mercato/ui/ai/AiChat')
  return { default: mod.AiChat }
})

/**
 * Inline ITAD assistant on the job page (AI assistant spec Q3, Q8): bound to
 * `itad.operations_assistant` with this job as page context, collapsed by default.
 */
export function ItadAssistantPanel({ jobId }: { jobId: string }) {
  const t = useT()
  const assistant = useItadAssistant()
  const [open, setOpen] = React.useState(false)
  const panelId = `itad-assistant-panel-${jobId}`
  if (assistant.state === 'hidden') return null

  const title = t('itad.ai.panel.title', 'AI assistant')
  const suggestions = [
    { label: t('itad.ai.suggestion.blockers', 'Why can\'t this job be completed?'), prompt: t('itad.ai.suggestion.blockersPrompt', 'Why can\'t this job be completed?') },
    { label: t('itad.ai.suggestion.sanitization', 'Summarize sanitization'), prompt: t('itad.ai.suggestion.sanitizationPrompt', 'Summarize the sanitization of this job.') },
    { label: t('itad.ai.suggestion.customerStatus', 'Draft a status update for the customer'), prompt: t('itad.ai.suggestion.customerStatusPrompt', 'Draft a short status update for the customer of this job.') },
  ]

  return (
    <section className="rounded-lg border bg-card" aria-label={title} data-testid="itad-assistant-panel">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
        <AiIcon className="h-4 w-4" aria-hidden />
        {title}
      </button>
      {open ? (
        <div id={panelId} className="border-t p-4">
          {assistant.state === 'loading' ? (
            <Spinner className="h-5 w-5" />
          ) : assistant.state === 'not_configured' ? (
            <Alert status="information" data-testid="itad-assistant-not-configured">
              <AlertDescription>{t('itad.ai.notConfigured', 'The AI assistant is not configured. Ask an administrator to set up an AI provider.')}</AlertDescription>
            </Alert>
          ) : (
            <div className="h-96 overflow-hidden rounded-md border">
              <React.Suspense fallback={<Spinner className="m-4 h-5 w-5" />}>
                {/* Remount per job so one job's conversation never carries into another. */}
                <LazyAiChat
                  key={`${ITAD_ASSISTANT_AGENT_ID}:${jobId}`}
                  agent={ITAD_ASSISTANT_AGENT_ID}
                  pageContext={{ pageId: 'itad.job', entityType: ITAD_JOB_ENTITY_ID, recordId: jobId }}
                  className="h-full"
                  placeholder={t('itad.ai.placeholder', 'Ask about this job…')}
                  welcomeTitle={t('itad.ai.welcome', 'Ask about this job')}
                  suggestions={suggestions}
                />
              </React.Suspense>
            </div>
          )}
        </div>
      ) : null}
    </section>
  )
}

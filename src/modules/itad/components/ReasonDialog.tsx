"use client"
import * as React from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Alert, AlertDescription } from '@open-mercato/ui/primitives/alert'
import { FormField } from '@open-mercato/ui/primitives/form-field'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { Spinner } from '@open-mercato/ui/primitives/spinner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@open-mercato/ui/primitives/dialog'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { RECEIVING_NOTE_MAX, RECEIVING_NOTE_MIN } from '../domain/receiving-rules'

/**
 * Asks for a required reason (3–1000 characters) before an audited action. `onSubmit`
 * returns an error message to show, or `null` when the action succeeded (the dialog then
 * closes). Cmd/Ctrl+Enter submits.
 */
export function ReasonDialog({
  open,
  title,
  description,
  submitLabel,
  destructive,
  onSubmit,
  onClose,
}: {
  open: boolean
  title: string
  description?: string
  submitLabel: string
  destructive?: boolean
  onSubmit: (reason: string) => Promise<string | null>
  onClose: () => void
}) {
  const t = useT()
  const [reason, setReason] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const fieldId = React.useId()
  React.useEffect(() => {
    if (!open) return
    setReason('')
    setSubmitting(false)
    setError(null)
  }, [open])

  const trimmed = reason.trim()
  const canSubmit = !submitting && trimmed.length >= RECEIVING_NOTE_MIN && trimmed.length <= RECEIVING_NOTE_MAX

  const submit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    const failure = await onSubmit(trimmed)
    if (failure === null) {
      onClose()
      return
    }
    setSubmitting(false)
    setError(failure)
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !submitting) onClose() }}>
      <DialogContent
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            void submit()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <FormField
          label={t('itad.sanitization.reason.label', 'Reason')}
          description={t('itad.sanitization.reason.hint', '3–1000 characters. Avoid personal data.')}
          required
          id={fieldId}
        >
          <Textarea id={fieldId} value={reason} maxLength={RECEIVING_NOTE_MAX} onChange={(event) => setReason(event.target.value)} />
        </FormField>
        {error ? (
          <Alert status="error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
            {t('itad.sanitization.actions.cancel', 'Cancel')}
          </Button>
          <Button type="button" variant={destructive ? 'destructive' : 'default'} onClick={() => void submit()} disabled={!canSubmit}>
            {submitting ? <Spinner className="mr-2 h-4 w-4" /> : null}
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

"use client"
import * as React from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { Checkbox } from '@open-mercato/ui/primitives/checkbox'
import { Label } from '@open-mercato/ui/primitives/label'
import { FormField } from '@open-mercato/ui/primitives/form-field'
import { Alert, AlertDescription } from '@open-mercato/ui/primitives/alert'
import { Spinner } from '@open-mercato/ui/primitives/spinner'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@open-mercato/ui/primitives/dialog'
import { apiCall, withScopedApiRequestHeaders } from '@open-mercato/ui/backend/utils/apiCall'
import { buildOptimisticLockHeader } from '@open-mercato/ui/backend/utils/optimisticLock'
import { surfaceRecordConflict } from '@open-mercato/ui/backend/conflicts'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useT } from '@open-mercato/shared/lib/i18n/context'

type Props = {
  open: boolean
  messageId: string
  updatedAt: string
  to: string
  defaultSubject: string
  draft: string
  /** An earlier send never finished recording: the email may already have been delivered. */
  unconfirmed: boolean
  onClose: () => void
  onSent: () => void
}

/**
 * Phase 4 Send (spec "Phase 4 — Send the reply"): the recipient is fixed to the customer,
 * subject and body are the operator's last edit; sending cannot be undone, so it is always
 * confirmed here, and a retry after an unfinished send needs an explicit acknowledgement.
 */
export function InboxReplyDialog({ open, messageId, updatedAt, to, defaultSubject, draft, unconfirmed, onClose, onSent }: Props) {
  const t = useT()
  const [subject, setSubject] = React.useState(defaultSubject)
  const [body, setBody] = React.useState(draft)
  const [acknowledged, setAcknowledged] = React.useState(false)
  const [sending, setSending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) return
    setSubject(defaultSubject)
    setBody(draft)
    setAcknowledged(false)
    setError(null)
  }, [open, defaultSubject, draft])

  const send = async () => {
    setSending(true)
    setError(null)
    try {
      const call = await withScopedApiRequestHeaders(buildOptimisticLockHeader(updatedAt), () =>
        apiCall<{ error?: string }>(`/api/itad/inbox/messages/${messageId}/reply`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ subject: subject.trim(), body: body.trim(), ...(unconfirmed ? { confirmPossibleDuplicate: true } : {}) }),
        }),
      )
      setSending(false)
      if (call.ok) {
        flash(t('itad.inbox.reply.sent', 'Reply sent to {to}', { to }), 'success')
        onSent()
        return
      }
      setError(typeof call.result?.error === 'string' ? call.result.error : t('itad.inbox.errors.send_failed', 'The email could not be sent; try again'))
    } catch (err) {
      setSending(false)
      if (surfaceRecordConflict(err, t)) onSent()
      else setError(t('itad.inbox.errors.send_failed', 'The email could not be sent; try again'))
    }
  }

  const valid = subject.trim().length > 0 && body.trim().length > 0 && (!unconfirmed || acknowledged)
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !sending) onClose() }}>
      <DialogContent data-testid="itad-inbox-reply-dialog">
        <DialogHeader>
          <DialogTitle>{t('itad.inbox.reply.title', 'Send the reply')}</DialogTitle>
          <DialogDescription>
            {t('itad.inbox.reply.description', 'The customer can answer it; their reply comes back to this Inbox.')}
          </DialogDescription>
        </DialogHeader>
        <FormField label={t('itad.inbox.reply.to', 'To')}>
          <Input value={to} readOnly aria-readonly="true" />
        </FormField>
        <FormField label={t('itad.inbox.reply.subject', 'Subject')}>
          <Input value={subject} onChange={(event) => setSubject(event.target.value)} maxLength={300} />
        </FormField>
        <FormField label={t('itad.inbox.reply.body', 'Message')}>
          <Textarea rows={10} value={body} onChange={(event) => setBody(event.target.value)} maxLength={20000} />
        </FormField>
        {unconfirmed ? (
          <Alert status="warning">
            <AlertDescription>
              <span className="block">
                {t('itad.inbox.reply.unconfirmed', 'A previous send may have succeeded. Sending again could deliver a duplicate.')}
              </span>
              <span className="mt-2 flex items-center gap-2">
                <Checkbox id="itad-inbox-reply-ack" checked={acknowledged} onCheckedChange={(checked) => setAcknowledged(checked === true)} />
                <Label htmlFor="itad-inbox-reply-ack">{t('itad.inbox.reply.acknowledge', 'Send anyway')}</Label>
              </span>
            </AlertDescription>
          </Alert>
        ) : null}
        <Alert status="warning">
          <AlertDescription>{t('itad.inbox.reply.irreversible', 'This email cannot be recalled.')}</AlertDescription>
        </Alert>
        {error ? (
          <Alert status="error"><AlertDescription>{error}</AlertDescription></Alert>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={sending}>
            {t('itad.sanitization.actions.cancel', 'Cancel')}
          </Button>
          <Button type="button" onClick={() => void send()} disabled={sending || !valid} data-testid="itad-inbox-reply-confirm">
            {sending ? <Spinner className="mr-2 h-4 w-4" /> : null}
            {t('itad.inbox.reply.confirm', 'Send')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

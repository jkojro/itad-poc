import type { JobContext, QueuedJob, WorkerMeta } from '@open-mercato/queue'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { ITAD_INBOX_ATTEMPTS, ITAD_INBOX_QUEUE, type InboxProcessJob } from '../lib/inbox-queue'
import { processInboxMessage } from '../services/inbox-processor'

/**
 * ITAD Inbox Ops processing (spec "Architecture"): matching, interpretation and the
 * proposal of one message generation. Retried by the queue; the last attempt marks the
 * message `failed` (operator: Reprocess). Writes once per generation, so duplicates and
 * retries are harmless.
 */
export const metadata: WorkerMeta = {
  queue: ITAD_INBOX_QUEUE,
  id: 'itad:inbox-process',
  concurrency: 2,
}

export default async function handle(job: QueuedJob<InboxProcessJob>, ctx: JobContext): Promise<void> {
  const container = await createRequestContainer()
  await processInboxMessage(container, job.payload, { finalAttempt: ctx.attemptNumber >= ITAD_INBOX_ATTEMPTS })
}

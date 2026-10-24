import { createModuleQueue, type Queue } from '@open-mercato/queue'

/** Queue of ITAD Inbox Ops processing: one job per (message, generation); the worker writes once per generation. */
export const ITAD_INBOX_QUEUE = 'itad-inbox'

/** Attempts per job (queue default); the last failed attempt marks the message `failed`. */
export const ITAD_INBOX_ATTEMPTS = 3

export type InboxProcessJob = { messageId: string; tenantId: string; organizationId: string; generation: number }

let queue: Queue<InboxProcessJob> | null = null

export function getInboxQueue(): Queue<InboxProcessJob> {
  if (!queue) queue = createModuleQueue<InboxProcessJob>(ITAD_INBOX_QUEUE, { concurrency: 2 })
  return queue
}

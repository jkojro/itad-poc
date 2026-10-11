import { createLogger } from '@open-mercato/shared/lib/logger'
import { emitItadEvent } from '../events'
import type { ExceptionChange } from '../services/exception-writer'

const logger = createLogger('itad').child({ component: 'exceptions' })

/**
 * Emits `itad.exception.created` / `.resolved` for the changes a command committed. Runs
 * after commit; a failed emit is logged and never undoes the write (correctness never
 * depends on these events, E4-072).
 */
export async function emitExceptionChanges(changes: ExceptionChange[], actorUserId: string | null): Promise<void> {
  for (const { kind, exception } of changes) {
    const base = {
      exceptionId: exception.id,
      jobId: exception.job.id,
      tenantId: exception.tenantId,
      organizationId: exception.organizationId,
    }
    try {
      if (kind === 'created') {
        await emitItadEvent(
          'itad.exception.created',
          { ...base, type: exception.type, sourceKey: exception.sourceKey, assetId: exception.asset?.id ?? null },
          { persistent: true },
        )
      } else {
        await emitItadEvent(
          'itad.exception.resolved',
          { ...base, type: exception.type, outcome: exception.resolutionOutcome, actorUserId },
          { persistent: true },
        )
      }
    } catch (err) {
      logger.error(`Failed to emit itad.exception.${kind}`, { err, exceptionId: exception.id })
    }
  }
}

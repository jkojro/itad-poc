import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import type {
  CommandInterceptor,
  CommandInterceptorBeforeResult,
  CommandInterceptorContext,
} from '@open-mercato/shared/lib/commands/command-interceptor'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { ItadJobPickupTask } from '../data/entities'
import { PICKUP_TASK_INTERACTION_TYPE } from '../domain/pickup-task'
import { isPickupSyncActive } from '../lib/pickup-sync-scope'

/**
 * Pickup task guard (pickup calendar spec "Protection", TODO-501). The ITAD job is the
 * source of truth for its pickup tasks, so the guard sits on the `customers` interaction
 * commands themselves: every caller goes through the command bus, whichever route, page,
 * AI tool or module it comes from.
 *
 * | Command                                  | Caller            | Result  |
 * |------------------------------------------|-------------------|---------|
 * | create with `itad-pickup`                | anyone but sync   | blocked |
 * | update / complete / cancel, linked task  | anyone but sync   | blocked |
 * | update of another interaction → pickup type | anyone but sync | blocked |
 * | delete, linked task                      | everyone, sync too | blocked: history stays |
 *
 * "Sync" is the async-local marker set by `runAsPickupSync` (see `lib/pickup-sync-scope.ts`),
 * never `auth === null` alone. A linked task is any interaction with a row in
 * `itad_job_pickup_tasks`, current or historical. Rejections carry a stable `code` and 422.
 */
export const PICKUP_TASK_LOCKED = 'itad_pickup_task_locked'
export const PICKUP_TYPE_RESERVED = 'itad_pickup_type_reserved'

type Guarded = 'create' | 'update' | 'complete' | 'cancel' | 'delete'

const readId = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null)

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** `{ id }`, or the delete route's `{ body: { id } }` / `{ query: { id } }` shapes. */
export function interactionIdOf(input: unknown): string | null {
  const record = asRecord(input)
  if (!record) return null
  return readId(record.id) ?? readId(asRecord(record.body)?.id) ?? readId(asRecord(record.query)?.id)
}

async function findLink(context: CommandInterceptorContext, interactionId: string): Promise<{ reference: string } | null> {
  const where: Record<string, unknown> = { interactionId }
  // A user only learns about pickup tasks of their own tenant (and selected organization).
  if (context.auth?.tenantId) where.tenantId = context.auth.tenantId
  if (context.auth && context.selectedOrganizationId) where.organizationId = context.selectedOrganizationId
  const em = context.container.resolve<EntityManager>('em').fork()
  const link = await em.findOne(ItadJobPickupTask, where as FilterQuery<ItadJobPickupTask>, { populate: ['job'] })
  return link ? { reference: link.job.internalReference } : null
}

async function locked(reference: string): Promise<CommandInterceptorBeforeResult> {
  const { translate } = await resolveTranslations()
  const message = translate(
    'itad.pickupTask.errors.locked',
    'The date and details of this pickup can only be changed on ITAD job {reference}.',
    { reference },
  )
  return { ok: false, message, status: 422, body: { error: message, code: PICKUP_TASK_LOCKED, reference } }
}

async function reserved(): Promise<CommandInterceptorBeforeResult> {
  const { translate } = await resolveTranslations()
  const message = translate('itad.pickupTask.errors.typeReserved', 'This activity type is reserved for ITAD pickups.')
  return { ok: false, message, status: 422, body: { error: message, code: PICKUP_TYPE_RESERVED } }
}

export async function guardPickupTask(
  kind: Guarded,
  input: unknown,
  context: CommandInterceptorContext,
): Promise<CommandInterceptorBeforeResult | void> {
  const sync = isPickupSyncActive()
  if (kind === 'create') {
    if (!sync && asRecord(input)?.interactionType === PICKUP_TASK_INTERACTION_TYPE) return reserved()
    return
  }
  const interactionId = interactionIdOf(input)
  if (!interactionId) return
  // Linked first: the calendar editor re-sends `interactionType: 'itad-pickup'` on every
  // save, and the user must see "change it on the job", not "reserved type".
  if (kind === 'delete' || !sync) {
    const link = await findLink(context, interactionId)
    if (link) return locked(link.reference)
  }
  if (kind === 'update' && !sync && asRecord(input)?.interactionType === PICKUP_TASK_INTERACTION_TYPE) return reserved()
}

const guard = (kind: Guarded): CommandInterceptor => ({
  id: `itad.pickup-task-guard.${kind}`,
  targetCommand: `customers.interactions.${kind}`,
  priority: 10,
  beforeExecute: (input, context) => guardPickupTask(kind, input, context),
})

export const interceptors: CommandInterceptor[] = [
  guard('create'),
  guard('update'),
  guard('complete'),
  guard('cancel'),
  guard('delete'),
]

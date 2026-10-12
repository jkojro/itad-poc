import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import type { ApiInterceptor, InterceptorRequest } from '@open-mercato/shared/lib/crud/api-interceptor'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { ItadJobPickupTask } from '../data/entities'
import { PICKUP_TASK_INTERACTION_TYPE } from '../domain/pickup-task'

/**
 * Pickup tasks are a projection of the ITAD job (pickup calendar spec "Protection"):
 * the job is the only place to change a pickup. Rejects, on the installed `customers`
 * interactions route:
 * - `PUT` / `DELETE` of any interaction that has a pickup task link (current or history);
 * - `POST` / `PUT` that sets the reserved `itad-pickup` type.
 *
 * The `itad` sync calls the `customers` commands directly, not this route, so it is not
 * affected. 422, not 409: the calendar shows a 409 as an optimistic-lock conflict.
 */
const readId = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null)

function interactionIdOf(request: InterceptorRequest): string | null {
  return readId(request.body?.id) ?? readId(request.query?.id)
}

export const interceptors: ApiInterceptor[] = [
  {
    id: 'itad.pickup-task-guard',
    targetRoute: 'customers/interactions',
    methods: ['POST', 'PUT', 'DELETE'],
    priority: 100,
    async before(request, context) {
      if (request.method !== 'DELETE' && request.body?.interactionType === PICKUP_TASK_INTERACTION_TYPE) {
        const { translate } = await resolveTranslations()
        return {
          ok: false,
          statusCode: 422,
          message: translate('itad.pickupTask.errors.typeReserved', 'This activity type is reserved for ITAD pickups.'),
        }
      }
      if (request.method === 'POST') return { ok: true }
      const interactionId = interactionIdOf(request)
      if (!interactionId || !context.tenantId) return { ok: true }

      const em = (context.em as EntityManager).fork()
      const filter: Record<string, unknown> = { tenantId: context.tenantId, interactionId }
      if (context.organizationId) filter.organizationId = context.organizationId
      const link = await em.findOne(ItadJobPickupTask, filter as FilterQuery<ItadJobPickupTask>, { populate: ['job'] })
      if (!link) return { ok: true }

      const { translate } = await resolveTranslations()
      return {
        ok: false,
        statusCode: 422,
        message: translate('itad.pickupTask.errors.locked', 'Change the pickup on ITAD job {reference}.', {
          reference: link.job.internalReference,
        }),
      }
    },
  },
]

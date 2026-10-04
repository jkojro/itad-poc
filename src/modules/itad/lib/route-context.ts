import type { AwilixContainer } from 'awilix'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import type { CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { CrudHttpError, isCrudHttpError, notFound } from '@open-mercato/shared/lib/crud/errors'
import { getCommandInterceptorHttpRejection } from '@open-mercato/shared/lib/commands/errors'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { ItadJob } from '../data/entities'

const logger = createLogger('itad').child({ component: 'routes' })

export const jobIdParamsSchema = z.object({ id: z.string().uuid() })

export type ItadRouteContext = {
  container: AwilixContainer
  ctx: CommandRuntimeContext
  tenantId: string
  userId: string
  /** `null` = every organization of the tenant the user may see. */
  readableOrganizationIds: string[] | null
}

/** Trusted auth + organization scope for hand-written `itad` routes (cookie or bearer auth). */
export async function resolveItadRouteContext(request: Request): Promise<ItadRouteContext> {
  const container = await createRequestContainer()
  const auth = await getAuthFromRequest(request)
  if (!auth?.tenantId || !auth.sub) {
    const { translate } = await resolveTranslations()
    throw new CrudHttpError(401, { error: translate('itad.jobs.errors.unauthorized', 'Unauthorized') })
  }
  const scope = await resolveOrganizationScopeForRequest({ container, auth, request })
  const selectedOrganizationId = scope?.selectedId ?? auth.orgId ?? null
  const ctx: CommandRuntimeContext = {
    container,
    auth,
    organizationScope: scope,
    selectedOrganizationId,
    organizationIds: scope?.filterIds ?? (auth.orgId ? [auth.orgId] : null),
    request,
  }
  const readableOrganizationIds = scope
    ? scope.filterIds ?? null
    : selectedOrganizationId
      ? [selectedOrganizationId]
      : []
  return { container, ctx, tenantId: auth.tenantId, userId: auth.sub, readableOrganizationIds }
}

/** Loads a job readable in the request scope, or throws the standardized 404 (no existence leak). */
export async function loadReadableJob(route: ItadRouteContext, id: string): Promise<ItadJob> {
  const em = route.container.resolve<EntityManager>('em').fork()
  const where: Record<string, unknown> = { id, tenantId: route.tenantId, deletedAt: null }
  if (route.readableOrganizationIds !== null) where.organizationId = { $in: route.readableOrganizationIds }
  const job = await em.findOne(ItadJob, where as FilterQuery<ItadJob>)
  if (!job) {
    const { translate } = await resolveTranslations()
    throw notFound(translate('itad.jobs.errors.not_found', 'ITAD job not found'))
  }
  return job
}

export function itadRouteErrorResponse(err: unknown, operation: string): Response {
  if (isCrudHttpError(err)) return NextResponse.json(err.body, { status: err.status })
  const interceptorRejection = getCommandInterceptorHttpRejection(err)
  if (interceptorRejection) {
    return NextResponse.json(interceptorRejection.body, { status: interceptorRejection.status })
  }
  if (err instanceof z.ZodError) {
    return NextResponse.json({ error: 'Invalid input', details: err.issues }, { status: 400 })
  }
  logger.error('ITAD route failed', { err, operation })
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
}

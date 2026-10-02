import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import { forbidden } from '@open-mercato/shared/lib/crud/errors'
import {
  runCrudMutationGuardAfterSuccess,
  validateCrudMutationGuard,
} from '@open-mercato/shared/lib/crud/mutation-guard'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import type { RbacService } from '@open-mercato/core/modules/auth/services/rbacService'
import {
  ITAD_JOB_LOCK_RESOURCE_KIND,
  itadJobTransitionSchema,
  type ItadJobTransitionResult,
} from '../../../../commands/transition'
import { ITAD_JOB_STATUSES } from '../../../../data/entities'
import { isCompanyInScope } from '../../../../lib/customer-lookup'
import { ITAD_JOB_CONDITIONS, ITAD_JOB_CONDITION_KEYS, evaluateConditions } from '../../../../lib/job-conditions'
import { ITAD_JOB_ACTIONS, ITAD_JOB_TRANSITIONS, availableActions, resolveTargetStatus } from '../../../../lib/job-state-machine'
import {
  itadRouteErrorResponse,
  jobIdParamsSchema,
  loadReadableJob,
  resolveItadRouteContext,
  type ItadRouteContext,
} from '../../../../lib/route-context'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['itad.jobs.view'] },
  POST: { requireAuth: true, requireFeatures: ['itad.jobs.transition'] },
}

async function hasFeatures(route: ItadRouteContext, features: string[], organizationId: string | null): Promise<boolean> {
  const rbac = route.container.resolve<RbacService>('rbacService')
  return rbac.userHasAllFeatures(route.userId, features, { tenantId: route.tenantId, organizationId })
}

/** Read model for the status menu: which actions are possible now and why not. */
export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    const { id } = jobIdParamsSchema.parse({ id: params?.id })
    const route = await resolveItadRouteContext(request)
    const job = await loadReadableJob(route, id)
    const [canTransition, canConfirm] = await Promise.all([
      hasFeatures(route, ['itad.jobs.transition'], job.organizationId),
      hasFeatures(route, ['itad.jobs.confirm_conditions'], job.organizationId),
    ])
    const queryEngine = route.container.resolve<QueryEngine>('queryEngine')
    const scope = { tenantId: route.tenantId, organizationId: job.organizationId }
    const deps = { isCustomerValid: (customerId: string) => isCompanyInScope(queryEngine, scope, customerId) }

    const actions = []
    for (const action of availableActions(job)) {
      const transition = ITAD_JOB_TRANSITIONS[action]
      const to = resolveTargetStatus(job, action)
      if (!to) continue
      const evaluations = await evaluateConditions(transition.conditions, job, deps)
      const conditions = evaluations.map((evaluation) => {
        const manualAllowed = ITAD_JOB_CONDITIONS[evaluation.key].manualAllowed
        return {
          key: evaluation.key,
          state: evaluation.state,
          manualAllowed,
          canConfirm: evaluation.state === 'confirmation_required' && manualAllowed && canConfirm,
          detailKey: evaluation.detailKey ?? null,
        }
      })
      const satisfiable = conditions.every((condition) => condition.state === 'met' || condition.canConfirm)
      actions.push({
        id: action,
        to,
        reasonRequired: transition.reasonRequired,
        allowed: canTransition && satisfiable,
        conditions,
      })
    }

    return NextResponse.json({
      status: job.status,
      statusBeforeHold: job.statusBeforeHold ?? null,
      updatedAt: job.updatedAt.toISOString(),
      canTransition,
      canConfirm,
      actions,
    })
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.jobs.transitions.get')
  }
}

/** Runs one status change through the `itad.jobs.transition` command. */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const { id } = jobIdParamsSchema.parse({ id: params?.id })
    const route = await resolveItadRouteContext(request)
    const body = await readJsonSafe<Record<string, unknown>>(request, {})
    const input = itadJobTransitionSchema.parse({ ...(body ?? {}), id })

    // Error catalog row 2: confirmations need their own feature, checked before lookup.
    if (input.confirmations && input.confirmations.length > 0) {
      const allowed = await hasFeatures(route, ['itad.jobs.confirm_conditions'], route.ctx.selectedOrganizationId ?? null)
      if (!allowed) {
        const { translate } = await resolveTranslations()
        throw forbidden(translate('itad.jobs.errors.confirm_forbidden', 'You are not allowed to confirm conditions manually'))
      }
    }

    const guardInput = {
      tenantId: route.tenantId,
      organizationId: route.ctx.selectedOrganizationId ?? null,
      userId: route.userId,
      resourceKind: ITAD_JOB_LOCK_RESOURCE_KIND,
      resourceId: id,
      operation: 'custom' as const,
      requestMethod: request.method,
      requestHeaders: request.headers,
    }
    const guardResult = await validateCrudMutationGuard(route.container, { ...guardInput, mutationPayload: input })
    if (guardResult && !guardResult.ok) {
      return NextResponse.json(guardResult.body, { status: guardResult.status })
    }

    const commandBus = route.container.resolve<CommandBus>('commandBus')
    const { result } = await commandBus.execute<typeof input, ItadJobTransitionResult>('itad.jobs.transition', {
      input,
      ctx: route.ctx,
    })

    if (guardResult?.ok && guardResult.shouldRunAfterSuccess) {
      await runCrudMutationGuardAfterSuccess(route.container, { ...guardInput, metadata: guardResult.metadata ?? null })
    }
    return NextResponse.json({
      status: result.status,
      updatedAt: result.updatedAt,
      transitionId: result.transitionId,
    })
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.jobs.transitions.post')
  }
}

const conditionSchema = z.object({
  key: z.enum(ITAD_JOB_CONDITION_KEYS),
  state: z.enum(['met', 'unmet', 'confirmation_required']),
  manualAllowed: z.boolean(),
  canConfirm: z.boolean(),
  detailKey: z.string().nullable(),
})

const transitionsResponseSchema = z.object({
  status: z.enum(ITAD_JOB_STATUSES),
  statusBeforeHold: z.enum(ITAD_JOB_STATUSES).nullable(),
  updatedAt: z.string(),
  canTransition: z.boolean(),
  canConfirm: z.boolean(),
  actions: z.array(
    z.object({
      id: z.enum(ITAD_JOB_ACTIONS),
      to: z.enum(ITAD_JOB_STATUSES),
      reasonRequired: z.boolean(),
      allowed: z.boolean(),
      conditions: z.array(conditionSchema),
    }),
  ),
})

const errorSchema = z.object({ error: z.string(), code: z.string().optional() }).passthrough()

export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'ITAD job status transitions',
  methods: {
    GET: {
      summary: 'List the status changes currently available for a job',
      description: 'Returns every action valid from the current status with its condition states and whether the caller may perform or confirm it.',
      responses: [{ status: 200, description: 'Available transitions', schema: transitionsResponseSchema }],
      errors: [
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Missing itad.jobs.view', schema: errorSchema },
        { status: 404, description: 'Job not found in scope', schema: errorSchema },
      ],
    },
    POST: {
      summary: 'Change the status of a job',
      description:
        'Runs one guarded transition. Send the expected `updatedAt` in the `x-om-ext-optimistic-lock-expected-updated-at` header. Manual confirmations require `itad.jobs.confirm_conditions`.',
      requestBody: { contentType: 'application/json', schema: itadJobTransitionSchema.omit({ id: true }) },
      responses: [
        {
          status: 200,
          description: 'Transition applied',
          schema: z.object({ status: z.enum(ITAD_JOB_STATUSES), updatedAt: z.string(), transitionId: z.string().uuid() }),
        },
      ],
      errors: [
        { status: 400, description: 'Invalid transition, reason, confirmation or unmet condition', schema: errorSchema },
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Missing itad.jobs.transition or itad.jobs.confirm_conditions', schema: errorSchema },
        { status: 404, description: 'Job not found in scope', schema: errorSchema },
        { status: 409, description: 'Stale version or terminal job', schema: errorSchema },
      ],
    },
  },
}

import { NextResponse } from 'next/server'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import {
  runCrudMutationGuardAfterSuccess,
  validateCrudMutationGuard,
} from '@open-mercato/shared/lib/crud/mutation-guard'
import type { ItadRouteContext } from './route-context'

/**
 * Runs one `itad` command from a hand-written route: platform mutation guard before,
 * command bus, guard follow-up after success. Returns the command result, or the
 * guard's rejection as a ready response.
 */
export async function runGuardedCommand<TInput extends Record<string, unknown>, TResult>(
  route: ItadRouteContext,
  request: Request,
  options: {
    commandId: string
    input: TInput
    resourceKind: string
    resourceId: string
    operation: 'create' | 'update' | 'delete' | 'custom'
  },
): Promise<{ ok: true; result: TResult } | { ok: false; response: Response }> {
  const guardInput = {
    tenantId: route.tenantId,
    organizationId: route.ctx.selectedOrganizationId ?? null,
    userId: route.userId,
    resourceKind: options.resourceKind,
    resourceId: options.resourceId,
    operation: options.operation,
    requestMethod: request.method,
    requestHeaders: request.headers,
  }
  const guardResult = await validateCrudMutationGuard(route.container, { ...guardInput, mutationPayload: options.input })
  if (guardResult && !guardResult.ok) {
    return { ok: false, response: NextResponse.json(guardResult.body, { status: guardResult.status }) }
  }
  const commandBus = route.container.resolve<CommandBus>('commandBus')
  const { result } = await commandBus.execute<TInput, TResult>(options.commandId, { input: options.input, ctx: route.ctx })
  if (guardResult?.ok && guardResult.shouldRunAfterSuccess) {
    await runCrudMutationGuardAfterSuccess(route.container, { ...guardInput, metadata: guardResult.metadata ?? null })
  }
  return { ok: true, result }
}

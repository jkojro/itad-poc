import { describe, expect, it, jest } from '@jest/globals'
import type { CommandInterceptorContext } from '@open-mercato/shared/lib/commands/command-interceptor'

jest.mock('@open-mercato/shared/lib/i18n/server', () => ({
  resolveTranslations: async () => ({
    translate: (_key: string, fallback: string, params?: Record<string, string>) =>
      fallback.replace(/\{(\w+)\}/g, (_match, name: string) => params?.[name] ?? ''),
  }),
}))

import { interceptors, PICKUP_TASK_LOCKED, PICKUP_TYPE_RESERVED } from '../interceptors'
import { runAsPickupSync } from '../../lib/pickup-sync-scope'

const TENANT = '11111111-1111-4111-8111-111111111111'
const ORG = '22222222-2222-4222-8222-222222222222'
const OTHER_ORG = '55555555-5555-4555-8555-555555555555'
const LINKED = '33333333-3333-4333-8333-333333333333'
const ORDINARY = '44444444-4444-4444-8444-444444444444'

type Filter = { tenantId?: string; organizationId?: string; interactionId?: string }

/**
 * One stored link (current or history — the guard does not care), in TENANT/ORG, for
 * interaction LINKED of job ITAD-2026-00010.
 */
function context(options: { user?: boolean; organizationId?: string | null } = {}): { ctx: CommandInterceptorContext; filters: Filter[] } {
  const filters: Filter[] = []
  const em = {
    fork: () => em,
    findOne: async (_entity: unknown, filter: Filter) => {
      filters.push(filter)
      const tenantOk = filter.tenantId === undefined || filter.tenantId === TENANT
      const orgOk = filter.organizationId === undefined || filter.organizationId === ORG
      return tenantOk && orgOk && filter.interactionId === LINKED ? { job: { internalReference: 'ITAD-2026-00010' } } : null
    },
  }
  const user = options.user ?? true
  const ctx = {
    commandId: 'x',
    auth: user ? { sub: 'u1', tenantId: TENANT, orgId: ORG } : null,
    selectedOrganizationId: options.organizationId === undefined ? ORG : options.organizationId,
    container: { resolve: () => em },
  } as unknown as CommandInterceptorContext
  return { ctx, filters }
}

const run = (command: string, input: unknown, ctx: CommandInterceptorContext) => {
  const interceptor = interceptors.find((entry) => entry.targetCommand === `customers.interactions.${command}`)!
  return interceptor.beforeExecute!(input, ctx)
}
const asSync = <T>(fn: () => Promise<T>) => runAsPickupSync(fn)

describe('pickup task command guard (pickup calendar spec TODO-501)', () => {
  it('guards every customers interaction command that can touch a pickup task', () => {
    expect(interceptors.map((entry) => entry.targetCommand)).toEqual([
      'customers.interactions.create',
      'customers.interactions.update',
      'customers.interactions.complete',
      'customers.interactions.cancel',
      'customers.interactions.delete',
    ])
  })

  describe('linked pickup task', () => {
    it.each(['update', 'complete', 'cancel', 'delete'])('%s by a user is blocked with the job and a stable code', async (command) => {
      const { ctx } = context()
      const result = await run(command, { id: LINKED, title: 'x' }, ctx)
      expect(result).toMatchObject({
        ok: false,
        status: 422,
        body: { code: PICKUP_TASK_LOCKED, reference: 'ITAD-2026-00010' },
      })
      expect(result && result.message).toContain('can only be changed on ITAD job ITAD-2026-00010')
    })

    it.each(['update', 'complete', 'cancel'])('%s by the ITAD sync is allowed', async (command) => {
      const { ctx } = context({ user: false })
      expect(await asSync(() => run(command, { id: LINKED }, ctx))).toBeUndefined()
    })

    it('delete is blocked even for the ITAD sync: history stays', async () => {
      const { ctx } = context({ user: false })
      expect(await asSync(() => run('delete', { id: LINKED }, ctx))).toMatchObject({ ok: false, body: { code: PICKUP_TASK_LOCKED } })
    })

    it('a system caller without the sync marker is treated like anyone else', async () => {
      const { ctx } = context({ user: false })
      expect(await run('complete', { id: LINKED }, ctx)).toMatchObject({ ok: false, body: { code: PICKUP_TASK_LOCKED } })
    })

    it('reads the id from the delete route shapes too', async () => {
      const { ctx } = context()
      expect(await run('delete', { body: { id: LINKED } }, ctx)).toMatchObject({ ok: false })
      expect(await run('delete', { query: { id: LINKED } }, ctx)).toMatchObject({ ok: false })
    })

    it('a calendar editor save (re-sending the pickup type) gets the job message, not the reserved type', async () => {
      const { ctx } = context()
      expect(await run('update', { id: LINKED, interactionType: 'itad-pickup', title: 'Moved' }, ctx)).toMatchObject({
        body: { code: PICKUP_TASK_LOCKED },
      })
    })
  })

  describe('reserved itad-pickup type', () => {
    it('create with the pickup type by a user is blocked', async () => {
      const { ctx } = context()
      expect(await run('create', { interactionType: 'itad-pickup', entityId: ORDINARY }, ctx)).toMatchObject({
        ok: false,
        status: 422,
        body: { code: PICKUP_TYPE_RESERVED },
      })
    })

    it('create with the pickup type by the ITAD sync is allowed', async () => {
      const { ctx } = context({ user: false })
      expect(await asSync(() => run('create', { interactionType: 'itad-pickup' }, ctx))).toBeUndefined()
    })

    it('retyping an ordinary interaction to the pickup type is blocked', async () => {
      const { ctx } = context()
      expect(await run('update', { id: ORDINARY, interactionType: 'itad-pickup' }, ctx)).toMatchObject({
        body: { code: PICKUP_TYPE_RESERVED },
      })
    })
  })

  describe('ordinary interactions', () => {
    it.each([
      ['create', { interactionType: 'task' }],
      ['update', { id: ORDINARY, title: 'x' }],
      ['complete', { id: ORDINARY }],
      ['cancel', { id: ORDINARY }],
      ['delete', { id: ORDINARY }],
    ])('%s passes', async (command, input) => {
      const { ctx } = context()
      expect(await run(command, input, ctx)).toBeUndefined()
    })
  })

  it('never reveals a job of another organization', async () => {
    const { ctx, filters } = context({ organizationId: OTHER_ORG })
    expect(await run('complete', { id: LINKED }, ctx)).toBeUndefined()
    expect(filters[0]).toEqual({ interactionId: LINKED, tenantId: TENANT, organizationId: OTHER_ORG })
  })
})

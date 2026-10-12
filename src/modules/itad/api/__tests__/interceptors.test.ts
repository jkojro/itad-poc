import { describe, expect, it, jest } from '@jest/globals'
import type { InterceptorContext, InterceptorRequest } from '@open-mercato/shared/lib/crud/api-interceptor'

jest.mock('@open-mercato/shared/lib/i18n/server', () => ({
  resolveTranslations: async () => ({
    translate: (_key: string, fallback: string, params?: Record<string, string>) =>
      fallback.replace(/\{(\w+)\}/g, (_match, name: string) => params?.[name] ?? ''),
  }),
}))

import { interceptors } from '../interceptors'

const guard = interceptors.find((entry) => entry.id === 'itad.pickup-task-guard')!
const TENANT = '11111111-1111-4111-8111-111111111111'
const ORG = '22222222-2222-4222-8222-222222222222'
const LINKED = '33333333-3333-4333-8333-333333333333'

type Filter = { tenantId?: string; organizationId?: string; interactionId?: string }

/** One stored link, in TENANT/ORG, for interaction LINKED of job ITAD-2026-00010. */
function context(): { ctx: InterceptorContext; filters: Filter[] } {
  const filters: Filter[] = []
  const em = {
    fork: () => em,
    findOne: async (_entity: unknown, filter: Filter) => {
      filters.push(filter)
      const match = filter.tenantId === TENANT && filter.organizationId === ORG && filter.interactionId === LINKED
      return match ? { job: { internalReference: 'ITAD-2026-00010' } } : null
    },
  }
  const ctx = { userId: 'u1', tenantId: TENANT, organizationId: ORG, em, container: {} } as unknown as InterceptorContext
  return { ctx, filters }
}

const request = (overrides: Partial<InterceptorRequest>): InterceptorRequest => ({
  method: 'PUT',
  url: 'http://localhost/api/customers/interactions',
  headers: {},
  ...overrides,
})

describe('itad.pickup-task-guard (pickup calendar spec "Protection")', () => {
  it('targets the customers interactions route for POST, PUT and DELETE', () => {
    expect(guard.targetRoute).toBe('customers/interactions')
    expect(guard.methods).toEqual(['POST', 'PUT', 'DELETE'])
  })

  it('rejects an edit of a linked pickup task with 422 naming the job', async () => {
    const { ctx } = context()
    const result = await guard.before!(request({ body: { id: LINKED, title: 'Moved' } }), ctx)
    expect(result).toMatchObject({ ok: false, statusCode: 422 })
    expect(result.message).toContain('ITAD-2026-00010')
  })

  it('rejects a delete of a linked pickup task, id in the query', async () => {
    const { ctx } = context()
    const result = await guard.before!(request({ method: 'DELETE', query: { id: LINKED } }), ctx)
    expect(result).toMatchObject({ ok: false, statusCode: 422 })
  })

  it('lets an ordinary interaction through', async () => {
    const { ctx } = context()
    expect(await guard.before!(request({ body: { id: '44444444-4444-4444-8444-444444444444' } }), ctx)).toEqual({ ok: true })
    expect(await guard.before!(request({ method: 'POST', body: { interactionType: 'task' } }), ctx)).toEqual({ ok: true })
  })

  it('reserves the itad-pickup type on create and update', async () => {
    const { ctx, filters } = context()
    for (const method of ['POST', 'PUT'] as const) {
      const result = await guard.before!(request({ method, body: { interactionType: 'itad-pickup' } }), ctx)
      expect(result).toMatchObject({ ok: false, statusCode: 422 })
    }
    expect(filters).toHaveLength(0)
  })

  it('looks the link up only in the caller tenant and organization', async () => {
    const { ctx, filters } = context()
    const foreign = { ...ctx, organizationId: '55555555-5555-4555-8555-555555555555' } as InterceptorContext
    expect(await guard.before!(request({ body: { id: LINKED } }), foreign)).toEqual({ ok: true })
    expect(filters[0]).toMatchObject({ tenantId: TENANT, organizationId: '55555555-5555-4555-8555-555555555555', interactionId: LINKED })
  })
})

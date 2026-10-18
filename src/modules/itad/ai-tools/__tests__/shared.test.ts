import { beforeEach, describe, expect, it, jest } from '@jest/globals'

const run = jest.fn(async (_request: unknown) => ({ success: true, statusCode: 200, data: { ok: true } }))
const createRunner = jest.fn((_ctx: unknown) => ({ run }))
jest.mock('@open-mercato/ai-assistant/modules/ai_assistant/lib/ai-api-operation-runner', () => ({
  createAiApiOperationRunner: (ctx: unknown) => createRunner(ctx),
}))

import { itadPath, routeData, routeErrorCode, runItadRoute, ItadToolError, type ItadToolContext } from '../_shared'

const tool = { name: 'itad.test', description: 't', inputSchema: {}, requiredFeatures: ['itad.jobs.view'], handler: async () => null } as never
const ctx = (features: string[]): ItadToolContext =>
  ({ tenantId: 't1', organizationId: 'o1', userId: 'u1', container: {}, userFeatures: features, isSuperAdmin: false }) as never

describe('runItadRoute (defense in depth)', () => {
  beforeEach(() => {
    run.mockClear()
    createRunner.mockClear()
  })

  it('refuses an extra feature the caller does not hold, without calling the route', async () => {
    await expect(runItadRoute(ctx(['itad.jobs.view']), tool, { method: 'GET', path: '/jobs/x/certificates' }, ['itad.certificates.view'])).rejects.toMatchObject({
      code: 'forbidden',
    })
    expect(run).not.toHaveBeenCalled()
  })

  it('passes held extra features to the runner and prefixes the path', async () => {
    await runItadRoute(ctx(['itad.*']), tool, { method: 'GET', path: '/jobs/x/certificates' }, ['itad.certificates.view'])
    const runnerCtx = createRunner.mock.calls[0][0] as { tool: { requiredFeatures: string[] } }
    expect(runnerCtx.tool.requiredFeatures).toEqual(['itad.jobs.view', 'itad.certificates.view'])
    expect(run).toHaveBeenCalledWith({ method: 'GET', path: '/itad/jobs/x/certificates' })
  })
})

describe('itadPath', () => {
  it('keeps /itad and /itad/… and prefixes everything else', () => {
    expect(itadPath('/itad')).toBe('/itad')
    expect(itadPath('/itad/jobs')).toBe('/itad/jobs')
    expect(itadPath('/jobs')).toBe('/itad/jobs')
    expect(itadPath('/itadministrator')).toBe('/itad/itadministrator')
  })
})

describe('routeData error handling', () => {
  it('reads 404 as not found and never passes the raw route error on', () => {
    expect(routeData({ success: false, statusCode: 404, error: 'missing' }, 'Asset lookup')).toBeNull()
    const failure = (() => {
      try {
        routeData({ success: false, statusCode: 500, error: 'duplicate key violates constraint itad_assets_pkey' }, 'Asset lookup')
      } catch (err) {
        return err as ItadToolError
      }
    })()
    expect(failure).toMatchObject({ code: 'route_failed', message: 'Asset lookup failed' })
    expect(failure!.message).not.toContain('constraint')
  })

  it('maps statuses to stable codes', () => {
    expect([404, 401, 403, 409, 412, 500, 400].map(routeErrorCode)).toEqual([
      'not_found',
      'forbidden',
      'forbidden',
      'conflict',
      'conflict',
      'route_failed',
      'route_failed',
    ])
  })
})

import { beforeEach, describe, expect, it, jest } from '@jest/globals'

const responses: Array<{ success: boolean; statusCode: number; data?: unknown }> = []
jest.mock('../_shared', () => {
  const actual = jest.requireActual<typeof import('../_shared')>('../_shared')
  return { ...actual, runItadRoute: jest.fn(async () => responses.shift()) }
})
jest.mock('../_writes', () => ({
  requireApprovedAction: jest.fn(async () => {
    const { ItadToolError } = jest.requireActual<typeof import('../_shared')>('../_shared')
    throw new ItadToolError('approval_required', 'This change needs a confirmed preview')
  }),
  runApprovedWrite: jest.fn(),
}))
jest.mock('@open-mercato/shared/lib/i18n/server', () => ({
  resolveTranslations: async () => ({
    locale: 'en',
    translate: (_key: string, fallback: string, params?: Record<string, string | number>) =>
      fallback.replace(/\{(\w+)\}/g, (_m, name: string) => String(params?.[name] ?? '')),
  }),
}))

import writesAiTools from '../writes-pack'

const resolveTool = writesAiTools.find((tool) => tool.name === 'itad.resolve_exception')!
const rescheduleTool = writesAiTools.find((tool) => tool.name === 'itad.reschedule_pickup')!
const ctx = { tenantId: 't1', organizationId: 'o1', userId: 'u1', container: {}, userFeatures: ['itad.*'], isSuperAdmin: false } as never
const job = (overrides: Record<string, unknown> = {}) => ({
  success: true,
  statusCode: 200,
  data: { items: [{ id: '11111111-1111-4111-8111-111111111111', organizationId: 'o1', internalReference: 'ITAD-2026-00042', status: 'scheduled', statusBeforeHold: null, scheduledPickupAt: '2026-10-20T08:00:00.000Z', updatedAt: '2026-10-18T07:00:00.000Z', ...overrides }] },
})
const exception = (overrides: Record<string, unknown> = {}) => ({
  success: true,
  statusCode: 200,
  data: { id: '22222222-2222-4222-8222-222222222222', type: 'missing_from_delivery', status: 'open', serial: 'ACME-LT-0010', assetId: null, updatedAt: '2026-10-18T07:30:00.000Z', ...overrides },
})
const resolveInput = {
  jobId: '11111111-1111-4111-8111-111111111111',
  exceptionId: '22222222-2222-4222-8222-222222222222',
  outcome: 'not_shipped',
  reason: 'Customer confirmed it stayed on site',
}

beforeEach(() => {
  responses.length = 0
})

describe('itad.resolve_exception preview (A2)', () => {
  it('previews the business change with the exception identity and its version', async () => {
    responses.push(job(), exception())
    const preview = await resolveTool.loadBeforeRecord!(resolveInput as never, ctx)
    expect(preview).toMatchObject({
      recordId: '22222222-2222-4222-8222-222222222222',
      entityType: 'itad.exception',
      recordVersion: '2026-10-18T07:30:00.000Z',
      before: { status: 'open', resolutionOutcome: null },
      after: { status: 'resolved', resolutionOutcome: 'not_shipped', resolutionReason: 'Customer confirmed it stayed on site', blocked: null },
    })
    expect(preview!.display!.fieldLabels!.status).toContain('ACME-LT-0010')
    expect(preview!.display!.fieldLabels!.status).toContain('ITAD-2026-00042')
  })

  it('refuses an outcome the type does not allow: no preview', async () => {
    responses.push(job(), exception())
    await expect(resolveTool.loadBeforeRecord!({ ...resolveInput, outcome: 'accepted_into_job' } as never, ctx)).rejects.toMatchObject({ code: 'outcome_invalid' })
  })

  it('shows a no longer open exception as blocked, with a version that turns stale on any change', async () => {
    responses.push(job(), exception({ status: 'resolved' }))
    const preview = await resolveTool.loadBeforeRecord!(resolveInput as never, ctx)
    expect(preview).toMatchObject({ recordVersion: 'ineligible:exception_resolved', after: { blocked: 'exception_resolved' } })
    expect(preview!.display!.after!.blocked).toBe('The exception is no longer open')
  })

  it('never writes without a confirmed pending action', async () => {
    await expect(resolveTool.handler(resolveInput as never, ctx)).rejects.toMatchObject({ code: 'approval_required' })
  })
})

describe('itad.reschedule_pickup preview (A4)', () => {
  const future = new Date(Date.now() + 3 * 86_400_000)
  future.setUTCHours(9, 0, 0, 0)

  it('shows old and new pickup in the operator time zone', async () => {
    responses.push(job())
    const preview = await rescheduleTool.loadBeforeRecord!(
      { jobId: '11111111-1111-4111-8111-111111111111', scheduledPickupAt: future.toISOString(), timeZone: 'Europe/Warsaw' } as never,
      ctx,
    )
    expect(preview).toMatchObject({ entityType: 'itad.job', recordVersion: '2026-10-18T07:00:00.000Z', after: { scheduledPickupAt: future.toISOString() } })
    expect(String(preview!.display!.after!.scheduledPickupAt)).toMatch(/Europe\/Warsaw \(UTC\+[12]\)$/)
    expect(preview!.display!.fieldLabels!.scheduledPickupAt).toContain('ITAD-2026-00042')
  })

  it('blocks a job in receiving and refuses an unknown time zone', async () => {
    responses.push(job({ status: 'receiving' }))
    const blocked = await rescheduleTool.loadBeforeRecord!(
      { jobId: '11111111-1111-4111-8111-111111111111', scheduledPickupAt: future.toISOString() } as never,
      ctx,
    )
    expect(blocked).toMatchObject({ recordVersion: 'ineligible:field_locked', after: { blocked: 'field_locked' } })
    await expect(
      rescheduleTool.loadBeforeRecord!(
        { jobId: '11111111-1111-4111-8111-111111111111', scheduledPickupAt: future.toISOString(), timeZone: 'Mars/Base' } as never,
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'timezone_invalid' })
  })
})

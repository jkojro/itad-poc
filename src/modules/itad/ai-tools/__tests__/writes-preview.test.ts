import { beforeEach, describe, expect, it, jest } from '@jest/globals'

const responses: Array<{ success: boolean; statusCode: number; data?: unknown }> = []
jest.mock('../_shared', () => {
  const actual = jest.requireActual<typeof import('../_shared')>('../_shared')
  return { ...actual, runItadRoute: jest.fn(async () => responses.shift()) }
})
// Whether an action with the same input is pending — true only at the confirm re-check.
const mockPending = { value: false }
jest.mock('../_writes', () => ({
  isPendingProposal: jest.fn(async () => mockPending.value),
  requireApprovedAction: jest.fn(async () => {
    const { ItadToolError } = jest.requireActual<typeof import('../_shared')>('../_shared')
    throw new ItadToolError('approval_required', 'This change needs a confirmed preview')
  }),
  runApprovedWrite: jest.fn(),
}))
const mockUsers: Array<{ id: string; name: string | null; email: string | null }> = []
jest.mock('../../module-integrations/users', () => ({
  listOrganizationUsers: jest.fn(async (_qe: unknown, _scope: unknown, options: { ids?: string[] }) =>
    mockUsers.filter((user) => !options.ids || options.ids.includes(user.id)),
  ),
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
const retryTool = writesAiTools.find((tool) => tool.name === 'itad.approve_sanitization_retry')!
const assignTool = writesAiTools.find((tool) => tool.name === 'itad.assign_exceptions')!
const ctx = {
  tenantId: 't1',
  organizationId: 'o1',
  userId: 'u1',
  container: { resolve: () => ({}) },
  userFeatures: ['itad.*'],
  isSuperAdmin: false,
} as never
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
  mockPending.value = false
  mockUsers.length = 0
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

  it('refuses a no longer open exception; at the confirm re-check shows it blocked, with a version that turns stale', async () => {
    responses.push(job(), exception({ status: 'resolved' }))
    await expect(resolveTool.loadBeforeRecord!(resolveInput as never, ctx)).rejects.toMatchObject({ code: 'exception_resolved' })
    mockPending.value = true
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

  it('refuses a job in receiving (blocked at the re-check) and an unknown time zone', async () => {
    responses.push(job({ status: 'receiving' }))
    await expect(
      rescheduleTool.loadBeforeRecord!({ jobId: '11111111-1111-4111-8111-111111111111', scheduledPickupAt: future.toISOString() } as never, ctx),
    ).rejects.toMatchObject({ code: 'field_locked' })
    mockPending.value = true
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

  it('reads a local time in the given zone: the model sends the time as the operator said it', async () => {
    responses.push(job())
    const day = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10)
    const preview = await rescheduleTool.loadBeforeRecord!(
      { jobId: '11111111-1111-4111-8111-111111111111', scheduledPickupAt: `${day}T13:00`, timeZone: 'Europe/Warsaw' } as never,
      ctx,
    )
    const stored = new Date(String(preview!.after!.scheduledPickupAt))
    // 13:00 in Warsaw is 11:00 or 12:00 UTC, depending on summer time.
    expect([11, 12]).toContain(stored.getUTCHours())
    expect(String(preview!.display!.after!.scheduledPickupAt)).toContain('13:00 Europe/Warsaw')
    await expect(
      rescheduleTool.loadBeforeRecord!({ jobId: '11111111-1111-4111-8111-111111111111', scheduledPickupAt: `${day}T13:00` } as never, ctx),
    ).rejects.toMatchObject({ code: 'timezone_required' })
  })

  it('refuses any past time with the current time, so the model can fix the date; at the re-check it is blocked', async () => {
    responses.push(job())
    const refused = rescheduleTool.loadBeforeRecord!(
      { jobId: '11111111-1111-4111-8111-111111111111', scheduledPickupAt: '2024-12-04T12:00', timeZone: 'Europe/Warsaw' } as never,
      ctx,
    )
    await expect(refused).rejects.toMatchObject({ code: 'time_in_past' })
    await expect(refused).rejects.toThrow(/it is now .*Europe\/Warsaw/)
    // Previewed for 11:00 at 10:58, confirmed at 11:01: the re-check never throws (a throw is a 500).
    mockPending.value = true
    responses.push(job())
    const passed = await rescheduleTool.loadBeforeRecord!(
      { jobId: '11111111-1111-4111-8111-111111111111', scheduledPickupAt: new Date(Date.now() - 60_000).toISOString(), timeZone: 'Europe/Warsaw' } as never,
      ctx,
    )
    expect(passed).toMatchObject({ recordVersion: 'ineligible:time_in_past', after: { blocked: 'time_in_past' } })
  })
})

describe('itad.approve_sanitization_retry preview (A3)', () => {
  const input = { jobId: '11111111-1111-4111-8111-111111111111', assetId: '33333333-3333-4333-8333-333333333333', reason: 'Drive reseated, retry' }
  const history = (status = 'review_required') => ({
    success: true,
    statusCode: 200,
    data: {
      asset: { id: input.assetId, serial: 'ACME-LT-0007', status, updatedAt: '2026-10-19T08:00:00.000Z' },
      runs: [
        { id: 'r2', method: 'purge', result: 'FAIL', startedAt: '2026-10-19T07:00:00.000Z', finishedAt: '2026-10-19T07:30:00.000Z' },
        { id: 'r1', method: 'purge', result: 'FAIL', startedAt: '2026-10-18T07:00:00.000Z', finishedAt: '2026-10-18T07:30:00.000Z' },
      ],
    },
  })
  const failures = (items: unknown[]) => ({ success: true, statusCode: 200, data: { items, total: items.length } })
  const failure = { id: '44444444-4444-4444-8444-444444444444', type: 'sanitization_failed', status: 'open', serial: 'ACME-LT-0007', assetId: input.assetId, updatedAt: '2026-10-19T08:00:01.000Z', assignedTo: null }

  it('previews review → sanitization required, the failure resolved, the last run and attempts', async () => {
    responses.push(job({ status: 'processing' }), history(), failures([failure]))
    const preview = await retryTool.loadBeforeRecord!(input as never, ctx)
    expect(preview).toMatchObject({
      recordId: input.assetId,
      entityType: 'itad.asset',
      recordVersion: `2026-10-19T08:00:00.000Z|${failure.id}@2026-10-19T08:00:01.000Z`,
      before: { status: 'review_required', failure: 'open' },
      after: { status: 'sanitization_required', failure: 'retry_approved', reason: 'Drive reseated, retry', blocked: null },
    })
    expect(preview!.display!.fieldLabels!.status).toMatch(/ACME-LT-0007 · ITAD-2026-00042 · last run .*FAIL.*attempts 2/)
  })

  it('refuses a device not in review and a job not processing: no preview (AC-AI-08)', async () => {
    responses.push(job({ status: 'processing' }), history('sanitized'), failures([]))
    await expect(retryTool.loadBeforeRecord!(input as never, ctx)).rejects.toMatchObject({ code: 'asset_not_in_review' })
    responses.push(job({ status: 'completed' }), history(), failures([failure]))
    await expect(retryTool.loadBeforeRecord!(input as never, ctx)).rejects.toMatchObject({ code: 'job_not_processing' })
    responses.push(job({ status: 'processing' }), history(), failures([]))
    await expect(retryTool.loadBeforeRecord!(input as never, ctx)).rejects.toMatchObject({ code: 'no_open_failure' })
  })

  it('at the confirm re-check a closed failure makes the version stale instead of throwing', async () => {
    mockPending.value = true
    responses.push(job({ status: 'processing' }), history(), failures([]))
    const preview = await retryTool.loadBeforeRecord!(input as never, ctx)
    expect(preview).toMatchObject({ recordVersion: 'ineligible:no_open_failure', after: { blocked: 'no_open_failure' } })
  })
})

describe('itad.assign_exceptions preview (A1)', () => {
  const ids = ['55555555-5555-4555-8555-55555555555a', '55555555-5555-4555-8555-55555555555b', '55555555-5555-4555-8555-55555555555c']
  const row = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    type: 'sanitization_failed',
    status: 'open',
    serial: `SN-${id.slice(-1)}`,
    assetId: null,
    updatedAt: `2026-10-19T08:00:0${id.slice(-1) === 'a' ? 1 : 2}.000Z`,
    assignedTo: null,
    ...overrides,
  })
  const list = (items: unknown[]) => ({ success: true, statusCode: 200, data: { items, total: items.length } })
  const input = (exceptionIds: string[]) => ({
    jobId: '11111111-1111-4111-8111-111111111111',
    filter: { type: 'sanitization_failed', assignee: 'any' },
    exceptionIds,
    assignedToUserId: 'me',
  })

  it('previews each open matching exception with current → new assignee and its own version', async () => {
    mockUsers.push({ id: 'u1', name: 'Anna Operator', email: null })
    responses.push(job(), list([row(ids[0]), row(ids[1], { assignedTo: { id: 'u2', name: 'Bob' } }), row(ids[2], { status: 'resolved' })]))
    const rows = await assignTool.loadBeforeRecords!(input(ids) as never, ctx)
    expect(rows.map((entry) => entry.recordId)).toEqual([ids[0], ids[1]])
    expect(rows[1]).toMatchObject({
      entityType: 'itad.exception',
      recordVersion: '2026-10-19T08:00:02.000Z',
      before: { assignedToUserId: 'u2' },
      after: { assignedToUserId: 'u1' },
      display: { before: { assignedToUserId: 'Bob' }, after: { assignedToUserId: 'Anna Operator' } },
    })
    expect(rows[0].label).toContain('ITAD-2026-00042')
  })

  it('refuses an id outside the filter, an assignee outside the organization and an empty selection', async () => {
    mockUsers.push({ id: 'u1', name: 'Anna Operator', email: null })
    responses.push(job(), list([row(ids[0])]))
    await expect(assignTool.loadBeforeRecords!(input([ids[0], ids[1]]) as never, ctx)).rejects.toMatchObject({ code: 'exception_outside_filter' })
    responses.push(job(), list([row(ids[0])]))
    await expect(assignTool.loadBeforeRecords!({ ...input([ids[0]]), assignedToUserId: '66666666-6666-4666-8666-666666666666' } as never, ctx)).rejects.toMatchObject({
      code: 'assignee_invalid',
    })
    responses.push(job(), list([row(ids[0], { status: 'resolved' })]))
    await expect(assignTool.loadBeforeRecords!(input([ids[0]]) as never, ctx)).rejects.toMatchObject({ code: 'nothing_to_assign' })
    // At the confirm re-check nothing left reads as all records stale, never a throw.
    mockPending.value = true
    responses.push(job(), list([row(ids[0], { status: 'resolved' })]))
    await expect(assignTool.loadBeforeRecords!(input([ids[0]]) as never, ctx)).resolves.toEqual([])
  })

  it('takes at most 50 exceptions', () => {
    const many = Array.from({ length: 51 }, (_, index) => `55555555-5555-4555-8555-${String(index).padStart(12, '0')}`)
    expect(assignTool.inputSchema.safeParse(input(many)).success).toBe(false)
  })
})

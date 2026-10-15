import { describe, expect, it } from '@jest/globals'
import {
  EMPTY_JOB_OVERVIEW_SOURCE,
  buildJobOverview,
  buildJobOverviewCounters,
  compareOverviewJobs,
  type JobOverviewSource,
  type OverviewJob,
} from '../job-overview'

const source = (overrides: Partial<JobOverviewSource> = {}): JobOverviewSource => ({ ...EMPTY_JOB_OVERVIEW_SOURCE, ...overrides })
const job = (status: OverviewJob['status'], statusBeforeHold: OverviewJob['statusBeforeHold'] = null): OverviewJob => ({ status, statusBeforeHold })

describe('buildJobOverviewCounters (spec "Domain vocabulary and counters")', () => {
  it('derives Received, Missing, Unexpected and Total intake from reconciliation (AC-701, REQ-720)', () => {
    const counters = buildJobOverviewCounters(source({ activeManifestItems: 500, matched: 497, activeAssets: 499 }), 'processing')
    expect(counters).toMatchObject({ expected: 500, received: 497, missing: 3, unexpected: 2, totalIntake: 499 })
    expect(counters.expected).toBe(counters.received + counters.missing)
  })

  it('counts devices by current state and builds the sanitization scope (AC-702)', () => {
    const counters = buildJobOverviewCounters(source({ awaitingWipe: 83, sanitized: 391, failed: 17 }), 'processing')
    expect(counters).toMatchObject({ awaitingWipe: 83, sanitized: 391, failed: 17, sanitizationScope: 491 })
  })

  it('requires a certificate for every sanitized device, none on a cancelled job', () => {
    expect(buildJobOverviewCounters(source({ sanitized: 145, certifiedSanitized: 143 }), 'closeout_review')).toMatchObject({
      certificatesRequired: 145,
      certificatesIssued: 143,
      certificatesMissing: 2,
    })
    expect(buildJobOverviewCounters(source({ sanitized: 5, certifiedSanitized: 1 }), 'cancelled')).toMatchObject({
      certificatesRequired: 0,
      certificatesMissing: 0,
    })
  })
})

describe('attention model (Q4, D7, D8, D9)', () => {
  it('marks failed sanitization and unresolved duplicates red', () => {
    expect(buildJobOverview(job('processing'), source({ failed: 17 }))).toMatchObject({
      severity: 'red',
      group: 'attention_red',
      signals: [{ key: 'failed', severity: 'red', count: 17 }],
    })
    expect(buildJobOverview(job('receiving'), source({ unresolvedDuplicates: 1 })).severity).toBe('red')
  })

  it('never colours a job by the bare number of open exceptions', () => {
    expect(buildJobOverview(job('processing'), source({ openExceptions: 11 }))).toMatchObject({ severity: 'none', signals: [] })
  })

  it('treats missing devices while receiving as progress (AC-709, D7)', () => {
    const overview = buildJobOverview(job('receiving'), source({ activeManifestItems: 220, matched: 180, activeAssets: 180 }))
    expect(overview.counters.missing).toBe(40)
    expect(overview).toMatchObject({ severity: 'none', group: 'in_progress' })
  })

  it('marks unexpected devices orange while receiving', () => {
    expect(buildJobOverview(job('receiving'), source({ activeManifestItems: 2, matched: 2, activeAssets: 3 }))).toMatchObject({
      severity: 'orange',
      signals: [{ key: 'unexpected', severity: 'orange', count: 1 }],
    })
  })

  it('after receiving, colours missing and unexpected only while their exception is open (AC-708, AC-710, D9)', () => {
    const open = buildJobOverview(
      job('processing'),
      source({ activeManifestItems: 10, matched: 9, activeAssets: 10, openExceptions: 2, openMissingExceptions: 1, openUnexpectedExceptions: 1 }),
    )
    expect(open).toMatchObject({ severity: 'orange', group: 'attention_orange' })
    expect(open.signals.map((signal) => signal.key)).toEqual(['missing_exceptions', 'unexpected_exceptions'])

    const resolved = buildJobOverview(job('processing'), source({ activeManifestItems: 10, matched: 9, activeAssets: 10 }))
    expect(resolved.counters).toMatchObject({ missing: 1, unexpected: 1 })
    expect(resolved).toMatchObject({ severity: 'none', group: 'in_progress', signals: [] })
  })

  it('makes missing certificates a closeout blocker only (AC-707, D8)', () => {
    const certificates = source({ sanitized: 12 })
    expect(buildJobOverview(job('closeout_review'), certificates)).toMatchObject({
      severity: 'orange',
      signals: [{ key: 'certificates_missing', severity: 'orange', count: 12 }],
    })
    expect(buildJobOverview(job('processing'), certificates)).toMatchObject({ severity: 'none', signals: [] })
  })

  it('marks undecided data-bearing orange', () => {
    expect(buildJobOverview(job('receiving'), source({ dataBearingUnknown: 3 })).severity).toBe('orange')
  })

  it('evaluates an on-hold job as its pre-hold status', () => {
    expect(buildJobOverview(job('on_hold', 'closeout_review'), source({ sanitized: 2 })).severity).toBe('orange')
    expect(buildJobOverview(job('on_hold', 'scheduled'), source()).group).toBe('upcoming')
    expect(buildJobOverview(job('on_hold', 'receiving'), source({ activeManifestItems: 5 })).group).toBe('in_progress')
  })
})

describe('groups and order (REQ-721)', () => {
  it('groups by need for action', () => {
    expect(buildJobOverview(job('scheduled'), source()).group).toBe('upcoming')
    expect(buildJobOverview(job('draft'), source()).group).toBe('draft')
    expect(buildJobOverview(job('in_transit'), source()).group).toBe('in_progress')
  })

  it('orders red, orange, in progress, upcoming, drafts; then pickup date; then reference', () => {
    const at = (iso: string | null) => (iso ? new Date(iso) : null)
    const jobs = [
      { group: 'draft' as const, scheduledPickupAt: null, internalReference: 'ITAD-2026-00005' },
      { group: 'upcoming' as const, scheduledPickupAt: at('2026-10-20T08:00:00Z'), internalReference: 'ITAD-2026-00004' },
      { group: 'in_progress' as const, scheduledPickupAt: null, internalReference: 'ITAD-2026-00009' },
      { group: 'in_progress' as const, scheduledPickupAt: at('2026-10-01T08:00:00Z'), internalReference: 'ITAD-2026-00008' },
      { group: 'attention_orange' as const, scheduledPickupAt: at('2026-10-02T08:00:00Z'), internalReference: 'ITAD-2026-00002' },
      { group: 'attention_red' as const, scheduledPickupAt: at('2026-10-03T08:00:00Z'), internalReference: 'ITAD-2026-00003' },
      { group: 'attention_red' as const, scheduledPickupAt: at('2026-10-03T08:00:00Z'), internalReference: 'ITAD-2026-00001' },
    ]
    expect([...jobs].sort(compareOverviewJobs).map((entry) => entry.internalReference)).toEqual([
      'ITAD-2026-00001',
      'ITAD-2026-00003',
      'ITAD-2026-00002',
      'ITAD-2026-00008',
      'ITAD-2026-00009',
      'ITAD-2026-00004',
      'ITAD-2026-00005',
    ])
  })
})

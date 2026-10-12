import { describe, expect, it } from '@jest/globals'
import { buildAssetTimeline, type TimelineSources } from '../asset-timeline'

const t = (minute: number) => new Date(Date.UTC(2026, 9, 12, 9, minute))

function sources(overrides: Partial<TimelineSources> = {}): TimelineSources {
  return {
    asset: {
      receivedAt: t(2),
      receivedByUserId: 'adam',
      firstScanResult: 'matched',
      dataBearingSource: 'manual',
      deletedAt: null,
      deletedByUserId: null,
      deleteReason: null,
    },
    duplicateScans: [],
    transitions: [],
    exceptionEvents: [],
    jobTransitions: [],
    ...overrides,
  }
}

const all = { sanitization: true, exceptions: true }

describe('asset timeline (exceptions spec TEST-408, unit part)', () => {
  it('tells the example story of E4-053 in order, FAIL before the exception it opens', () => {
    const failAt = t(48)
    const timeline = buildAssetTimeline(
      sources({
        transitions: [
          { createdAt: t(18), action: 'classify', fromStatus: 'received', toStatus: 'sanitization_required', dataBearingFrom: null, dataBearingTo: true, reason: null, actorUserId: 'adam', runMethod: null, runTool: null },
          { createdAt: t(3), action: 'start_run', fromStatus: 'sanitization_required', toStatus: 'sanitization_in_progress', dataBearingFrom: true, dataBearingTo: true, reason: null, actorUserId: 'anna', runMethod: 'purge', runTool: 'Eraser' },
          { createdAt: failAt, action: 'record_fail', fromStatus: 'sanitization_in_progress', toStatus: 'sanitization_failed', dataBearingFrom: true, dataBearingTo: true, reason: 'Readable', actorUserId: 'anna', runMethod: 'purge', runTool: 'Eraser' },
          { createdAt: new Date(failAt.getTime() + 1), action: 'record_fail', fromStatus: 'sanitization_failed', toStatus: 'review_required', dataBearingFrom: true, dataBearingTo: true, reason: 'Readable', actorUserId: 'anna', runMethod: 'purge', runTool: 'Eraser' },
        ],
        exceptionEvents: [
          { createdAt: failAt, kind: 'created', exceptionType: 'sanitization_failed', assignedToUserId: null, outcome: null, reason: null, actorUserId: null },
          { createdAt: t(55), kind: 'resolved', exceptionType: 'sanitization_failed', assignedToUserId: null, outcome: 'retry_approved', reason: 'New cable', actorUserId: 'maria' },
        ],
      }),
      all,
    )
    expect(timeline.map((entry) => entry.kind)).toEqual([
      'received',
      'sanitization_started',
      'data_bearing_changed',
      'sanitization_failed',
      'exception_opened',
      'exception_resolved',
    ])
    expect(timeline.find((entry) => entry.kind === 'exception_opened')?.actorUserId).toBeNull()
    // The second FAIL step (→ review_required) is not a separate business event.
    expect(timeline.filter((entry) => entry.kind === 'sanitization_failed')).toHaveLength(1)
  })

  it('shows the scan decision as "decided" with its source, and duplicates with their resolution', () => {
    const timeline = buildAssetTimeline(
      sources({
        transitions: [
          { createdAt: t(2), action: 'classify', fromStatus: null, toStatus: 'received', dataBearingFrom: null, dataBearingTo: false, reason: null, actorUserId: null, runMethod: null, runTool: null },
        ],
        duplicateScans: [
          { scannedAt: t(5), scannedByUserId: 'adam', resolution: 'different_device_set_aside', resolutionNote: 'Cage', resolvedAt: t(9), resolvedByUserId: 'maria', flaggedAt: t(6), flaggedByUserId: 'adam', flaggedNote: 'Two units' },
        ],
        jobTransitions: [
          { createdAt: t(1), action: 'start_receiving', reason: null, actorUserId: 'adam' },
          { createdAt: t(20), action: 'start_processing', reason: null, actorUserId: 'maria' },
        ],
      }),
      all,
    )
    expect(timeline.map((entry) => entry.kind)).toEqual([
      'received',
      'data_bearing_decided',
      'scanned_again',
      'duplicate_flagged',
      'duplicate_set_aside',
      'reconciled',
    ])
    expect(timeline[1].details).toMatchObject({ dataBearingTo: false, dataBearingSource: 'manual' })
  })

  it('hides sanitization and exception entries from viewers without those features', () => {
    const rich = sources({
      transitions: [
        { createdAt: t(3), action: 'start_run', fromStatus: 'sanitization_required', toStatus: 'sanitization_in_progress', dataBearingFrom: true, dataBearingTo: true, reason: null, actorUserId: 'anna', runMethod: 'clear', runTool: 'X' },
      ],
      exceptionEvents: [
        { createdAt: t(4), kind: 'assigned', exceptionType: 'unexpected_asset', assignedToUserId: 'maria', outcome: null, reason: null, actorUserId: 'maria' },
      ],
    })
    expect(buildAssetTimeline(rich, { sanitization: false, exceptions: false }).map((entry) => entry.kind)).toEqual(['received'])
    expect(buildAssetTimeline(rich, { sanitization: true, exceptions: false }).map((entry) => entry.kind)).toEqual(['received', 'sanitization_started'])
  })

  it('shows a voided device', () => {
    const timeline = buildAssetTimeline(
      sources({ asset: { ...sources().asset, deletedAt: t(30), deletedByUserId: 'adam', deleteReason: 'Wrong pallet' } }),
      all,
    )
    expect(timeline.at(-1)).toMatchObject({ kind: 'voided', actorUserId: 'adam', details: { reason: 'Wrong pallet' } })
  })
})

import { describe, expect, it } from '@jest/globals'
import {
  buildSnapshot,
  certificateActionAllowed,
  certificateCounts,
  decideEligibility,
  formatCertificateNumber,
  latestPassRun,
  normalizeMediaIdentifiers,
  printableFields,
  unprintableFields,
  type CertificateRun,
  type CertificateSourceData,
  type EligibilityFacts,
} from '../certificates'

const ASSET = 'a1'
const JOB = 'j1'
const at = (iso: string) => new Date(iso)
const run = (id: string, result: CertificateRun['result'], finishedAt: string | null, overrides: Partial<CertificateRun> = {}): CertificateRun => ({
  id,
  assetId: ASSET,
  jobId: JOB,
  result,
  finishedAt: finishedAt ? at(finishedAt) : null,
  ...overrides,
})

const facts = (overrides: Partial<EligibilityFacts> = {}): EligibilityFacts => ({
  job: { status: 'processing' },
  asset: { id: ASSET, jobId: JOB, dataBearing: true, status: 'sanitized', deleted: false },
  runs: [run('r1', 'PASS', '2026-10-14T08:00:00.000Z')],
  hasIssuedCertificate: false,
  ...overrides,
})

describe('formatCertificateNumber', () => {
  it('pads to five digits and grows beyond', () => {
    expect(formatCertificateNumber(2026, 1)).toBe('CDS-2026-00001')
    expect(formatCertificateNumber(2026, 123456)).toBe('CDS-2026-123456')
  })
})

describe('certificateActionAllowed (spec "Job status")', () => {
  it.each([
    ['draft', [false, false, false]],
    ['receiving', [false, false, false]],
    ['processing', [true, true, true]],
    ['closeout_review', [true, true, true]],
    ['completed', [true, true, true]],
    ['cancelled', [false, true, true]],
  ] as const)('%s → issue/reissue/void', (status, [issue, reissue, voided]) => {
    expect(certificateActionAllowed({ status }, 'issue')).toBe(issue)
    expect(certificateActionAllowed({ status }, 'reissue')).toBe(reissue)
    expect(certificateActionAllowed({ status }, 'void')).toBe(voided)
  })

  it('on hold follows the pre-hold status', () => {
    expect(certificateActionAllowed({ status: 'on_hold', statusBeforeHold: 'processing' }, 'issue')).toBe(true)
    expect(certificateActionAllowed({ status: 'on_hold', statusBeforeHold: 'receiving' }, 'issue')).toBe(false)
  })
})

describe('latestPassRun', () => {
  it('takes the latest finished PASS and never FAIL or ABORTED', () => {
    const runs = [
      run('fail', 'FAIL', '2026-10-14T07:00:00.000Z'),
      run('pass-old', 'PASS', '2026-10-14T08:00:00.000Z'),
      run('pass-new', 'PASS', '2026-10-14T09:00:00.000Z'),
      run('aborted', 'ABORTED', '2026-10-14T10:00:00.000Z'),
      run('open', null, null),
    ]
    expect(latestPassRun(runs)?.id).toBe('pass-new')
    expect(latestPassRun([run('fail', 'FAIL', '2026-10-14T07:00:00.000Z')])).toBeNull()
  })
})

describe('decideEligibility (spec "Eligibility", REQ-601/605/621)', () => {
  it('accepts a sanitized data-bearing asset and names the source run', () => {
    expect(decideEligibility(facts())).toEqual({ ok: true, sourceRunId: 'r1' })
  })

  it('uses the PASS run after a FAIL and retry (AC-602)', () => {
    const decision = decideEligibility(
      facts({ runs: [run('r1', 'FAIL', '2026-10-14T07:00:00.000Z'), run('r2', 'PASS', '2026-10-14T09:00:00.000Z')] }),
    )
    expect(decision).toEqual({ ok: true, sourceRunId: 'r2' })
  })

  it.each([
    ['job status', facts({ job: { status: 'receiving' } }), 'job_status'],
    ['cancelled job', facts({ job: { status: 'cancelled' } }), 'job_status'],
    ['voided asset', facts({ asset: { id: ASSET, jobId: JOB, dataBearing: true, status: 'sanitized', deleted: true } }), 'asset_voided'],
    ['non-data-bearing', facts({ asset: { id: ASSET, jobId: JOB, dataBearing: false, status: 'received', deleted: false } }), 'not_data_bearing'],
    ['unknown data-bearing', facts({ asset: { id: ASSET, jobId: JOB, dataBearing: null, status: 'received', deleted: false } }), 'not_data_bearing'],
    ['review required', facts({ asset: { id: ASSET, jobId: JOB, dataBearing: true, status: 'review_required', deleted: false } }), 'not_sanitized'],
    ['in progress', facts({ asset: { id: ASSET, jobId: JOB, dataBearing: true, status: 'sanitization_in_progress', deleted: false } }), 'not_sanitized'],
    ['only a FAIL run', facts({ runs: [run('r1', 'FAIL', '2026-10-14T07:00:00.000Z')] }), 'no_pass_run'],
    ['PASS of another asset', facts({ runs: [run('r1', 'PASS', '2026-10-14T07:00:00.000Z', { assetId: 'other' })] }), 'no_pass_run'],
    ['PASS of another job', facts({ runs: [run('r1', 'PASS', '2026-10-14T07:00:00.000Z', { jobId: 'other' })] }), 'no_pass_run'],
  ])('refuses %s', (_label, input, detail) => {
    expect(decideEligibility(input)).toEqual({ ok: false, code: 'certificate_not_eligible', detail })
  })

  it('refuses a second issue whatever the run; a reissue expects the current one', () => {
    expect(decideEligibility(facts({ hasIssuedCertificate: true }))).toEqual({ ok: false, code: 'certificate_already_issued' })
    expect(decideEligibility(facts({ hasIssuedCertificate: true }), 'reissue')).toEqual({ ok: true, sourceRunId: 'r1' })
  })
})

describe('certificateCounts (spec "Required certificates")', () => {
  const asset = (id: string, dataBearing: boolean | null, status: 'received' | 'sanitized' | 'sanitization_required', issued = false, deleted = false) => ({
    id,
    dataBearing,
    status,
    deleted,
    hasIssuedCertificate: issued,
  })
  const assets = [
    asset('a', true, 'sanitized', true),
    asset('b', true, 'sanitized'),
    asset('c', true, 'sanitization_required'),
    asset('d', false, 'received'),
    asset('e', null, 'received'),
    asset('f', true, 'sanitized', false, true),
  ]

  it('requires only active, data-bearing, sanitized assets (REQ-613)', () => {
    expect(certificateCounts('closeout_review', assets)).toEqual({
      dataBearing: 3,
      sanitized: 2,
      required: 2,
      issued: 1,
      missing: 1,
      missingAssetIds: ['b'],
    })
  })

  it('requires none for a cancelled job', () => {
    expect(certificateCounts('cancelled', assets)).toMatchObject({ required: 0, missing: 0 })
  })
})

const source: CertificateSourceData = {
  customerName: 'Müller & Söhne',
  jobReference: 'ITAD-2026-00010',
  customerReference: null,
  jobName: 'Refresh',
  assetSerial: 'SN-1',
  customerAssetTag: null,
  manufacturer: 'Dell',
  model: null,
  mediaIdentifiers: ['NVME-A', 'NVME-B'],
  method: 'purge',
  methodDetail: null,
  tool: 'Blancco',
  toolVersion: '7.1',
  result: 'PASS',
  verificationMethod: 'full_verification',
  startedAt: '2026-10-14T07:00:00.000Z',
  completedAt: '2026-10-14T09:00:00.000Z',
  startedBy: 'Anna',
  resultRecordedBy: 'Piotr',
  sourceRunId: 'r1',
}

describe('buildSnapshot', () => {
  it('adds number, issue time, issuer, locale and the superseded number', () => {
    const snapshot = buildSnapshot(source, {
      certificateNumber: 'CDS-2026-00001',
      issuedAt: at('2026-10-14T10:00:00.000Z'),
      issuedBy: 'Maria',
      locale: 'pl',
    })
    expect(snapshot).toMatchObject({ ...source, certificateNumber: 'CDS-2026-00001', issuedAt: '2026-10-14T10:00:00.000Z', supersedes: null })
  })
})

describe('unprintableFields (REQ-622)', () => {
  const latinGreekCyrillic = (codePoint: number) => codePoint < 0x0530 || (codePoint >= 0x2000 && codePoint < 0x2070)

  it('passes Latin, Greek and Cyrillic and ignores whitespace', () => {
    expect(unprintableFields(printableFields({ ...source, customerName: 'Αθήνα Systems\tООО' }), latinGreekCyrillic)).toEqual([])
  })

  it('names every field with a character the font cannot print', () => {
    expect(
      unprintableFields(
        printableFields({ ...source, customerName: '東京 Ltd', mediaIdentifiers: ['ok', 'ディスク'] }),
        latinGreekCyrillic,
      ),
    ).toEqual(['customerName', 'mediaIdentifiers.1'])
  })
})

describe('normalizeMediaIdentifiers', () => {
  it('trims, drops empties and duplicates', () => {
    expect(normalizeMediaIdentifiers([' A ', '', 'A', 'B'])).toEqual(['A', 'B'])
    expect(normalizeMediaIdentifiers(undefined)).toEqual([])
  })

  it('rejects more than 10 or a value over 100 characters', () => {
    expect(normalizeMediaIdentifiers(Array.from({ length: 11 }, (_, i) => `M${i}`))).toBeNull()
    expect(normalizeMediaIdentifiers(['x'.repeat(101)])).toBeNull()
  })
})

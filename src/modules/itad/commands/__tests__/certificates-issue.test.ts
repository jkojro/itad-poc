import { beforeEach, describe, expect, it, jest } from '@jest/globals'
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'

jest.mock('@open-mercato/shared/lib/commands', () => ({ registerCommand: jest.fn() }))
jest.mock('@open-mercato/shared/lib/i18n/server', () => ({
  resolveTranslations: async () => ({ translate: (_key: string, fallback: string) => fallback }),
  loadDictionary: async () => ({}),
}))
jest.mock('../jobs', () => ({ ensureScope: jest.fn(), loadJob: jest.fn() }))
jest.mock('../job-lock', () => ({ lockJob: jest.fn() }))
jest.mock('../../services/certificate-reader', () => ({ loadEligibility: jest.fn(), loadSourceData: jest.fn() }))
jest.mock('../../services/certificate-writer', () => ({ insertIssuedCertificate: jest.fn() }))
jest.mock('../../services/certificate-pdf', () => ({
  createGlyphChecker: async () => () => true,
  renderCertificatePdf: async () => new Uint8Array([37, 80, 68, 70]),
}))
jest.mock('../../services/job-reference-generator', () => ({ allocateSequenceValue: jest.fn() }))
jest.mock('../../module-integrations/users', () => ({ loadUserDisplayNames: async () => new Map([['u1', 'Ada Issuer']]) }))
jest.mock('../../module-integrations/attachments', () => ({
  EVIDENCE_ATTACHMENT_PARTITION: 'privateAttachments',
  resolveAttachmentService: jest.fn(),
}))
jest.mock('../../events', () => ({ emitItadEvent: jest.fn() }))

import { registerCommand } from '@open-mercato/shared/lib/commands'
import '../certificates'
import { ensureScope, loadJob } from '../jobs'
import { lockJob } from '../job-lock'
import { loadEligibility, loadSourceData, type LoadedEligibility } from '../../services/certificate-reader'
import { insertIssuedCertificate } from '../../services/certificate-writer'
import { allocateSequenceValue } from '../../services/job-reference-generator'
import { resolveAttachmentService } from '../../module-integrations/attachments'
import { emitItadEvent } from '../../events'
import type { CertificateSourceData } from '../../domain/certificates'

const TENANT = '11111111-1111-4111-8111-111111111111'
const ORG = '22222222-2222-4222-8222-222222222222'
const JOB = '33333333-3333-4333-8333-333333333333'
const ASSET = '44444444-4444-4444-8444-444444444444'
const ATTACHMENT = 'att-1'
const CERTIFICATE = 'cert-1'

const issue = (registerCommand as jest.Mock).mock.calls
  .map(([handler]) => handler as CommandHandler<unknown, { certificateId: string; certificateNumber: string }>)
  .find((handler) => handler.id === 'itad.certificates.issue')!

type RunFact = { id: string; result: 'PASS' | 'FAIL'; finishedAt: string }

/** What `loadEligibility` reads for ASSET of JOB; defaults to an eligible, sanitized asset with one PASS run. */
function eligibility(over: { dataBearing?: boolean | null; status?: string; runs?: RunFact[]; hasIssued?: boolean } = {}): LoadedEligibility {
  const runs = over.runs ?? [{ id: 'run-1', result: 'PASS', finishedAt: '2026-10-14T08:00:00.000Z' }]
  return {
    asset: { id: ASSET } as LoadedEligibility['asset'],
    runs: runs.map((run) => ({ id: run.id })) as LoadedEligibility['runs'],
    facts: {
      job: { status: 'processing', statusBeforeHold: null },
      asset: {
        id: ASSET,
        jobId: JOB,
        dataBearing: over.dataBearing === undefined ? true : over.dataBearing,
        status: (over.status ?? 'sanitized') as LoadedEligibility['facts']['asset']['status'],
        deleted: false,
      },
      runs: runs.map((run) => ({ id: run.id, assetId: ASSET, jobId: JOB, result: run.result, finishedAt: new Date(run.finishedAt) })),
      hasIssuedCertificate: over.hasIssued ?? false,
    },
  } as LoadedEligibility
}

const source: CertificateSourceData = {
  customerName: 'Müller & Söhne',
  jobReference: 'ITAD-2026-00001',
  customerReference: null,
  jobName: 'Office refresh',
  assetSerial: 'SN-1',
  customerAssetTag: null,
  manufacturer: 'Dell',
  model: 'Latitude',
  mediaIdentifiers: [],
  method: 'purge',
  methodDetail: null,
  tool: 'Eraser',
  toolVersion: '1.0',
  result: 'PASS',
  verificationMethod: null,
  startedAt: '2026-10-14T07:00:00.000Z',
  completedAt: '2026-10-14T08:00:00.000Z',
  startedBy: 'Op One',
  resultRecordedBy: 'Op Two',
  sourceRunId: 'run-1',
}

/**
 * The fake attachment service behaves like `createScoped`: `persistLink` runs inside the
 * attachment's transaction, and a throw rolls back the attachment and its bytes.
 */
function setup(atCommit: LoadedEligibility, options: { flushError?: unknown } = {}) {
  const stored: string[] = []
  const rolledBack: string[] = []
  const createScoped = jest.fn(async (input: { persistLink: (tx: unknown, id: string) => Promise<void> }) => {
    const tx = { flush: async () => { if (options.flushError) throw options.flushError } }
    try {
      await input.persistLink(tx, ATTACHMENT)
    } catch (err) {
      rolledBack.push(ATTACHMENT)
      throw err
    }
    stored.push(ATTACHMENT)
    return { id: ATTACHMENT }
  })
  ;(resolveAttachmentService as jest.Mock).mockReturnValue({ createScoped })
  ;(loadEligibility as jest.Mock<typeof loadEligibility>)
    .mockResolvedValueOnce(eligibility())
    .mockResolvedValueOnce(atCommit)
  const em: Record<string, unknown> = {}
  em.fork = () => em
  em.transactional = async (fn: (tx: unknown) => unknown) => fn({})
  const ctx = {
    auth: { sub: 'u1', tenantId: TENANT, orgId: ORG },
    container: { resolve: (name: string) => (name === 'em' ? em : {}) },
  } as unknown as CommandRuntimeContext
  return { ctx, createScoped, stored, rolledBack }
}

const run = (ctx: CommandRuntimeContext) => issue.execute({ jobId: JOB, assetId: ASSET, locale: 'en' }, ctx)

beforeEach(() => {
  jest.clearAllMocks()
  ;(ensureScope as jest.Mock<typeof ensureScope>).mockResolvedValue({ tenantId: TENANT, organizationId: ORG } as never)
  ;(loadJob as jest.Mock).mockResolvedValue({ id: JOB } as never)
  ;(lockJob as jest.Mock).mockResolvedValue({ id: JOB } as never)
  ;(loadSourceData as jest.Mock<typeof loadSourceData>).mockResolvedValue(source)
  ;(allocateSequenceValue as jest.Mock).mockResolvedValue(7 as never)
  ;(insertIssuedCertificate as jest.Mock).mockReturnValue({ id: CERTIFICATE })
})

describe('itad.certificates.issue re-check in persistLink (certificates spec "Issue", step 5)', () => {
  it('stores the PDF and the certificate together when nothing changed', async () => {
    const { ctx, stored, rolledBack } = setup(eligibility())
    await expect(run(ctx)).resolves.toMatchObject({ certificateId: CERTIFICATE, certificateNumber: expect.stringMatching(/^CDS-\d{4}-00007$/) })
    expect(lockJob).toHaveBeenCalledTimes(2)
    expect(insertIssuedCertificate).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ pdfAttachmentId: ATTACHMENT }))
    expect(stored).toEqual([ATTACHMENT])
    expect(rolledBack).toEqual([])
    expect(emitItadEvent).toHaveBeenCalledWith('itad.certificate.issued', expect.objectContaining({ certificateId: CERTIFICATE }))
  })

  it.each([
    ['reclassified to non-data-bearing', eligibility({ dataBearing: false }), { code: 'itad.certificates.errors.certificate_not_eligible', detail: 'not_data_bearing' }],
    ['issued by someone else', eligibility({ hasIssued: true }), { code: 'itad.certificates.errors.certificate_already_issued' }],
    [
      'given a newer PASS run',
      eligibility({
        runs: [
          { id: 'run-1', result: 'PASS', finishedAt: '2026-10-14T08:00:00.000Z' },
          { id: 'run-2', result: 'PASS', finishedAt: '2026-10-14T09:00:00.000Z' },
        ],
      }),
      { code: 'itad.certificates.errors.certificate_not_eligible', detail: 'no_pass_run' },
    ],
  ])('rolls back the PDF and inserts nothing when the asset was %s meanwhile', async (_label, atCommit, body) => {
    const { ctx, createScoped, stored, rolledBack } = setup(atCommit)
    await expect(run(ctx)).rejects.toMatchObject({ status: 409, body })
    expect(createScoped).toHaveBeenCalledTimes(1)
    expect(lockJob).toHaveBeenCalledTimes(2)
    expect(insertIssuedCertificate).not.toHaveBeenCalled()
    expect(stored).toEqual([])
    expect(rolledBack).toEqual([ATTACHMENT])
    expect(emitItadEvent).not.toHaveBeenCalled()
  })

  it('maps a lost race on the one-issued-per-asset index to certificate_already_issued', async () => {
    const violation = { code: '23505', constraint: 'itad_certificates_asset_issued_unique' }
    const { ctx, rolledBack } = setup(eligibility(), { flushError: violation })
    await expect(run(ctx)).rejects.toMatchObject({ status: 409, body: { code: 'itad.certificates.errors.certificate_already_issued' } })
    expect(rolledBack).toEqual([ATTACHMENT])
    expect(emitItadEvent).not.toHaveBeenCalled()
  })
})

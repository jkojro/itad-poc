import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import type { ItadCertificateIssueResult } from '../../../../../../commands/certificates'
import type { ItadCertificateIssueInput } from '../../../../../../data/validators'
import { CERTIFICATE_LOCALES, CERTIFICATE_STATUSES, decideCertificateChange, decideEligibility } from '../../../../../../domain/certificates'
import { certificateError } from '../../../../../../lib/certificate-errors'
import { runGuardedCommand } from '../../../../../../lib/command-route'
import { itadRouteErrorResponse, loadReadableJob, resolveItadRouteContext } from '../../../../../../lib/route-context'
import { listCertificates, loadEligibility } from '../../../../../../services/certificate-reader'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['itad.certificates.view'] },
  POST: { requireAuth: true, requireFeatures: ['itad.certificates.issue'] },
}

const paramsSchema = z.object({ id: z.string().uuid(), assetId: z.string().uuid() })
const bodySchema = z.object({ locale: z.string().max(8).optional() })

/** Certificate history of one asset, the current one, and whether a certificate can be issued now. */
export async function GET(request: Request, { params }: { params: { id: string; assetId: string } }) {
  try {
    const { id, assetId } = paramsSchema.parse({ id: params?.id, assetId: params?.assetId })
    const route = await resolveItadRouteContext(request)
    const job = await loadReadableJob(route, id)
    const scope = { tenantId: route.tenantId, organizationId: job.organizationId }
    const em = route.container.resolve<EntityManager>('em').fork()
    const items = await listCertificates(em, route.container.resolve<QueryEngine>('queryEngine'), scope, { jobId: job.id, assetId })
    const { facts } = await loadEligibility(em, scope, job, assetId)
    const decision = decideEligibility(facts)
    const current = items.find((item) => item.status === 'issued') ?? null
    const reissue = decideEligibility(facts, 'reissue')
    return NextResponse.json({
      items,
      currentCertificateId: current?.id ?? null,
      jobStatus: job.status,
      issue: decision.ok ? { allowed: true } : { allowed: false, code: decision.code, detail: 'detail' in decision ? decision.detail : null },
      reissue: {
        allowed: Boolean(current) && decideCertificateChange({ status: 'issued' }, job, 'reissue').ok && reissue.ok,
        detail: !reissue.ok && 'detail' in reissue ? reissue.detail : null,
      },
      void: { allowed: Boolean(current) && decideCertificateChange({ status: 'issued' }, job, 'void').ok },
    })
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.certificates.asset.list')
  }
}

/** Issues a certificate for this asset (`itad.certificates.issue`). */
export async function POST(request: Request, { params }: { params: { id: string; assetId: string } }) {
  try {
    const { id, assetId } = paramsSchema.parse({ id: params?.id, assetId: params?.assetId })
    const route = await resolveItadRouteContext(request)
    await loadReadableJob(route, id)
    const body = bodySchema.parse((await readJsonSafe<Record<string, unknown>>(request, {})) ?? {})
    const locale = CERTIFICATE_LOCALES.find((entry) => entry === body.locale)
    if (!locale) return await certificateError('locale_invalid')
    const outcome = await runGuardedCommand<ItadCertificateIssueInput, ItadCertificateIssueResult>(route, request, {
      commandId: 'itad.certificates.issue',
      input: { jobId: id, assetId, locale },
      resourceKind: 'itad.certificate',
      resourceId: assetId,
      operation: 'create',
    })
    if (!outcome.ok) return outcome.response
    return NextResponse.json({ id: outcome.result.certificateId, certificateNumber: outcome.result.certificateNumber }, { status: 201 })
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.certificates.issue')
  }
}

const errorSchema = z.object({ error: z.string(), code: z.string().optional() }).passthrough()

const certificateItemSchema = z.object({
  id: z.string().uuid(),
  certificateNumber: z.string(),
  status: z.enum(CERTIFICATE_STATUSES),
  locale: z.enum(CERTIFICATE_LOCALES),
  assetId: z.string().uuid(),
  assetSerial: z.string(),
  sourceRun: z.object({ id: z.string().uuid(), method: z.string(), tool: z.string(), toolVersion: z.string(), completedAt: z.string() }),
  issuedAt: z.string(),
  issuedBy: z.object({ id: z.string().uuid(), name: z.string().nullable() }),
  supersedesCertificateId: z.string().uuid().nullable(),
  supersededByCertificateId: z.string().uuid().nullable(),
  supersedeReason: z.string().nullable(),
  supersededAt: z.string().nullable(),
  supersededBy: z.object({ id: z.string().uuid(), name: z.string().nullable() }).nullable(),
  voidedAt: z.string().nullable(),
  voidedBy: z.object({ id: z.string().uuid(), name: z.string().nullable() }).nullable(),
  voidReason: z.string().nullable(),
  voidReasonCode: z.string().nullable(),
  updatedAt: z.string(),
})

export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'ITAD asset certificates',
  methods: {
    GET: {
      summary: 'Certificates of one asset',
      description: 'All certificates of the asset (issued, superseded, void), newest first, the current one, and whether a certificate can be issued, and the current one reissued or voided, now.',
      responses: [
        {
          status: 200,
          description: 'Certificates',
          schema: z.object({
            items: z.array(certificateItemSchema),
            currentCertificateId: z.string().uuid().nullable(),
            jobStatus: z.string(),
            issue: z.object({ allowed: z.boolean(), code: z.string().optional(), detail: z.string().nullable().optional() }),
            reissue: z.object({ allowed: z.boolean(), detail: z.string().nullable() }),
            void: z.object({ allowed: z.boolean() }),
          }),
        },
      ],
      errors: [
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Missing itad.certificates.view', schema: errorSchema },
        { status: 404, description: 'Job not found in scope', schema: errorSchema },
      ],
    },
    POST: {
      summary: 'Issue a certificate of data sanitization',
      description:
        'Issues a certificate for a sanitized, data-bearing asset from its latest PASS run, with a new CDS-YYYY-NNNNN number, a snapshot and a stored PDF in the chosen language (`pl` / `en`).',
      requestBody: { contentType: 'application/json', schema: bodySchema },
      responses: [{ status: 201, description: 'Issued', schema: z.object({ id: z.string().uuid(), certificateNumber: z.string() }) }],
      errors: [
        { status: 400, description: 'locale_invalid', schema: errorSchema },
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Missing itad.certificates.issue', schema: errorSchema },
        { status: 404, description: 'Job not found in scope', schema: errorSchema },
        { status: 409, description: 'certificate_not_eligible (with detail) or certificate_already_issued', schema: errorSchema },
        { status: 422, description: 'certificate_unprintable_characters (with fields)', schema: errorSchema },
      ],
    },
  },
}

import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import { CERTIFICATE_LOCALES, CERTIFICATE_STATUSES, certificateActionAllowed } from '../../../../domain/certificates'
import { itadRouteErrorResponse, loadReadableJob, resolveItadRouteContext } from '../../../../lib/route-context'
import { listCertificates, loadCertificateRequirement } from '../../../../services/certificate-reader'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['itad.certificates.view'] },
}

const paramsSchema = z.object({ id: z.string().uuid() })
const querySchema = z.object({ status: z.enum(CERTIFICATE_STATUSES).optional() })

/**
 * The job's certificates (all statuses, or one with `?status=`) with the counts
 * data-bearing / sanitized / required / issued / missing and the missing assets
 * (certificates spec "Required certificates", REQ-610).
 */
export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    const { id } = paramsSchema.parse({ id: params?.id })
    const query = querySchema.parse({ status: new URL(request.url).searchParams.get('status') ?? undefined })
    const route = await resolveItadRouteContext(request)
    const job = await loadReadableJob(route, id)
    const scope = { tenantId: route.tenantId, organizationId: job.organizationId }
    const em = route.container.resolve<EntityManager>('em').fork()
    const items = await listCertificates(em, route.container.resolve<QueryEngine>('queryEngine'), scope, { jobId: job.id })
    const requirement = await loadCertificateRequirement(em, scope, job)
    return NextResponse.json({
      items: query.status ? items.filter((item) => item.status === query.status) : items,
      counts: requirement.counts,
      missingAssets: requirement.missingAssets,
      issue: { allowed: certificateActionAllowed(job, 'issue') },
    })
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.certificates.job.list')
  }
}

const errorSchema = z.object({ error: z.string(), code: z.string().optional() }).passthrough()
const userSchema = z.object({ id: z.string().uuid(), name: z.string().nullable() })

const certificateItemSchema = z.object({
  id: z.string().uuid(),
  certificateNumber: z.string(),
  status: z.enum(CERTIFICATE_STATUSES),
  locale: z.enum(CERTIFICATE_LOCALES),
  assetId: z.string().uuid(),
  assetSerial: z.string(),
  sourceRun: z.object({ id: z.string().uuid(), method: z.string(), tool: z.string(), toolVersion: z.string(), completedAt: z.string() }),
  issuedAt: z.string(),
  issuedBy: userSchema,
  supersedesCertificateId: z.string().uuid().nullable(),
  supersededByCertificateId: z.string().uuid().nullable(),
  supersedeReason: z.string().nullable(),
  supersededAt: z.string().nullable(),
  supersededBy: userSchema.nullable(),
  voidedAt: z.string().nullable(),
  voidedBy: userSchema.nullable(),
  voidReason: z.string().nullable(),
  voidReasonCode: z.string().nullable(),
  updatedAt: z.string(),
})

export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'ITAD job certificates',
  methods: {
    GET: {
      summary: 'Certificates and required documents of a job',
      description:
        'All certificates of the job, newest first (optionally one status), the counts data-bearing / sanitized / required / issued / missing, the assets still missing an issued certificate, and whether new certificates can be issued in the current job status.',
      query: querySchema,
      responses: [
        {
          status: 200,
          description: 'Certificates and counts',
          schema: z.object({
            items: z.array(certificateItemSchema),
            counts: z.object({
              dataBearing: z.number(),
              sanitized: z.number(),
              required: z.number(),
              issued: z.number(),
              missing: z.number(),
            }),
            missingAssets: z.array(z.object({ id: z.string().uuid(), serial: z.string() })),
            issue: z.object({ allowed: z.boolean() }),
          }),
        },
      ],
      errors: [
        { status: 400, description: 'Invalid status filter', schema: errorSchema },
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Missing itad.certificates.view', schema: errorSchema },
        { status: 404, description: 'Job not found in scope', schema: errorSchema },
      ],
    },
  },
}

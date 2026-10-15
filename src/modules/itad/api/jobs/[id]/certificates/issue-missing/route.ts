import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { ItadCertificateIssueResult } from '../../../../../commands/certificates'
import type { ItadCertificateIssueInput } from '../../../../../data/validators'
import { CERTIFICATE_LOCALES, certificateActionAllowed } from '../../../../../domain/certificates'
import { certificateError } from '../../../../../lib/certificate-errors'
import { runGuardedCommand } from '../../../../../lib/command-route'
import { itadRouteErrorResponse, loadReadableJob, resolveItadRouteContext } from '../../../../../lib/route-context'
import { loadCertificateRequirement } from '../../../../../services/certificate-reader'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['itad.certificates.issue'] },
}

const paramsSchema = z.object({ id: z.string().uuid() })
const bodySchema = z.object({ locale: z.string().max(8).optional() })

type Failure = { assetId: string; serial: string; status: number; code: string | null; error: string | null }

async function failureOf(asset: { id: string; serial: string }, response: Response): Promise<Failure> {
  const body = (await response.json().catch(() => null)) as { code?: unknown; error?: unknown } | null
  return {
    assetId: asset.id,
    serial: asset.serial,
    status: response.status,
    code: typeof body?.code === 'string' ? body.code : null,
    error: typeof body?.error === 'string' ? body.error : null,
  }
}

/**
 * "Issue all missing" (certificates spec "Issue", Q6): one independent
 * `itad.certificates.issue` per missing asset, so every certificate has its own number,
 * transaction, PDF and audit entry. One failure does not stop the others.
 */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const { id } = paramsSchema.parse({ id: params?.id })
    const route = await resolveItadRouteContext(request)
    const job = await loadReadableJob(route, id)
    const body = bodySchema.parse((await readJsonSafe<Record<string, unknown>>(request, {})) ?? {})
    const locale = CERTIFICATE_LOCALES.find((entry) => entry === body.locale)
    if (!locale) return await certificateError('locale_invalid')
    if (!certificateActionAllowed(job, 'issue')) return await certificateError('certificate_not_eligible', { detail: 'job_status' })
    const scope = { tenantId: route.tenantId, organizationId: job.organizationId }
    const em = route.container.resolve<EntityManager>('em').fork()
    const { missingAssets } = await loadCertificateRequirement(em, scope, job)

    const issued: Array<{ assetId: string; serial: string; certificateId: string; certificateNumber: string }> = []
    const failed: Failure[] = []
    for (const asset of missingAssets) {
      try {
        const outcome = await runGuardedCommand<ItadCertificateIssueInput, ItadCertificateIssueResult>(route, request, {
          commandId: 'itad.certificates.issue',
          input: { jobId: job.id, assetId: asset.id, locale },
          resourceKind: 'itad.certificate',
          resourceId: asset.id,
          operation: 'create',
        })
        if (outcome.ok) {
          issued.push({ assetId: asset.id, serial: asset.serial, certificateId: outcome.result.certificateId, certificateNumber: outcome.result.certificateNumber })
        } else {
          failed.push(await failureOf(asset, outcome.response))
        }
      } catch (err) {
        failed.push(await failureOf(asset, itadRouteErrorResponse(err, 'itad.certificates.issue_missing')))
      }
    }
    return NextResponse.json({ issued, failed })
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.certificates.issue_missing')
  }
}

const errorSchema = z.object({ error: z.string(), code: z.string().optional() }).passthrough()

export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'Issue all missing ITAD certificates',
  methods: {
    POST: {
      summary: 'Issue a certificate for every asset still missing one',
      description:
        'Runs one independent issue per active, data-bearing, sanitized asset of the job without an issued certificate, in the chosen language. Each success gets its own number and PDF; each failure is reported with its status and code and does not stop the others.',
      requestBody: { contentType: 'application/json', schema: bodySchema },
      responses: [
        {
          status: 200,
          description: 'Per-asset result',
          schema: z.object({
            issued: z.array(z.object({ assetId: z.string().uuid(), serial: z.string(), certificateId: z.string().uuid(), certificateNumber: z.string() })),
            failed: z.array(
              z.object({ assetId: z.string().uuid(), serial: z.string(), status: z.number(), code: z.string().nullable(), error: z.string().nullable() }),
            ),
          }),
        },
      ],
      errors: [
        { status: 400, description: 'locale_invalid', schema: errorSchema },
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Missing itad.certificates.issue', schema: errorSchema },
        { status: 404, description: 'Job not found in scope', schema: errorSchema },
        { status: 409, description: 'certificate_not_eligible (job_status): the job status allows no new certificate', schema: errorSchema },
      ],
    },
  },
}

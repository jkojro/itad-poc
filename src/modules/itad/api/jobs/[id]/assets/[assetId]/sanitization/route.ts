import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { notFound } from '@open-mercato/shared/lib/crud/errors'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import { ITAD_ASSET_HISTORY_STATUSES, ITAD_ASSET_STATUSES, ITAD_ASSET_TRANSITION_ACTIONS } from '../../../../../../domain/job-types'
import { ITAD_RUN_RESULTS, ITAD_SANITIZATION_METHODS, ITAD_VERIFICATION_METHODS } from '../../../../../../domain/sanitization-state-machine'
import { itadRouteErrorResponse, loadReadableJob, resolveItadRouteContext } from '../../../../../../lib/route-context'
import { loadUserDisplayNames } from '../../../../../../module-integrations/users'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['itad.sanitization.view'] },
}

const paramsSchema = z.object({ id: z.string().uuid(), assetId: z.string().uuid() })

type AssetRow = { id: string; serial: string; status: string; data_bearing: boolean | null; updated_at: Date | string }
type RunRow = {
  id: string
  method: string
  method_detail: string | null
  tool: string
  tool_version: string
  operator_user_id: string
  started_at: Date | string
  finished_at: Date | string | null
  finished_by_user_id: string | null
  result: string | null
  verification_method: string | null
  verification_notes: string | null
  abort_reason: string | null
}
type EvidenceRow = { run_id: string; attachment_id: string; file_name: string; added_by_user_id: string; created_at: Date | string }
type TransitionRow = {
  id: string
  action: string
  from_status: string | null
  to_status: string
  data_bearing_from: boolean | null
  data_bearing_to: boolean | null
  run_id: string | null
  reason: string | null
  actor_user_id: string | null
  created_at: Date | string
}

const iso = (value: Date | string | null) => (value ? new Date(value).toISOString() : null)

/** One asset's runs (newest first, with evidence) and its status history (oldest first). */
export async function GET(request: Request, { params }: { params: { id: string; assetId: string } }) {
  try {
    const { id, assetId } = paramsSchema.parse({ id: params?.id, assetId: params?.assetId })
    const route = await resolveItadRouteContext(request)
    const job = await loadReadableJob(route, id)
    const em = route.container.resolve<EntityManager>('em').fork()
    const scope = [route.tenantId, job.organizationId]
    const asset = await em.execute<AssetRow>(
      `select "id", "serial", "status", "data_bearing", "updated_at" from "itad_assets"
       where "tenant_id" = ? and "organization_id" = ? and "job_id" = ? and "id" = ?`,
      [...scope, job.id, assetId],
      'get',
    )
    if (!asset) {
      const { translate } = await resolveTranslations()
      throw notFound(translate('itad.assets.errors.asset_not_found', 'Asset not found'))
    }
    const [runs, evidence, transitions] = await Promise.all([
      em.execute<RunRow[]>(
        `select "id", "method", "method_detail", "tool", "tool_version", "operator_user_id", "started_at", "finished_at",
                "finished_by_user_id", "result", "verification_method", "verification_notes", "abort_reason"
         from "itad_sanitization_runs" where "tenant_id" = ? and "organization_id" = ? and "asset_id" = ?
         order by "started_at" desc, "id" desc`,
        [...scope, assetId],
      ),
      em.execute<EvidenceRow[]>(
        `select e."run_id", e."attachment_id", e."file_name", e."added_by_user_id", e."created_at"
         from "itad_sanitization_evidence" e
         join "itad_sanitization_runs" r on r."id" = e."run_id"
         where e."tenant_id" = ? and e."organization_id" = ? and r."asset_id" = ?
         order by e."created_at" asc, e."id" asc`,
        [...scope, assetId],
      ),
      em.execute<TransitionRow[]>(
        `select "id", "action", "from_status", "to_status", "data_bearing_from", "data_bearing_to", "run_id", "reason",
                "actor_user_id", "created_at"
         from "itad_asset_status_transitions" where "tenant_id" = ? and "organization_id" = ? and "asset_id" = ?
         order by "created_at" asc, "id" asc`,
        [...scope, assetId],
      ),
    ])
    const userIds = [
      ...runs.flatMap((run) => [run.operator_user_id, run.finished_by_user_id]),
      ...evidence.map((entry) => entry.added_by_user_id),
      ...transitions.map((entry) => entry.actor_user_id),
    ].filter((value): value is string => Boolean(value))
    const names = await loadUserDisplayNames(route.container.resolve<QueryEngine>('queryEngine'), route.tenantId, userIds)
    const actor = (userId: string | null) => (userId ? { id: userId, name: names.get(userId) ?? null } : null)

    return NextResponse.json({
      asset: {
        id: asset.id,
        serial: asset.serial,
        status: asset.status,
        dataBearing: asset.data_bearing,
        updatedAt: new Date(asset.updated_at).toISOString(),
      },
      runs: runs.map((run) => ({
        id: run.id,
        method: run.method,
        methodDetail: run.method_detail,
        tool: run.tool,
        toolVersion: run.tool_version,
        operator: actor(run.operator_user_id),
        startedAt: iso(run.started_at),
        finishedAt: iso(run.finished_at),
        finishedBy: actor(run.finished_by_user_id),
        result: run.result,
        verificationMethod: run.verification_method,
        verificationNotes: run.verification_notes,
        abortReason: run.abort_reason,
        evidence: evidence
          .filter((entry) => entry.run_id === run.id)
          .map((entry) => ({
            attachmentId: entry.attachment_id,
            fileName: entry.file_name,
            addedBy: actor(entry.added_by_user_id),
            addedAt: iso(entry.created_at),
          })),
      })),
      history: transitions.map((entry) => ({
        id: entry.id,
        action: entry.action,
        fromStatus: entry.from_status,
        toStatus: entry.to_status,
        dataBearingFrom: entry.data_bearing_from,
        dataBearingTo: entry.data_bearing_to,
        runId: entry.run_id,
        reason: entry.reason,
        actor: actor(entry.actor_user_id),
        createdAt: iso(entry.created_at),
      })),
    })
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.sanitization.asset')
  }
}

const errorSchema = z.object({ error: z.string(), code: z.string().optional() }).passthrough()
const actorSchema = z.object({ id: z.string().uuid(), name: z.string().nullable() }).nullable()

export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'ITAD asset sanitization history',
  methods: {
    GET: {
      summary: 'Sanitization runs and status history of one asset',
      description:
        'Runs newest first, each with its evidence files; the status history oldest first. A FAIL shows two history rows (`sanitization_failed`, then `review_required`). `actor` is `null` for decisions made by the system at the scan.',
      responses: [
        {
          status: 200,
          description: 'Runs and history',
          schema: z.object({
            asset: z.object({
              id: z.string().uuid(),
              serial: z.string(),
              status: z.enum(ITAD_ASSET_STATUSES),
              dataBearing: z.boolean().nullable(),
              updatedAt: z.string(),
            }),
            runs: z.array(
              z.object({
                id: z.string().uuid(),
                method: z.enum(ITAD_SANITIZATION_METHODS),
                methodDetail: z.string().nullable(),
                tool: z.string(),
                toolVersion: z.string(),
                operator: actorSchema,
                startedAt: z.string(),
                finishedAt: z.string().nullable(),
                finishedBy: actorSchema,
                result: z.enum(ITAD_RUN_RESULTS).nullable(),
                verificationMethod: z.enum(ITAD_VERIFICATION_METHODS).nullable(),
                verificationNotes: z.string().nullable(),
                abortReason: z.string().nullable(),
                evidence: z.array(
                  z.object({ attachmentId: z.string().uuid(), fileName: z.string(), addedBy: actorSchema, addedAt: z.string() }),
                ),
              }),
            ),
            history: z.array(
              z.object({
                id: z.string().uuid(),
                action: z.enum(ITAD_ASSET_TRANSITION_ACTIONS),
                fromStatus: z.enum(ITAD_ASSET_HISTORY_STATUSES).nullable(),
                toStatus: z.enum(ITAD_ASSET_HISTORY_STATUSES),
                dataBearingFrom: z.boolean().nullable(),
                dataBearingTo: z.boolean().nullable(),
                runId: z.string().uuid().nullable(),
                reason: z.string().nullable(),
                actor: actorSchema,
                createdAt: z.string(),
              }),
            ),
          }),
        },
      ],
      errors: [
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Missing itad.sanitization.view', schema: errorSchema },
        { status: 404, description: 'Job or asset not found in scope', schema: errorSchema },
      ],
    },
  },
}

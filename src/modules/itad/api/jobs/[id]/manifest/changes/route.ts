import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import { ItadManifestImport, ItadManifestItem } from '../../../../../data/entities'
import { ITAD_JOB_STATUSES, type ItadJobStatus } from '../../../../../domain/job-types'
import {
  itadRouteErrorResponse,
  jobIdParamsSchema,
  loadReadableJob,
  resolveItadRouteContext,
} from '../../../../../lib/route-context'
import { loadUserDisplayNames } from '../../../../../module-integrations/users'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['itad.manifest.view'] },
}

/** Most recent manifest changes returned; the job history shows them next to status changes. */
const MAX_CHANGES = 500

type Change =
  | {
      kind: 'import'
      id: string
      at: Date
      actorUserId: string
      jobStatus: ItadJobStatus
      fileName: string
      sheetName: string | null
      importedCount: number
      skippedCount: number
    }
  | {
      kind: 'item_deleted'
      id: string
      at: Date
      actorUserId: string
      jobStatus: ItadJobStatus
      serial: string
      reason: string | null
    }

/**
 * Manifest changes of one job, newest first (spec "Manifest changes in history"):
 * imports and item removals, each with the effective job status at the time, so changes
 * made during receiving can be flagged. The status history route stays unchanged.
 */
export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    const { id } = jobIdParamsSchema.parse({ id: params?.id })
    const route = await resolveItadRouteContext(request)
    const job = await loadReadableJob(route, id)
    const em = route.container.resolve<EntityManager>('em').fork()
    const scope = { tenantId: route.tenantId, organizationId: job.organizationId, job: job.id }

    const [imports, deletions] = await Promise.all([
      em.find(ItadManifestImport, scope as FilterQuery<ItadManifestImport>, {
        orderBy: { createdAt: 'desc' },
        limit: MAX_CHANGES,
      }),
      em.find(ItadManifestItem, { ...scope, deletedAt: { $ne: null } } as FilterQuery<ItadManifestItem>, {
        orderBy: { deletedAt: 'desc' },
        limit: MAX_CHANGES,
      }),
    ])

    const changes: Change[] = [
      ...imports.map((entry): Change => ({
        kind: 'import',
        id: entry.id,
        at: entry.createdAt,
        actorUserId: entry.importedByUserId,
        jobStatus: entry.jobStatusAtChange,
        fileName: entry.fileName,
        sheetName: entry.sheetName ?? null,
        importedCount: entry.importedCount,
        skippedCount: entry.skippedCount,
      })),
      ...deletions.flatMap((item): Change[] =>
        item.deletedAt && item.deletedByUserId && item.deleteJobStatus
          ? [{
              kind: 'item_deleted',
              id: item.id,
              at: item.deletedAt,
              actorUserId: item.deletedByUserId,
              jobStatus: item.deleteJobStatus,
              serial: item.serial,
              reason: item.deleteReason ?? null,
            }]
          : [],
      ),
    ]
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, MAX_CHANGES)

    const names = await loadUserDisplayNames(
      route.container.resolve<QueryEngine>('queryEngine'),
      route.tenantId,
      changes.map((change) => change.actorUserId),
    )
    return NextResponse.json({
      items: changes.map(({ actorUserId, at, ...change }) => ({
        ...change,
        at: at.toISOString(),
        actor: { id: actorUserId, name: names.get(actorUserId) ?? null },
        duringReceiving: change.jobStatus === 'receiving',
      })),
    })
  } catch (err) {
    return itadRouteErrorResponse(err, 'itad.manifest.changes.get')
  }
}

const actorSchema = z.object({ id: z.string().uuid(), name: z.string().nullable() })
const baseChange = {
  id: z.string().uuid(),
  at: z.string(),
  actor: actorSchema,
  jobStatus: z.enum(ITAD_JOB_STATUSES),
  duringReceiving: z.boolean(),
}

const changesResponseSchema = z.object({
  items: z.array(
    z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('import'),
        ...baseChange,
        fileName: z.string(),
        sheetName: z.string().nullable(),
        importedCount: z.number().int(),
        skippedCount: z.number().int(),
      }),
      z.object({ kind: z.literal('item_deleted'), ...baseChange, serial: z.string(), reason: z.string().nullable() }),
    ]),
  ),
})

const errorSchema = z.object({ error: z.string(), code: z.string().optional() }).passthrough()

export const openApi: OpenApiRouteDoc = {
  tag: 'ITAD',
  summary: 'ITAD manifest changes',
  methods: {
    GET: {
      summary: 'List manifest changes of a job',
      description:
        'Imports and manifest item removals, newest first (at most 500), with the job status at the time and a `duringReceiving` flag.',
      responses: [{ status: 200, description: 'Manifest changes', schema: changesResponseSchema }],
      errors: [
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Missing itad.manifest.view', schema: errorSchema },
        { status: 404, description: 'Job not found in scope', schema: errorSchema },
      ],
    },
  },
}

import { z } from 'zod'
import { makeCrudRoute, type CrudCtx } from '@open-mercato/shared/lib/crud/factory'
import { badRequest } from '@open-mercato/shared/lib/crud/errors'
import { toQueryValueList } from '@open-mercato/shared/lib/crud/query-params'
import { escapeLikePattern } from '@open-mercato/shared/lib/db/escapeLikePattern'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import type { QueryEngine, Where, WhereValue } from '@open-mercato/shared/lib/query/types'
import {
  createCrudOpenApiFactory,
  createPagedListResponseSchema,
} from '@open-mercato/shared/lib/openapi/crud'
import { ItadJob } from '../../data/entities'
import { ITAD_JOB_STATUSES, type ItadJobStatus } from '../../domain/job-types'
import {
  itadJobCreateSchema,
  itadJobListSchema,
  itadJobStatusSchema,
  itadJobUpdateSchema,
  type ItadJobListQuery,
} from '../../data/validators'
import { itadJobCrudEvents, itadJobCrudIndexer } from '../../commands/jobs'
import { ITAD_JOB_ENTITY_ID } from '../../lib/constants'
import { loadCompanyNames } from '../../module-integrations/customers'
import { getEditableFields } from '../../domain/job-editability'
import { loadUserDisplayNames } from '../../module-integrations/users'
import type { ItadJobListItem } from '../../components/types'
import type { EntityManager } from '@mikro-orm/postgresql'
import { countActiveManifestItems } from '../../services/manifest-import'
import { countActiveAssets } from '../../services/reconciliation-reader'

const id = 'id'
const tenant_id = 'tenant_id'
const organization_id = 'organization_id'
const customer_id = 'customer_id'
const internal_reference = 'internal_reference'
const customer_reference = 'customer_reference'
const name = 'name'
const status = 'status'
const status_before_hold = 'status_before_hold'
const held_at = 'held_at'
const held_by_user_id = 'held_by_user_id'
const hold_reason = 'hold_reason'
const expected_asset_estimate = 'expected_asset_estimate'
const scheduled_pickup_at = 'scheduled_pickup_at'
const default_data_bearing = 'default_data_bearing'
const started_at = 'started_at'
const completed_at = 'completed_at'
const created_at = 'created_at'
// Required for the optimistic-lock round trip: `CrudForm` derives the expected-version
// header from `initialValues.updatedAt`, and row deletes build it from the row.
const updated_at = 'updated_at'

type JobRow = {
  id: string
  tenant_id: string
  organization_id: string
  customer_id: string
  internal_reference: string
  customer_reference: string | null
  name: string
  status: ItadJobStatus
  status_before_hold: ItadJobStatus | null
  held_at: Date | string | null
  held_by_user_id: string | null
  hold_reason: string | null
  expected_asset_estimate: number | string | null
  scheduled_pickup_at: Date | string | null
  default_data_bearing: boolean | null
  started_at: Date | string | null
  completed_at: Date | string | null
  created_at: Date | string
  updated_at: Date | string | null
}


function toIso(value: unknown): string | null {
  if (value == null) return null
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function toIntOrNull(value: unknown): number | null {
  if (value == null || value === '') return null
  const parsed = Number(value)
  return Number.isInteger(parsed) ? parsed : null
}

const sortFieldMap: Record<string, string> = {
  // References are sorted by creation time, never as strings (widths can differ).
  reference: created_at,
  name,
  status,
  scheduledPickupAt: scheduled_pickup_at,
  createdAt: created_at,
  updatedAt: updated_at,
}

type ListPayload = { items?: ItadJobListItem[] }

async function decorateItems(payload: ListPayload, ctx: CrudCtx & { query: ItadJobListQuery }): Promise<void> {
  const items = Array.isArray(payload.items) ? payload.items : []
  const tenantId = ctx.auth?.tenantId ?? null
  if (!items.length || !tenantId) return
  const queryEngine = ctx.container.resolve<QueryEngine>('queryEngine')
  const byOrganization = new Map<string, string[]>()
  for (const item of items) {
    const ids = byOrganization.get(item.organizationId) ?? []
    ids.push(item.customerId)
    byOrganization.set(item.organizationId, ids)
  }
  const names = new Map<string, string>()
  for (const [organizationId, customerIds] of byOrganization) {
    const found = await loadCompanyNames(queryEngine, { tenantId, organizationId }, customerIds)
    for (const [customerId, displayName] of found) names.set(`${organizationId}:${customerId}`, displayName)
  }
  const holders = await loadUserDisplayNames(queryEngine, tenantId, items.map((item) => item.heldByUserId))
  // Derived counter (spec "Derived values"): part of the job summary, needs only `itad.jobs.view`.
  const em = ctx.container.resolve<EntityManager>('em').fork()
  const jobIds = items.map((item) => item.id)
  const [expectedCounts, receivedCounts] = await Promise.all([
    countActiveManifestItems(em, tenantId, jobIds),
    countActiveAssets(em, tenantId, jobIds),
  ])
  const singleRecord = typeof ctx.query.id === 'string' && ctx.query.id.length > 0
  for (const item of items) {
    item.heldBy = item.heldByUserId ? { id: item.heldByUserId, name: holders.get(item.heldByUserId) ?? null } : null
    // `null` means the company was deleted (or moved out of scope) after the job was created.
    item.customerName = names.get(`${item.organizationId}:${item.customerId}`) ?? null
    item.expectedAssetCount = expectedCounts.get(item.id) ?? 0
    item.receivedAssetCount = receivedCounts.get(item.id) ?? 0
    if (singleRecord) item.editableFields = getEditableFields(item)
  }
}

export const { metadata, GET, POST, PUT, DELETE } = makeCrudRoute({
  metadata: {
    GET: { requireAuth: true, requireFeatures: ['itad.jobs.view'] },
    POST: { requireAuth: true, requireFeatures: ['itad.jobs.manage'] },
    PUT: { requireAuth: true, requireFeatures: ['itad.jobs.manage'] },
    DELETE: { requireAuth: true, requireFeatures: ['itad.jobs.manage'] },
  },
  orm: {
    entity: ItadJob,
    idField: 'id',
    orgField: 'organizationId',
    tenantField: 'tenantId',
    softDeleteField: 'deletedAt',
  },
  events: itadJobCrudEvents,
  indexer: itadJobCrudIndexer,
  list: {
    schema: itadJobListSchema,
    entityId: ITAD_JOB_ENTITY_ID,
    fields: [
      id,
      tenant_id,
      organization_id,
      customer_id,
      internal_reference,
      customer_reference,
      name,
      status,
      status_before_hold,
      held_at,
      held_by_user_id,
      hold_reason,
      expected_asset_estimate,
      scheduled_pickup_at,
      default_data_bearing,
      started_at,
      completed_at,
      created_at,
      updated_at,
    ],
    sortFieldMap,
    buildFilters: async (query: ItadJobListQuery): Promise<Where<JobRow>> => {
      const filters: Where<JobRow> = {}
      const F = filters as Record<string, WhereValue>
      if (query.id) F.id = { $eq: query.id }
      if (query.customerId) F.customer_id = { $eq: query.customerId }
      const statuses = toQueryValueList(query.status)
      if (statuses.length > 0) {
        const parsed = statuses.map((value) => itadJobStatusSchema.safeParse(value))
        if (parsed.some((result) => !result.success)) {
          const { translate } = await resolveTranslations()
          throw badRequest(translate('itad.jobs.errors.status_filter_invalid', 'Unknown status filter'))
        }
        const values = parsed.flatMap((result) => (result.success ? [result.data] : []))
        F.status = values.length === 1 ? { $eq: values[0] } : { $in: values }
      }
      if (query.search) {
        // None of these columns is encrypted, so a plain `$ilike` is correct here.
        const pattern = `%${escapeLikePattern(query.search)}%`
        filters.$or = [
          { internal_reference: { $ilike: pattern } },
          { customer_reference: { $ilike: pattern } },
          { name: { $ilike: pattern } },
        ] as unknown as WhereValue
      }
      return filters
    },
    transformItem: (item: JobRow): ItadJobListItem => ({
      id: String(item.id),
      organizationId: String(item.organization_id),
      customerId: String(item.customer_id),
      customerName: null,
      internalReference: String(item.internal_reference),
      customerReference: item.customer_reference ?? null,
      name: String(item.name),
      status: item.status,
      statusBeforeHold: item.status_before_hold ?? null,
      heldAt: toIso(item.held_at),
      heldByUserId: item.held_by_user_id ?? null,
      holdReason: item.hold_reason ?? null,
      heldBy: null,
      expectedAssetEstimate: toIntOrNull(item.expected_asset_estimate),
      expectedAssetCount: 0,
      receivedAssetCount: 0,
      scheduledPickupAt: toIso(item.scheduled_pickup_at),
      defaultDataBearing: typeof item.default_data_bearing === 'boolean' ? item.default_data_bearing : null,
      startedAt: toIso(item.started_at),
      completedAt: toIso(item.completed_at),
      createdAt: toIso(item.created_at),
      updatedAt: toIso(item.updated_at),
    }),
  },
  hooks: {
    afterList: (payload: ListPayload, ctx) => decorateItems(payload, ctx as CrudCtx & { query: ItadJobListQuery }),
  },
  actions: {
    create: {
      commandId: 'itad.jobs.create',
      // Passthrough on purpose: the command rejects system fields with
      // `field_not_writable` instead of letting zod strip them silently.
      schema: z.object({}).passthrough(),
      mapInput: ({ parsed }) => parsed,
      response: ({ result }) => ({ id: String(result.id), internalReference: String(result.internalReference) }),
      status: 201,
    },
    update: {
      commandId: 'itad.jobs.update',
      schema: z.object({}).passthrough(),
      mapInput: ({ parsed }) => parsed,
      response: () => ({ ok: true }),
    },
    delete: {
      commandId: 'itad.jobs.delete',
      response: () => ({ ok: true }),
    },
  },
})

const itadJobListItemSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  customerId: z.string().uuid(),
  customerName: z.string().nullable(),
  internalReference: z.string(),
  customerReference: z.string().nullable(),
  name: z.string(),
  status: z.enum(ITAD_JOB_STATUSES),
  statusBeforeHold: z.enum(ITAD_JOB_STATUSES).nullable(),
  heldAt: z.string().nullable(),
  heldByUserId: z.string().uuid().nullable(),
  holdReason: z.string().nullable(),
  heldBy: z.object({ id: z.string().uuid(), name: z.string().nullable() }).nullable(),
  expectedAssetEstimate: z.number().int().nullable(),
  expectedAssetCount: z.number().int(),
  receivedAssetCount: z.number().int(),
  scheduledPickupAt: z.string().nullable(),
  defaultDataBearing: z.boolean().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  editableFields: z.array(z.string()).optional(),
})

const buildItadCrudOpenApi = createCrudOpenApiFactory({
  defaultTag: 'ITAD',
  makeListDescription: ({ pluralLower }) =>
    `Returns a paginated collection of ${pluralLower} in the current tenant and organization scope.`,
})

export const openApi = buildItadCrudOpenApi({
  resourceName: 'ITAD Job',
  pluralName: 'ITAD Jobs',
  querySchema: itadJobListSchema,
  listResponseSchema: createPagedListResponseSchema(itadJobListItemSchema, { paginationMetaOptional: true }),
  create: {
    schema: itadJobCreateSchema,
    responseSchema: z.object({ id: z.string().uuid(), internalReference: z.string() }),
    description:
      'Creates a draft ITAD job and issues its internal reference. System fields (status, references, hold and lifecycle timestamps) are rejected with `itad.jobs.errors.field_not_writable`.',
  },
  update: {
    schema: itadJobUpdateSchema,
    responseSchema: z.object({ ok: z.literal(true) }),
    description:
      'Updates editable fields of an ITAD job according to its status. Send the expected `updatedAt` in the optimistic-lock header.',
  },
  del: {
    schema: z.object({ id: z.string().uuid() }),
    responseSchema: z.object({ ok: z.literal(true) }),
    description: 'Soft-deletes a draft ITAD job. Non-draft jobs return `itad.jobs.errors.delete_not_draft`.',
  },
})

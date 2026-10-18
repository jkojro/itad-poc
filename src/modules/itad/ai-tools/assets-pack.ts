import { z } from 'zod'
import type { AiToolDefinition } from '@open-mercato/ai-assistant/modules/ai_assistant/lib/types'
import { ITAD_EXCEPTION_TYPES } from '../domain/exceptions'
import type { JobOverviewCounters } from '../domain/job-overview'
import {
  assetHref,
  bounded,
  hidden,
  jobHref,
  lookupStatus,
  toSanitizationSummary,
  untrusted,
  type SanitizationCounts,
} from '../lib/ai-tool-compose'
import { can, defineItadTool, requireRouteData, routeData, runItadRoute } from './_shared'

/**
 * Asset, sanitization, exception and certificate tools of `itad.operations_assistant`
 * (AI assistant spec, tool allowlist). Read only, through the ITAD routes in process.
 */

type LookupRow = {
  id: string
  serial: string
  customerAssetTag: string | null
  manufacturer: string | null
  model: string | null
  status: string
  matchedOn: 'serial' | 'customerAssetTag'
  exactMatch: boolean
  receivedAt: string
  jobId: string
  jobReference: string
  jobName: string
  jobStatus: string
  customerName: string | null
}
type AssetDetail = {
  id: string
  serial: string
  customerAssetTag: string | null
  manufacturer: string | null
  model: string | null
  dataBearing: boolean | null
  status: string
  reconciliation: 'matched' | 'unexpected'
  receivedAt: string
  deleted: boolean
  openExceptionCount: number
  job: { id: string; internalReference: string; name: string; status: string }
}
type TimelineItem = {
  at: string
  kind: string
  category: string
  actor: { id: string; name: string | null } | null
  details: Record<string, unknown> & { reason?: string | null }
}
type CertificateItem = {
  id: string
  certificateNumber: string
  status: string
  assetId: string
  assetSerial: string
  issuedAt: string
}
type ExceptionRow = {
  id: string
  type: string
  status: string
  serial: string
  assetId: string | null
  assignedTo: { id: string; name: string | null } | null
  createdAt: string
  resolutionReason: string | null
  updatedAt: string
}

const jobAsset = z.object({
  jobId: z.string().uuid().describe('Job id of the asset, from find_asset.'),
  assetId: z.string().uuid().describe('Asset id, from find_asset.'),
})

// ─── find_asset ──────────────────────────────────────────────────────────────

const findAssetTool: AiToolDefinition = defineItadTool({
  name: 'itad.find_asset',
  displayName: 'Find an asset',
  description:
    'Find ITAD assets by serial number or customer asset tag (exact or prefix, at least 3 characters) across the caller\'s jobs. Returns { status: unique | ambiguous | none, candidates } with job, customer and live status. When ambiguous, ask which one; never pick yourself.',
  inputSchema: z.object({ q: z.string().trim().min(3).max(200).describe('Serial number or customer asset tag.') }),
  requiredFeatures: ['itad.assets.view'],
  isMutation: false,
  handler: async (input: { q: string }, ctx) => {
    const response = await runItadRoute<{ items: LookupRow[]; total: number }>(ctx, findAssetTool, {
      method: 'GET',
      path: '/assets',
      query: { q: input.q, pageSize: 25 },
    })
    const data = routeData(response, 'Asset search') ?? { items: [], total: 0 }
    const exact = data.items.filter((row) => row.exactMatch)
    const rows = exact.length > 0 ? exact : data.items
    const candidates = rows.map((row) => ({
      assetId: row.id,
      serial: row.serial,
      customerAssetTag: row.customerAssetTag,
      device: [row.manufacturer, row.model].filter(Boolean).join(' ') || null,
      status: row.status,
      matchedOn: row.matchedOn,
      exactMatch: row.exactMatch,
      jobId: row.jobId,
      jobReference: row.jobReference,
      jobName: row.jobName,
      customer: row.customerName,
      link: assetHref(row.jobId, row.id),
    }))
    return { status: lookupStatus(candidates.length), candidates: bounded(candidates, exact.length > 0 ? exact.length : data.total) }
  },
})

// ─── get_asset_history ───────────────────────────────────────────────────────

const getAssetHistoryTool: AiToolDefinition = defineItadTool({
  name: 'itad.get_asset_history',
  displayName: 'Asset history',
  description:
    'What happened to one device: its current state, the business timeline (intake, reconciliation, data-bearing decision, sanitization runs, exceptions) and its certificate. Sections the caller may not see are marked hidden.',
  inputSchema: jobAsset,
  requiredFeatures: ['itad.assets.view'],
  isMutation: false,
  handler: async (input: z.infer<typeof jobAsset>, ctx) => {
    const base = `/jobs/${input.jobId}/assets/${input.assetId}`
    const asset = routeData(await runItadRoute<AssetDetail>(ctx, getAssetHistoryTool, { method: 'GET', path: base }), 'Asset detail')
    if (!asset) return { found: false, assetId: input.assetId }
    // The timeline route itself leaves out sanitization and exception entries the caller may not see.
    const timeline = requireRouteData(
      await runItadRoute<{ items: TimelineItem[] }>(ctx, getAssetHistoryTool, { method: 'GET', path: `${base}/timeline` }),
      'Asset timeline',
    )
    let certificates: ReturnType<typeof bounded> | ReturnType<typeof hidden> = hidden()
    if (can(ctx, 'itad.certificates.view')) {
      const data = routeData(
        await runItadRoute<{ items: CertificateItem[] }>(ctx, getAssetHistoryTool, { method: 'GET', path: `${base}/certificates` }, ['itad.certificates.view']),
        'Asset certificates',
      )
      certificates = bounded(
        (data?.items ?? []).map((certificate) => ({
          certificateNumber: certificate.certificateNumber,
          status: certificate.status,
          issuedAt: certificate.issuedAt,
        })),
      )
    }
    const entries = timeline.items.map((entry) => ({
      at: entry.at,
      event: entry.kind,
      category: entry.category,
      by: entry.actor?.name ?? null,
      details: Object.fromEntries(
        Object.entries(entry.details).filter(([key, value]) => key !== 'reason' && key !== 'assignedTo' && key !== 'assignedToUserId' && value != null),
      ),
      assignedTo: (entry.details.assignedTo as { name?: string | null } | null | undefined)?.name ?? null,
      ...untrusted({ reason: entry.details.reason ?? null }),
    }))
    return {
      found: true,
      asset: {
        assetId: asset.id,
        serial: asset.serial,
        customerAssetTag: asset.customerAssetTag,
        device: [asset.manufacturer, asset.model].filter(Boolean).join(' ') || null,
        status: asset.status,
        dataBearing: asset.dataBearing,
        reconciliation: asset.reconciliation,
        removed: asset.deleted,
        openExceptions: asset.openExceptionCount,
        receivedAt: asset.receivedAt,
        job: { jobId: asset.job.id, reference: asset.job.internalReference, name: asset.job.name, status: asset.job.status },
      },
      // Most recent last, as the timeline reads; long histories keep their newest entries.
      timeline: { items: entries.slice(-25), total: entries.length, truncated: entries.length > 25 },
      sections: { sanitization: can(ctx, 'itad.sanitization.view') ? 'visible' : 'hidden', exceptions: can(ctx, 'itad.exceptions.view') ? 'visible' : 'hidden' },
      certificates,
      link: assetHref(asset.job.id, asset.id),
    }
  },
})

// ─── get_sanitization_summary ────────────────────────────────────────────────

const getSanitizationSummaryTool: AiToolDefinition = defineItadTool({
  name: 'itad.get_sanitization_summary',
  displayName: 'Sanitization summary',
  description:
    'Sanitization picture of one job: awaiting wipe, in progress, sanitized, failed and needing review, plus devices not data-bearing and still undecided.',
  inputSchema: z.object({ jobId: z.string().uuid() }),
  requiredFeatures: ['itad.sanitization.view'],
  isMutation: false,
  handler: async (input: { jobId: string }, ctx) => {
    const list = routeData(
      await runItadRoute<{ counts: SanitizationCounts }>(ctx, getSanitizationSummaryTool, {
        method: 'GET',
        path: `/jobs/${input.jobId}/sanitization`,
        query: { pageSize: 1 },
      }),
      'Sanitization',
    )
    if (!list) return { found: false, jobId: input.jobId }
    let counters: JobOverviewCounters | null = null
    if (can(ctx, 'itad.jobs.view')) {
      const overview = routeData(
        await runItadRoute<{ counters: JobOverviewCounters }>(
          ctx,
          getSanitizationSummaryTool,
          { method: 'GET', path: `/jobs/${input.jobId}/overview` },
          ['itad.jobs.view'],
        ),
        'Job overview',
      )
      counters = overview?.counters ?? null
    }
    return {
      found: true,
      jobId: input.jobId,
      ...toSanitizationSummary({ counts: list.counts, counters }),
      link: jobHref(input.jobId, 'tab=sanitization'),
    }
  },
})

// ─── list_open_exceptions ────────────────────────────────────────────────────

const listOpenExceptionsInput = z.object({
  jobId: z.string().uuid(),
  type: z.enum(ITAD_EXCEPTION_TYPES).optional(),
  assignee: z
    .union([z.enum(['me', 'unassigned']), z.string().uuid()])
    .optional()
    .describe('me, unassigned or a user id; omit for any assignee.'),
})

const listOpenExceptionsTool: AiToolDefinition = defineItadTool({
  name: 'itad.list_open_exceptions',
  displayName: 'Open exceptions',
  description: 'Open exceptions of one job, optionally by type and assignee, with device, assignee and age.',
  inputSchema: listOpenExceptionsInput,
  requiredFeatures: ['itad.exceptions.view'],
  isMutation: false,
  handler: async (input: z.infer<typeof listOpenExceptionsInput>, ctx) => {
    const query: Record<string, string | number> = { status: 'open', pageSize: 25 }
    if (input.type) query.type = input.type
    if (input.assignee) query.assignedTo = input.assignee
    const data = routeData(
      await runItadRoute<{ items: ExceptionRow[]; total: number }>(ctx, listOpenExceptionsTool, {
        method: 'GET',
        path: `/jobs/${input.jobId}/exceptions`,
        query,
      }),
      'Open exceptions',
    )
    if (!data) return { found: false, jobId: input.jobId }
    return {
      found: true,
      jobId: input.jobId,
      filters: { type: input.type ?? null, assignee: input.assignee ?? null },
      exceptions: bounded(
        data.items.map((exception) => ({
          exceptionId: exception.id,
          type: exception.type,
          serial: exception.serial,
          assetId: exception.assetId,
          assignedTo: exception.assignedTo?.name ?? null,
          assignedToUserId: exception.assignedTo?.id ?? null,
          openedAt: exception.createdAt,
          version: exception.updatedAt,
        })),
        data.total,
      ),
      link: jobHref(input.jobId, `tab=exceptions&status=open${input.type ? `&type=${input.type}` : ''}`),
    }
  },
})

// ─── find_certificate ────────────────────────────────────────────────────────

const findCertificateInput = z.object({
  jobId: z.string().uuid(),
  assetId: z.string().uuid().optional().describe('Omit to get the certificates of the whole job.'),
})

const findCertificateTool: AiToolDefinition = defineItadTool({
  name: 'itad.find_certificate',
  displayName: 'Find certificates',
  description:
    'Erasure certificates of one asset, or of a whole job with its counts (required, issued, missing) and the devices still missing one.',
  inputSchema: findCertificateInput,
  requiredFeatures: ['itad.certificates.view'],
  isMutation: false,
  handler: async (input: z.infer<typeof findCertificateInput>, ctx) => {
    const certificate = (item: CertificateItem) => ({
      certificateNumber: item.certificateNumber,
      status: item.status,
      assetId: item.assetId,
      serial: item.assetSerial,
      issuedAt: item.issuedAt,
    })
    if (input.assetId) {
      const data = routeData(
        await runItadRoute<{ items: CertificateItem[] }>(ctx, findCertificateTool, {
          method: 'GET',
          path: `/jobs/${input.jobId}/assets/${input.assetId}/certificates`,
        }),
        'Asset certificates',
      )
      if (!data) return { found: false, assetId: input.assetId }
      return { found: true, scope: 'asset', certificates: bounded(data.items.map(certificate)), link: assetHref(input.jobId, input.assetId) }
    }
    const data = routeData(
      await runItadRoute<{ items: CertificateItem[]; counts: Record<string, number>; missingAssets: Array<{ id: string; serial: string }> }>(
        ctx,
        findCertificateTool,
        { method: 'GET', path: `/jobs/${input.jobId}/certificates` },
      ),
      'Job certificates',
    )
    if (!data) return { found: false, jobId: input.jobId }
    return {
      found: true,
      scope: 'job',
      counts: data.counts,
      certificates: bounded(data.items.map(certificate)),
      missing: bounded(data.missingAssets.map((asset) => ({ assetId: asset.id, serial: asset.serial, link: assetHref(input.jobId, asset.id) }))),
      link: jobHref(input.jobId, 'tab=documents'),
    }
  },
})

export const assetsAiTools: AiToolDefinition[] = [
  findAssetTool,
  getAssetHistoryTool,
  getSanitizationSummaryTool,
  listOpenExceptionsTool,
  findCertificateTool,
]

export default assetsAiTools

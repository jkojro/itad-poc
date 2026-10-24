import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, type APIRequestContext } from '@playwright/test'
import { apiRequest } from '@open-mercato/core/helpers/integration/api'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'

/**
 * ITAD Inbox Ops integration fixtures (spec 2026-10-24-itad-inbox-ops). Tests never call a
 * model: the environment runs with `OM_TEST_MODE=1`, where a manual import may carry the
 * interpretation (`extraction`) and anything else gets an empty one.
 */

export type InboxImport = { fromAddress: string; fromName?: string | null; subject: string; bodyText: string; extraction?: Record<string, unknown> }

export async function importInboxMessage(request: APIRequestContext, token: string, body: InboxImport): Promise<string> {
  const response = await apiRequest(request, 'POST', '/api/itad/inbox/messages', { token, data: body })
  const json = await readJsonSafe<{ id?: string }>(response)
  expect(response.status(), JSON.stringify(json)).toBe(202)
  return json!.id!
}

export type InboxDetail = Record<string, any> & { id: string; status: string; updatedAt: string; actions: Array<Record<string, any>> }

export async function inboxDetail(request: APIRequestContext, token: string, id: string): Promise<InboxDetail> {
  const response = await apiRequest(request, 'GET', `/api/itad/inbox/messages/${id}`, { token })
  expect(response.status()).toBe(200)
  return (await readJsonSafe<InboxDetail>(response))!
}

/** Waits until the worker wrote the current generation (status leaves `processing`). */
export async function waitProcessed(request: APIRequestContext, token: string, id: string, timeoutMs = 45_000): Promise<InboxDetail> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const detail = await inboxDetail(request, token, id)
    if (detail.status !== 'processing') return detail
    if (Date.now() > deadline) throw new Error(`Inbox message ${id} still processing after ${timeoutMs} ms`)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

export async function listInbox(request: APIRequestContext, token: string, query = '') {
  const response = await apiRequest(request, 'GET', `/api/itad/inbox/messages${query ? `?${query}` : ''}`, { token })
  expect(response.status()).toBe(200)
  return (await readJsonSafe<{ items: Array<Record<string, any>>; total: number }>(response))!
}

export async function postMessageAction(request: APIRequestContext, token: string, id: string, action: 'reprocess' | 'draft', updatedAt: string) {
  const response = await apiRequest(request, 'POST', `/api/itad/inbox/messages/${id}/${action}`, {
    token,
    data: {},
    headers: { 'x-om-ext-optimistic-lock-expected-updated-at': updatedAt },
  })
  return { status: response.status(), body: await readJsonSafe<Record<string, any>>(response) }
}

/** An interpretation with only a status inquiry. */
export const statusInquiry = (summary = 'Status inquiry') => ({ intents: [{ intent: 'status_inquiry', confidence: 'high' }], summary, language: 'en' })

// ─── inbox_ops webhook (custom signed format) ─────────────────────────────────

function webhookSecret(): string {
  if (process.env.INBOX_OPS_WEBHOOK_SECRET) return process.env.INBOX_OPS_WEBHOOK_SECRET
  const env = readFileSync(path.resolve(process.cwd(), '.env'), 'utf8')
  const line = env.split('\n').find((entry) => entry.startsWith('INBOX_OPS_WEBHOOK_SECRET='))
  if (!line) throw new Error('INBOX_OPS_WEBHOOK_SECRET is not configured')
  return line.slice('INBOX_OPS_WEBHOOK_SECRET='.length).trim().replace(/^"|"$/g, '')
}

export async function organizationInboxAddress(request: APIRequestContext, token: string): Promise<string> {
  const response = await apiRequest(request, 'GET', '/api/inbox_ops/settings', { token })
  expect(response.status()).toBe(200)
  const body = await readJsonSafe<{ settings?: { inboxAddress?: string } | null }>(response)
  expect(body?.settings?.inboxAddress, 'the organization has an inbound address').toBeTruthy()
  return body!.settings!.inboxAddress!
}

/** Delivers an email the way an email provider would: JSON body signed with HMAC-SHA256 over `timestamp.body`. */
export async function deliverSignedEmail(
  request: APIRequestContext,
  email: { to: string; from: string; subject: string; text: string; messageId: string },
  options: { badSignature?: boolean } = {},
) {
  const body = JSON.stringify(email)
  const timestamp = String(Math.floor(Date.now() / 1000))
  const signature = createHmac('sha256', options.badSignature ? 'not-the-secret' : webhookSecret()).update(`${timestamp}.${body}`).digest('hex')
  const response = await request.post('/api/inbox_ops/webhook/inbound', {
    data: body,
    headers: { 'content-type': 'application/json', 'x-webhook-signature': `sha256=${signature}`, 'x-webhook-timestamp': timestamp },
  })
  return { status: response.status(), body: await readJsonSafe<Record<string, unknown>>(response) }
}

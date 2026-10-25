// Central place to enable modules and their source.
// - id: module id (plural snake_case; special cases: 'auth')
// - from: '@open-mercato/core' | '@app' | custom alias/path in future
import { parseBooleanWithDefault } from '@open-mercato/shared/lib/boolean'
import type { ModuleOverrides } from '@open-mercato/shared/modules/overrides'

export type ModuleEntry = { id: string; from?: '@open-mercato/core' | '@app' | string; overrides?: ModuleOverrides }

export const enabledModules: ModuleEntry[] = [
  { id: 'auth', from: '@open-mercato/core' },
  { id: 'directory', from: '@open-mercato/core' },
  { id: 'configs', from: '@open-mercato/core' },
  { id: 'entities', from: '@open-mercato/core' },
  { id: 'query_index', from: '@open-mercato/core' },
  { id: 'api_docs', from: '@open-mercato/core' },
  { id: 'audit_logs', from: '@open-mercato/core' },
  { id: 'notifications', from: '@open-mercato/core' },
  { id: 'dashboards', from: '@open-mercato/core' },
  { id: 'events', from: '@open-mercato/events' },
  { id: 'search', from: '@open-mercato/search' },
  { id: 'attachments', from: '@open-mercato/core' },
  { id: 'dictionaries', from: '@open-mercato/core' },
  { id: 'currencies', from: '@open-mercato/core' },
  { id: 'feature_toggles', from: '@open-mercato/core' },
  { id: 'customers', from: '@open-mercato/core' },
  { id: 'ai_assistant', from: '@open-mercato/ai-assistant' },
  {
    // ITAD Inbox Ops (spec 2026-10-24-itad-inbox-ops, Q1 hybrid): inbox_ops is only the
    // inbound email transport — webhook, signatures, organization routing, deduplication,
    // threading. ITAD owns matching, proposals and execution, so its order / quote
    // extraction and the pages that show its proposals are disabled.
    id: 'inbox_ops',
    from: '@open-mercato/core',
    overrides: {
      events: { subscribers: { 'inbox_ops:extraction-worker': null } },
      routes: {
        pages: {
          '/backend/inbox-ops': null,
          '/backend/inbox-ops/log': null,
          '/backend/inbox-ops/proposals/[id]': null,
        },
      },
    },
  },
]

enabledModules.push({ id: 'itad', from: '@app' })

const enterpriseModulesEnabled = parseBooleanWithDefault(process.env.OM_ENABLE_ENTERPRISE_MODULES, false)
const enterpriseSsoEnabled = parseBooleanWithDefault(process.env.OM_ENABLE_ENTERPRISE_MODULES_SSO, false)
const enterpriseSecurityEnabled = parseBooleanWithDefault(process.env.OM_ENABLE_ENTERPRISE_MODULES_SECURITY, false)
const enterpriseAgentsEnabled = parseBooleanWithDefault(process.env.OM_ENABLE_ENTERPRISE_MODULES_AGENTS, false)

if (enterpriseModulesEnabled) {
  enabledModules.push(
    { id: 'record_locks', from: '@open-mercato/enterprise' },
    { id: 'system_status_overlays', from: '@open-mercato/enterprise' },
  )
}

if (enterpriseModulesEnabled && enterpriseSsoEnabled) {
  enabledModules.push({ id: 'sso', from: '@open-mercato/enterprise' })
}

if (enterpriseModulesEnabled && enterpriseSecurityEnabled) {
  enabledModules.push({ id: 'security', from: '@open-mercato/enterprise' })
}

if (enterpriseModulesEnabled && enterpriseAgentsEnabled) {
  enabledModules.push({ id: 'agent_orchestrator', from: '@open-mercato/enterprise' })
  // Example app module: shows how to declare an Agent Orchestrator agent from a
  // brand-new module. Its source ships in every preset; it imports the
  // orchestrator SDK, so it is only enabled alongside it.
  enabledModules.push({ id: 'agent_examples', from: '@app' })
}

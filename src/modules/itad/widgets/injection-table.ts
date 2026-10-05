import type { ModuleInjectionTable } from '@open-mercato/shared/modules/widgets/injection'

/**
 * Spot → widget mapping for the `itad` module. One unconditional object literal so the
 * generator's fact extractor can read it; entries keyed on another module's spot are
 * inert when that module is absent (the widget also declares `requiredModules`).
 */
export const injectionTable: ModuleInjectionTable = {
  // "ITAD Jobs" tab on the current company detail page (`/backend/customers/companies-v2/[id]`,
  // the target of the companies list). This host translates `groupLabel`, so it is a key.
  'detail:customers.company:tabs': {
    widgetId: 'itad.injection.company-jobs-tab',
    priority: 10,
    kind: 'tab',
    groupId: 'itad-jobs',
    groupLabel: 'itad.jobs.companyTab.label',
  },
  // Same tab on the legacy company detail page (`/backend/customers/companies/[id]`), still
  // reachable by URL. This host renders `groupLabel` verbatim, so it is plain text.
  'customers.company.detail:tabs': {
    widgetId: 'itad.injection.company-jobs-tab',
    priority: 10,
    kind: 'tab',
    groupId: 'itad-jobs',
    groupLabel: 'ITAD Jobs',
  },
}

export default injectionTable

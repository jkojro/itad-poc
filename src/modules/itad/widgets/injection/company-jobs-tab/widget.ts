import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import CompanyJobsTabWidget from './widget.client'

/**
 * "ITAD Jobs" tab on the installed customers company detail pages — current
 * (`detail:customers.company:tabs`) and legacy (`customers.company.detail:tabs`), both
 * mapped in `widgets/injection-table.ts`; both hosts pass `companyId` in the context.
 *
 * `features` hides the tab from users without `itad.jobs.view` (wildcard-aware, enforced
 * by the host's `useInjectionWidgets`); the list API enforces the same feature on its own.
 * `requiredModules` keeps the widget unloaded when `customers` is not enabled.
 */
const widget: InjectionWidgetModule = {
  metadata: {
    id: 'itad.injection.company-jobs-tab',
    title: 'ITAD Jobs',
    features: ['itad.jobs.view'],
    requiredModules: ['customers'],
    priority: 10,
  },
  Widget: CompanyJobsTabWidget,
}

export default widget

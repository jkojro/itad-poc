import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import PickupTaskJobLinkWidget from './widget.client'

/**
 * "Go to job" box in the `customers` interaction form (`crud-form:customers.customer_interaction`),
 * which the calendar's event editor renders too (pickup calendar spec). Shows only for a
 * pickup task; any other interaction renders nothing.
 *
 * `features` hides it from users without `itad.jobs.view`; the lookup API enforces the
 * same feature. `requiredModules` keeps it unloaded when `customers` is not enabled.
 */
const widget: InjectionWidgetModule = {
  metadata: {
    id: 'itad.injection.pickup-task-job-link',
    title: 'ITAD pickup job link',
    features: ['itad.jobs.view'],
    requiredModules: ['customers'],
    priority: 10,
  },
  Widget: PickupTaskJobLinkWidget,
}

export default widget

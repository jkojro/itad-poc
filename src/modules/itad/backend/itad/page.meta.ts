export const metadata = {
  requireAuth: true,
  requireFeatures: ['itad.jobs.view'],
  pageTitle: 'Operations',
  pageTitleKey: 'itad.operations.title',
  pageGroup: 'ITAD',
  pageGroupKey: 'itad.nav.group',
  // The ITAD landing page (operations dashboard spec Q1): first in the group.
  pageOrder: 5,
  icon: 'layout-dashboard',
  breadcrumb: [{ label: 'Operations', labelKey: 'itad.operations.title' }],
}

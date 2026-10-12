export const metadata = {
  requireAuth: true,
  requireFeatures: ['itad.assets.view'],
  pageTitle: 'ITAD device',
  pageTitleKey: 'itad.assetDetail.title',
  pageGroup: 'ITAD',
  pageGroupKey: 'itad.nav.group',
  pageOrder: 13,
  navHidden: true,
  icon: 'package-search',
  breadcrumb: [
    { label: 'ITAD Jobs', labelKey: 'itad.jobs.page.title', href: '/backend/itad/jobs' },
    { label: 'ITAD device', labelKey: 'itad.assetDetail.title' },
  ],
}

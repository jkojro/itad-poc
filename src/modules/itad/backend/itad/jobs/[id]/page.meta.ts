export const metadata = {
  requireAuth: true,
  requireFeatures: ['itad.jobs.view'],
  pageTitle: 'ITAD job',
  pageTitleKey: 'itad.jobs.detail.title',
  pageGroup: 'ITAD',
  pageGroupKey: 'itad.nav.group',
  pageOrder: 12,
  navHidden: true,
  icon: 'clipboard-list',
  breadcrumb: [
    { label: 'ITAD Jobs', labelKey: 'itad.jobs.page.title', href: '/backend/itad/jobs' },
    { label: 'ITAD job', labelKey: 'itad.jobs.detail.title' },
  ],
}

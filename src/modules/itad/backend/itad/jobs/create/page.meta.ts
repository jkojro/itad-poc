export const metadata = {
  requireAuth: true,
  requireFeatures: ['itad.jobs.manage'],
  pageTitle: 'New ITAD job',
  pageTitleKey: 'itad.jobs.create.title',
  pageGroup: 'ITAD',
  pageGroupKey: 'itad.nav.group',
  pageOrder: 11,
  navHidden: true,
  icon: 'clipboard-list',
  breadcrumb: [
    { label: 'ITAD Jobs', labelKey: 'itad.jobs.page.title', href: '/backend/itad/jobs' },
    { label: 'New ITAD job', labelKey: 'itad.jobs.create.title' },
  ],
}

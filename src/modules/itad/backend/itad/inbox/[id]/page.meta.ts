export const metadata = {
  requireAuth: true,
  requireFeatures: ['itad.inbox.view'],
  pageTitle: 'Inbox message',
  pageTitleKey: 'itad.inbox.messageTitle',
  pageGroup: 'ITAD',
  pageGroupKey: 'itad.nav.group',
  pageOrder: 9,
  navHidden: true,
  icon: 'inbox',
  breadcrumb: [
    { label: 'Inbox', labelKey: 'itad.inbox.title', href: '/backend/itad/inbox' },
    { label: 'Inbox message', labelKey: 'itad.inbox.messageTitle' },
  ],
}

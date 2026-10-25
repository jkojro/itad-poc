export const features = [
  { id: 'itad.jobs.view', title: 'View ITAD jobs', module: 'itad' },
  {
    id: 'itad.jobs.manage',
    title: 'Create, edit and delete draft ITAD jobs',
    module: 'itad',
    dependsOn: ['itad.jobs.view'],
  },
  {
    id: 'itad.jobs.transition',
    title: 'Change the status of ITAD jobs',
    module: 'itad',
    dependsOn: ['itad.jobs.view'],
  },
  {
    id: 'itad.jobs.confirm_conditions',
    title: 'Manually confirm ITAD job conditions',
    module: 'itad',
    dependsOn: ['itad.jobs.transition'],
  },
  {
    id: 'itad.manifest.view',
    title: 'View ITAD job manifests, including customer source data',
    module: 'itad',
    dependsOn: ['itad.jobs.view'],
  },
  {
    id: 'itad.manifest.manage',
    title: 'Import ITAD job manifests and remove manifest items',
    module: 'itad',
    dependsOn: ['itad.manifest.view'],
  },
  {
    id: 'itad.assets.view',
    title: 'View received ITAD assets and receiving scans',
    module: 'itad',
    dependsOn: ['itad.jobs.view'],
  },
  {
    id: 'itad.assets.receive',
    title: 'Scan ITAD assets at receiving, edit their details and resolve duplicate scans',
    module: 'itad',
    dependsOn: ['itad.assets.view'],
  },
  {
    id: 'itad.assets.manage',
    title: 'Remove (void) received ITAD assets',
    module: 'itad',
    dependsOn: ['itad.assets.view'],
  },
  {
    id: 'itad.sanitization.view',
    title: 'View ITAD sanitization runs, evidence and asset status history',
    module: 'itad',
    dependsOn: ['itad.assets.view'],
  },
  {
    id: 'itad.sanitization.execute',
    title: 'Start, finish and abort ITAD sanitization runs and attach evidence',
    module: 'itad',
    dependsOn: ['itad.sanitization.view'],
  },
  {
    id: 'itad.sanitization.manage',
    title: 'Approve ITAD sanitization retries and re-classify assets after receiving',
    module: 'itad',
    dependsOn: ['itad.sanitization.view'],
  },
  {
    id: 'itad.exceptions.view',
    title: 'View ITAD exceptions and their history',
    module: 'itad',
    dependsOn: ['itad.jobs.view'],
  },
  {
    id: 'itad.exceptions.manage',
    title: 'Assign and resolve ITAD exceptions (with the permissions of the underlying actions)',
    module: 'itad',
    dependsOn: ['itad.exceptions.view'],
  },
  {
    id: 'itad.certificates.view',
    title: 'View and download ITAD certificates of data sanitization',
    module: 'itad',
    dependsOn: ['itad.assets.view'],
  },
  {
    id: 'itad.certificates.issue',
    title: 'Issue ITAD certificates of data sanitization',
    module: 'itad',
    dependsOn: ['itad.certificates.view'],
  },
  {
    id: 'itad.certificates.manage',
    title: 'Reissue and void ITAD certificates of data sanitization',
    module: 'itad',
    dependsOn: ['itad.certificates.view'],
  },
  {
    id: 'itad.inbox.view',
    title: 'View customer emails and their ITAD proposals (Inbox)',
    module: 'itad',
  },
  {
    id: 'itad.inbox.manage',
    title: 'Import customer emails and decide their ITAD proposals (Inbox)',
    module: 'itad',
    dependsOn: ['itad.inbox.view'],
  },
]

export default features

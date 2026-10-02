export const features = [
  { id: 'itad.jobs.view', title: 'View ITAD jobs', module: 'itad' },
  {
    id: 'itad.jobs.manage',
    title: 'Create, edit and delete draft ITAD jobs',
    module: 'itad',
    dependsOn: ['itad.jobs.view'],
  },
]

export default features

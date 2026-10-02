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
]

export default features

import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'

export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    admin: ['itad.*'],
    employee: [
      'itad.jobs.view',
      'itad.jobs.manage',
      'itad.jobs.transition',
      'itad.manifest.view',
      'itad.manifest.manage',
    ],
  },
}

export default setup

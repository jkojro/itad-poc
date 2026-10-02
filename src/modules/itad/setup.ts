import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'

export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    admin: ['itad.*'],
    employee: ['itad.jobs.view', 'itad.jobs.manage'],
  },
}

export default setup

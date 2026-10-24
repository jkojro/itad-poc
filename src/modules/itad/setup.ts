import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
import { seedPickupActivityType } from './services/pickup-task-sync'

export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    admin: ['itad.*'],
    employee: [
      'itad.jobs.view',
      'itad.jobs.manage',
      'itad.jobs.transition',
      'itad.manifest.view',
      'itad.manifest.manage',
      'itad.assets.view',
      'itad.assets.receive',
      'itad.sanitization.view',
      'itad.exceptions.view',
      'itad.certificates.view',
      'itad.inbox.view',
    ],
  },
  async seedDefaults(ctx) {
    await seedPickupActivityType(ctx.container, { tenantId: ctx.tenantId, organizationId: ctx.organizationId })
  },
}

export default setup

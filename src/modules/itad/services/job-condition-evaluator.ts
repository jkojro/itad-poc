import type { EntityManager } from '@mikro-orm/postgresql'
import type { QueryEngine } from '@open-mercato/shared/lib/query/types'
import type { ConditionDeps } from '../domain/job-conditions'
import { isCompanyInScope } from '../module-integrations/customers'
import { loadReceivingFacts } from './reconciliation-reader'

/**
 * Builds the facts lookups the job conditions need (manifest spec "Architecture"):
 * customer validity through the customers integration, receiving facts from the
 * reconciliation reader. The transition command passes its locked transaction's
 * `EntityManager`, so the facts and the status change are consistent.
 */
export function buildConditionDeps(input: {
  em: EntityManager
  queryEngine: QueryEngine
  scope: { tenantId: string; organizationId: string }
}): ConditionDeps {
  const { em, queryEngine, scope } = input
  return {
    isCustomerValid: (customerId) => isCompanyInScope(queryEngine, scope, customerId),
    loadReceivingFacts: (jobId) => loadReceivingFacts(em, scope, jobId),
  }
}

import { describe, expect, it } from '@jest/globals'
import { ITAD_PAGE_CONTEXT_SOURCE, operationsDashboardContext, shouldRebindDock, type ItadPageContext } from '../ai-page-context'

const AGENT = 'itad.operations_assistant'
const asset: ItadPageContext = { source: ITAD_PAGE_CONTEXT_SOURCE, pageId: 'itad.asset', entityType: 'itad:itad_asset', recordId: 'a1' }

describe('operationsDashboardContext', () => {
  it('sends both entityType and recordId, which the framework needs to hydrate page context', () => {
    expect(operationsDashboardContext()).toEqual({
      source: ITAD_PAGE_CONTEXT_SOURCE,
      pageId: 'itad.operations',
      entityType: 'itad:operations_dashboard',
      recordId: 'operations',
    })
  })
})

describe('shouldRebindDock', () => {
  it('re-binds a page-assistant dock opened on another ITAD page (asset → dashboard)', () => {
    expect(shouldRebindDock({ agent: AGENT, pageContext: asset }, AGENT, operationsDashboardContext())).toBe(true)
    expect(shouldRebindDock({ agent: AGENT, pageContext: asset }, AGENT, { ...asset, recordId: 'a2' })).toBe(true)
  })

  it('leaves the same page, the launcher dock, other agents and an empty dock alone', () => {
    expect(shouldRebindDock({ agent: AGENT, pageContext: asset }, AGENT, asset)).toBe(false)
    expect(shouldRebindDock({ agent: AGENT, pageContext: {} }, AGENT, asset)).toBe(false)
    expect(shouldRebindDock({ agent: 'customers.account_assistant', pageContext: asset }, AGENT, operationsDashboardContext())).toBe(false)
    expect(shouldRebindDock(null, AGENT, asset)).toBe(false)
  })
})

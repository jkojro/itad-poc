import { describe, expect, it } from '@jest/globals'
import { decideLevel, findJobReferences, locateValue, resolveCustomerSender } from '../inbox-matching'
import { worstMatchStatus } from '../inbox'

/** ITAD Inbox Ops spec "Match", "Match status", "Forwarded mail". */
describe('inbox matching', () => {
  const parts = {
    currentText: 'Please move the pickup of ITAD-2026-00042 to Friday.',
    subject: 'Re: ITAD-2026-00042 and ITAD-2026-00007',
    history: ['On Monday you wrote about ITAD-2026-00099 and PO-7781'],
  }

  it('finds job references with the strongest source first: current text > subject > history', () => {
    expect(findJobReferences(parts)).toEqual([
      { reference: 'ITAD-2026-00042', source: 'current' },
      { reference: 'ITAD-2026-00007', source: 'subject' },
      { reference: 'ITAD-2026-00099', source: 'history' },
    ])
    expect(locateValue(parts, 'po-7781')).toBe('history')
    expect(locateValue(parts, 'ab')).toBeNull()
  })

  it('takes the forwarded sender as the customer only when an organization user forwarded the email', () => {
    const thread = [
      { from: 'ops@itad.example', fromName: 'Ops', body: 'FYI, see below', isForwarded: false },
      { from: 'anna@customer.example', fromName: 'Anna', body: 'The laptop was never shipped.', isForwarded: true },
      { from: 'old@customer.example', fromName: null, body: 'older message', isForwarded: false },
    ]
    const byOperator = resolveCustomerSender({
      envelope: { address: 'ops@itad.example', name: 'Ops' },
      currentText: 'FYI, see below',
      thread,
      envelopeIsOrganizationUser: true,
    })
    expect(byOperator).toMatchObject({
      customer: { address: 'anna@customer.example' },
      currentText: 'The laptop was never shipped.',
      forwardedByOrganizationUser: true,
    })
    expect(byOperator.history.map((entry) => entry.body)).toEqual(['older message'])

    const byOutsider = resolveCustomerSender({
      envelope: { address: 'someone@other.example', name: null },
      currentText: 'see below',
      thread,
      envelopeIsOrganizationUser: false,
    })
    expect(byOutsider).toMatchObject({
      customer: { address: 'someone@other.example' },
      currentText: 'see below',
      forwardedByOrganizationUser: false,
      forwardedSender: { address: 'anna@customer.example' },
    })
    // The forwarded message stays in the history, as evidence only.
    expect(byOutsider.history.some((entry) => entry.isForwarded)).toBe(true)
  })

  it('decides a level: explicit reference high, heuristic needs review, several ambiguous, explicit wins', () => {
    const explicit = { id: 'a', evidence: [{ kind: 'job_reference' as const, source: 'current' as const, value: 'ITAD-2026-00042' }] }
    const sender = { id: 'b', evidence: [{ kind: 'sender_email' as const, source: 'sender' as const, value: 'anna@x' }] }
    const history = { id: 'c', evidence: [{ kind: 'job_reference' as const, source: 'history' as const, value: 'ITAD-2026-00099' }] }
    expect(decideLevel([explicit])).toEqual({ id: 'a', status: 'high' })
    expect(decideLevel([sender])).toEqual({ id: 'b', status: 'needs_review' })
    expect(decideLevel([history])).toEqual({ id: 'c', status: 'needs_review' })
    expect(decideLevel([sender, history])).toEqual({ id: null, status: 'ambiguous' })
    expect(decideLevel([explicit, sender])).toEqual({ id: 'a', status: 'high' })
    expect(decideLevel([explicit, { ...explicit, id: 'd' }])).toEqual({ id: null, status: 'ambiguous' })
    expect(decideLevel([])).toEqual({ id: null, status: 'needs_review' })
  })

  it('takes the worst match status', () => {
    expect(worstMatchStatus(['high', 'ambiguous', 'needs_review'])).toBe('ambiguous')
    expect(worstMatchStatus(['high'])).toBe('high')
    expect(worstMatchStatus([])).toBe('needs_review')
  })
})

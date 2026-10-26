import { describe, expect, it } from '@jest/globals'
import { REPLY_CLAIM_WINDOW_MS, replySendState, replySubjectFor } from '../inbox'

describe('replySubjectFor', () => {
  it('prefixes Re: once', () => {
    expect(replySubjectFor('Status of ITAD-2026-00042')).toBe('Re: Status of ITAD-2026-00042')
    expect(replySubjectFor('Re: Status')).toBe('Re: Status')
    expect(replySubjectFor('RE:Status')).toBe('RE:Status')
  })

  it('keeps reply prefixes of other languages', () => {
    expect(replySubjectFor('Odp: Odbiór')).toBe('Odp: Odbiór')
    expect(replySubjectFor('AW: Abholung')).toBe('AW: Abholung')
  })

  it('handles an empty subject', () => {
    expect(replySubjectFor('   ')).toBe('Re:')
  })
})

describe('replySendState', () => {
  const now = new Date('2026-10-26T10:00:00Z')

  it('sent wins over any claim', () => {
    expect(replySendState(new Date('2026-10-26T09:00:00Z'), new Date('2026-10-26T09:59:00Z'), now)).toBe('sent')
  })

  it('a fresh claim is sending; an expired one is unconfirmed', () => {
    expect(replySendState(null, new Date(now.getTime() - 1000), now)).toBe('sending')
    expect(replySendState(null, new Date(now.getTime() - REPLY_CLAIM_WINDOW_MS), now)).toBe('unconfirmed')
  })

  it('no claim, no send', () => {
    expect(replySendState(null, null, now)).toBe('none')
  })
})

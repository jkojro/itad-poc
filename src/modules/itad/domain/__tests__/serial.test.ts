import { describe, expect, it } from '@jest/globals'
import { SERIAL_MAX_LENGTH, normalizeSerial, validateSerial } from '../serial'

describe('normalizeSerial (TEST-101)', () => {
  it.each([
    ['abc 123', 'ABC123'],
    ['ABC123', 'ABC123'],
    [' abc123 ', 'ABC123'],
    ['ab\tc\n12 3', 'ABC123'],
    ['abc 123', 'ABC123'],
    ['5cg-12 34x', '5CG-1234X'],
    ['ß-1', 'SS-1'],
  ])('%j → %j', (input, expected) => {
    expect(normalizeSerial(input)).toBe(expected)
  })
})

describe('validateSerial (TEST-101)', () => {
  it('keeps the trimmed input next to the normalized form', () => {
    expect(validateSerial('  abc 123 ')).toEqual({ ok: true, serial: 'abc 123', normalized: 'ABC123' })
  })

  it('rejects empty and whitespace-only values', () => {
    expect(validateSerial('')).toEqual({ ok: false, code: 'serial_missing' })
    expect(validateSerial('  \t')).toEqual({ ok: false, code: 'serial_missing' })
    expect(validateSerial(null)).toEqual({ ok: false, code: 'serial_missing' })
  })

  it('limits the normalized length', () => {
    expect(validateSerial('A'.repeat(SERIAL_MAX_LENGTH)).ok).toBe(true)
    expect(validateSerial('A'.repeat(SERIAL_MAX_LENGTH + 1))).toEqual({ ok: false, code: 'serial_too_long' })
    // Whitespace does not count: 100 characters plus spaces is still valid.
    expect(validateSerial(`${'A'.repeat(50)}   ${'B'.repeat(50)}`).ok).toBe(true)
  })
})

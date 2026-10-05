/**
 * Serial-number normalization: the single shared definition used by manifest import,
 * receiving scans, search and reconciliation. Pure.
 *
 * Normalized form = all whitespace removed (including internal and non-breaking
 * spaces), uppercased with a fixed locale. Dashes and other characters are kept, so
 * `abc 123`, `ABC123` and ` abc123 ` all become `ABC123`.
 */
export const SERIAL_MAX_LENGTH = 100

export type SerialValidation =
  | { ok: true; serial: string; normalized: string }
  | { ok: false; code: 'serial_missing' | 'serial_too_long' }

export function normalizeSerial(raw: string): string {
  return raw.replace(/\s+/gu, '').toLocaleUpperCase('en-US')
}

/** Validates a raw serial; `serial` is the trimmed input as typed or read from a file. */
export function validateSerial(raw: string | null | undefined): SerialValidation {
  const serial = (raw ?? '').trim()
  const normalized = normalizeSerial(serial)
  if (!normalized) return { ok: false, code: 'serial_missing' }
  if (normalized.length > SERIAL_MAX_LENGTH) return { ok: false, code: 'serial_too_long' }
  return { ok: true, serial, normalized }
}

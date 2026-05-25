// ─── Validation ──────────────────────────────────────────────────────────────
//
// Host ID and pairing code normalization + validation.
// Kept separate so both the CLI and API server can import without pulling
// in each other's dependencies.

/** Trims and uppercases a raw host ID string. */
export function normalizeTarget(input: string): string {
  return input.trim().toUpperCase();
}

/**
 * Normalizes a pairing code to uppercase XXXX-XXXX form.
 * Accepts codes with or without the hyphen separator.
 */
export function normalizeCode(input: string): string {
  const cleaned = input.trim().toUpperCase().replace(/\s+/g, '');
  if (cleaned.length === 8 && !cleaned.includes('-')) {
    return `${cleaned.slice(0, 4)}-${cleaned.slice(4, 8)}`;
  }
  return cleaned;
}

/** Host IDs must be exactly XXXX-XXXX hex (e.g. AB12-34CD). */
export function isValidTarget(id: string): boolean {
  return /^[0-9A-F]{4}-[0-9A-F]{4}$/.test(id);
}

/** Pairing codes must be exactly XXXX-XXXX alphanumeric (e.g. AB12-CD34). */
export function isValidCode(code: string): boolean {
  return /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code);
}
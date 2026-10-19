/**
 * Strict instant parsing shared by validation, rights expiry and run tracking.
 *
 * Accepts only RFC 3339 style timestamps with an explicit `Z` or `±HH:MM`
 * offset. Values without an offset are rejected because `Date` would interpret
 * them in the host's local time zone, making normalization machine-dependent.
 * Impossible calendar dates (e.g. Feb 30) are rejected instead of rolled over.
 */
const INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-](\d{2}):(\d{2}))$/;

export function parseInstant(value: string): Date | undefined {
  const m = INSTANT.exec(value);
  if (!m) return undefined;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const h = Number(m[4]), mi = Number(m[5]), s = Number(m[6] ?? '0');
  if (h > 23 || mi > 59 || s > 59) return undefined;
  if (m[7] !== 'Z' && (Number(m[8]) > 23 || Number(m[9]) > 59)) return undefined;
  const cal = new Date(Date.UTC(y, mo - 1, d));
  if (cal.getUTCFullYear() !== y || cal.getUTCMonth() !== mo - 1 || cal.getUTCDate() !== d) return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : undefined;
}

/** Returns the canonical UTC ISO string, or throws with the given label. */
export function toInstant(value: string, label: string): string {
  const parsed = parseInstant(value);
  if (!parsed) throw new Error(`Invalid timestamp ${label}`);
  return parsed.toISOString();
}

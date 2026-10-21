/**
 * Request hash for idempotent collection attempts (B-002 revision 2.1, section C).
 *
 * request_sha256 = SHA-256 of the canonical JSON of
 *   { adapterId, evidenceKind, networks (sorted), fixtureSha256 }
 * fixtureSha256  = SHA-256 of the canonical JSON array of raw rows IN INPUT ORDER
 *                  (order matters: row indices and first-row-kept semantics depend on it).
 *
 * Canonical JSON: object keys sorted by code point, no whitespace, every string (keys too)
 * NFC-normalized. Computed in memory before T1 from data the caller already holds; it never
 * reads a source and nothing here is stored except the resulting hex digests.
 */
import { createHash } from 'node:crypto';

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export function canonicalJson(value: Json): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value.normalize('NFC'));
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value).map(([k, v]) => [k.normalize('NFC'), v] as const);
    const keys = entries.map(([k]) => k);
    if (new Set(keys).size !== keys.length) throw new TypeError('canonicalJson: keys collide after NFC normalization');
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  throw new TypeError(`canonicalJson: unsupported value ${typeof value}`);
}

const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

export function fixtureSha256(rows: Json[]): string {
  if (!Array.isArray(rows)) throw new TypeError('fixtureSha256: rows must be an array');
  return sha256Hex(canonicalJson(rows));
}

export function requestSha256(req: { adapterId: string; evidenceKind: string; networks: string[]; fixtureSha256: string }): string {
  if (!/^[0-9a-f]{64}$/.test(req.fixtureSha256)) throw new TypeError('requestSha256: fixtureSha256 must be 64 hex characters');
  const networks = [...req.networks].sort();
  if (new Set(networks).size !== networks.length) throw new TypeError('requestSha256: duplicate network');
  return sha256Hex(canonicalJson({ adapterId: req.adapterId, evidenceKind: req.evidenceKind, networks, fixtureSha256: req.fixtureSha256 }));
}

/**
 * Internal evidence retrieval (migration 0008). Internal synthetic evaluation only: no HTTP endpoint,
 * no export, no customer display. The caller's session must be a dedicated reader principal
 * (si_reader_<name>) with an active grant for the source; the database decides everything else.
 *
 * Returned records are given to the caller and are never logged here; failures are a fixed code plus
 * the SQLSTATE, never PostgreSQL text. Destination and creative URLs are not part of the interface.
 */
import type { ClientBase } from 'pg';

export const MAX_READ_RECORDS = 100;
export const DEFAULT_READ_RECORDS = 50;
export const MAX_READ_BYTES = 262144;

export interface EvidenceRecord {
  runId: string;
  ordinal: number;
  collectedAt: string;
  network: string;
  nativeAdId: string;
  advertiserName: string;
  countries: string[];
  seenAt: string;
  sourceUrl: string;
  title: string | null;
  sourceReportedFirstSeen: string | null;
  sourceReportedLastSeen: string | null;
  contentSha256: string;
}
export interface EvidencePage { records: EvidenceRecord[]; nextCursor: string | null }

export type ReadFailureCode = 'BAD_ARGUMENT' | 'BAD_CURSOR' | 'NOT_AUTHORIZED' | 'UNSAFE_SESSION' | 'BUSY' | 'ISOLATION' |
  'CONNECTION' | 'INTERNAL';

/** Fixed message only: `READ_FAILED: <code>`. */
export class ReadFailed extends Error {
  constructor(readonly code: ReadFailureCode, readonly sqlstate: string | null) {
    super(`READ_FAILED: ${code}`);
    this.name = 'ReadFailed';
  }
}

function sqlstateOf(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : null;
}
function messageCode(err: unknown): string {
  const m = (err as { message?: unknown } | null)?.message;
  return typeof m === 'string' ? (m.match(/^(SI_[A-Z_]+):/)?.[1] ?? '') : '';
}

export function classifyReadError(err: unknown): ReadFailureCode {
  const s = sqlstateOf(err), m = messageCode(err);
  if (m === 'SI_READ_BAD_CURSOR') return 'BAD_CURSOR';
  if (m === 'SI_READ_BAD_ARGUMENT') return 'BAD_ARGUMENT';
  if (m === 'SI_READ_UNSAFE_SESSION') return 'UNSAFE_SESSION';
  if (m === 'SI_READ_BUSY' || s === '55P03') return 'BUSY';
  if (m === 'SI_ISOLATION' || s === '25000') return 'ISOLATION';
  if (m === 'SI_READ_NOT_AUTHORIZED' || s === '42501') return 'NOT_AUTHORIZED';
  if (s === null || s.startsWith('08') || s.startsWith('57P')) return 'CONNECTION';
  return 'INTERNAL';
}

const SOURCE_ID = /^[a-z0-9][a-z0-9-]{1,62}$/;
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : null);

/**
 * One bounded page (at most `limit` records and MAX_READ_BYTES) in its own statement. Pass the
 * returned nextCursor to continue; an empty page (nextCursor null) means nothing more is readable now.
 */
export async function readEvidence(client: ClientBase, sourceId: string,
  opts: { cursor?: string | null; limit?: number } = {}): Promise<EvidencePage> {
  const limit = opts.limit ?? DEFAULT_READ_RECORDS;
  if (typeof sourceId !== 'string' || !SOURCE_ID.test(sourceId) || !Number.isInteger(limit) || limit < 1 || limit > MAX_READ_RECORDS) {
    throw new ReadFailed('BAD_ARGUMENT', null);
  }
  const cursor = opts.cursor ?? null;
  if (cursor !== null && (typeof cursor !== 'string' || cursor.length > 160)) throw new ReadFailed('BAD_CURSOR', null);
  let rows: Record<string, unknown>[];
  try {
    rows = (await client.query('SELECT * FROM si.si_read_evidence($1, $2, $3::int)', [sourceId, cursor, limit])).rows;
  } catch (err) {
    throw new ReadFailed(classifyReadError(err), sqlstateOf(err));
  }
  const records = rows.map(r => ({
    runId: String(r.run_id), ordinal: Number(r.ordinal), collectedAt: iso(r.collected_at) ?? '', network: String(r.network),
    nativeAdId: String(r.native_ad_id), advertiserName: String(r.advertiser_name), countries: (r.countries as string[]) ?? [],
    seenAt: iso(r.seen_at) ?? '', sourceUrl: String(r.source_url), title: r.title === null ? null : String(r.title),
    sourceReportedFirstSeen: iso(r.source_reported_first_seen), sourceReportedLastSeen: iso(r.source_reported_last_seen),
    contentSha256: String(r.content_sha256)
  }));
  const last = rows.length > 0 ? rows[rows.length - 1]?.next_cursor : null;
  // A page can be short because of the byte cap, so the end is an empty page, not a short one.
  return { records, nextCursor: typeof last === 'string' ? last : null };
}

/** si_rights_admin: grant one reader principal internal access to one source. */
export async function grantReader(client: ClientBase, principal: string, sourceId: string, reason: string): Promise<number> {
  return Number((await client.query('SELECT si.si_grant_reader($1, $2, $3) AS id', [principal, sourceId, reason])).rows[0].id);
}

/** si_rights_admin: revoke it (final; a new grant can be made afterwards). */
export async function revokeReader(client: ClientBase, principal: string, sourceId: string, reason: string): Promise<number> {
  return Number((await client.query('SELECT si.si_revoke_reader($1, $2, $3) AS id', [principal, sourceId, reason])).rows[0].id);
}

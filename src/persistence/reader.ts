/**
 * Internal evidence retrieval (migrations 0008 and 0009). Internal synthetic evaluation only: no HTTP
 * endpoint, no export, no customer display. The caller's session must be a dedicated reader principal
 * (si_reader_<name>) with an active grant for the source; the database decides everything else.
 *
 * Every read is two statements (M3-AUD-01, migration 0009):
 *   1. beginRead records a read intent for this login and the exact scope (source, cursor, limit). It
 *      must COMMIT on its own, so call it on a client that is not inside a transaction. If it fails, or
 *      its outcome is unknown (connection lost), nothing is read.
 *   2. The read returns evidence only for a committed, open, unexpired intent of the same login and
 *      scope, re-checks every authorization, and consumes the intent.
 * Since migration 0010 the read also waits (at most 1 s) until the intent's commit is flushed to disk, and
 * otherwise fails with INTENT_NOT_DURABLE. That can also happen to an ordinary read when another session
 * inserted WAL that nothing has flushed yet; a new intent's synchronous commit flushes it, so readEvidence
 * starts a new read (at most NOT_DURABLE_ATTEMPTS in total) when it created the intent itself. Every attempt
 * leaves its own committed request record.
 * A committed intent proves an authorized request (REQUEST AUDIT). It is not a disclosure audit: releases
 * are not recorded rollback-resistantly, and delivery and exactly-once delivery are not guaranteed.
 * Retry: after BUSY or CONNECTION the same intent may be retried (same scope) until it expires or is
 * consumed (`retryable`); after INTENT_USED, INTENT_EXPIRED or INTENT_NOT_DURABLE a new read is needed;
 * NOT_AUTHORIZED is final.
 *
 * Returned records are given to the caller and are never logged here; failures are a fixed code plus
 * the SQLSTATE, never PostgreSQL text. Destination and creative URLs are not part of the interface.
 */
import type { ClientBase } from 'pg';

export const MAX_READ_RECORDS = 100;
export const DEFAULT_READ_RECORDS = 50;
export const MAX_READ_BYTES = 262144;
/** Total attempts (each with a new intent) when a read the library started is refused INTENT_NOT_DURABLE. */
export const NOT_DURABLE_ATTEMPTS = 3;

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
  'INTENT_INVALID' | 'INTENT_UNCOMMITTED' | 'INTENT_USED' | 'INTENT_EXPIRED' | 'INTENT_NOT_DURABLE' | 'CONNECTION' | 'INTERNAL';

/** Fixed message only: `READ_FAILED: <code>`. `intentId` is set when a committed intent exists for the failed read. */
export class ReadFailed extends Error {
  constructor(readonly code: ReadFailureCode, readonly sqlstate: string | null, readonly intentId: string | null = null) {
    super(`READ_FAILED: ${code}`);
    this.name = 'ReadFailed';
  }
  /** True when the same intent may be retried for the same scope (until it expires or is consumed). */
  get retryable(): boolean { return this.intentId !== null && (this.code === 'BUSY' || this.code === 'CONNECTION'); }
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
  if (m === 'SI_READ_INTENT_INVALID') return 'INTENT_INVALID';
  if (m === 'SI_READ_INTENT_UNCOMMITTED') return 'INTENT_UNCOMMITTED';
  if (m === 'SI_READ_INTENT_USED') return 'INTENT_USED';
  if (m === 'SI_READ_INTENT_EXPIRED') return 'INTENT_EXPIRED';
  if (m === 'SI_READ_INTENT_NOT_DURABLE') return 'INTENT_NOT_DURABLE';
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ReadScope { cursor?: string | null; limit?: number }
function scopeOf(sourceId: string, opts: ReadScope): { cursor: string | null; limit: number } {
  const limit = opts.limit ?? DEFAULT_READ_RECORDS;
  if (typeof sourceId !== 'string' || !SOURCE_ID.test(sourceId) || !Number.isInteger(limit) || limit < 1 || limit > MAX_READ_RECORDS) {
    throw new ReadFailed('BAD_ARGUMENT', null);
  }
  const cursor = opts.cursor ?? null;
  if (cursor !== null && (typeof cursor !== 'string' || cursor.length > 160)) throw new ReadFailed('BAD_CURSOR', null);
  return { cursor, limit };
}

/**
 * Step 1: record a read intent for exactly this scope and return its id. It is usable only after this
 * statement commits, so the client must not be inside a transaction (an intent created inside one is
 * refused by the read as INTENT_UNCOMMITTED). Throws ReadFailed; on any failure nothing may be read.
 */
export async function beginRead(client: ClientBase, sourceId: string, opts: ReadScope = {}): Promise<string> {
  const { cursor, limit } = scopeOf(sourceId, opts);
  let id: unknown;
  try {
    id = (await client.query('SELECT si.si_begin_read($1, $2, $3::int) AS id', [sourceId, cursor, limit])).rows[0]?.id;
  } catch (err) {
    throw new ReadFailed(classifyReadError(err), sqlstateOf(err));
  }
  if (typeof id !== 'string' || !UUID.test(id)) throw new ReadFailed('INTERNAL', null);
  return id;
}

/**
 * One bounded page (at most `limit` records and MAX_READ_BYTES). Without `intentId` it first records a
 * committed intent (beginRead); with `intentId` it retries that intent, which must match the scope.
 * Pass the returned nextCursor to continue; an empty page (nextCursor null) means nothing more is
 * readable now.
 */
export async function readEvidence(client: ClientBase, sourceId: string,
  opts: ReadScope & { intentId?: string } = {}): Promise<EvidencePage & { intentId: string }> {
  const { cursor, limit } = scopeOf(sourceId, opts);
  if (opts.intentId !== undefined && (typeof opts.intentId !== 'string' || !UUID.test(opts.intentId))) {
    throw new ReadFailed('INTENT_INVALID', null);
  }
  let intentId: string;
  let rows: Record<string, unknown>[];
  for (let attempt = 1; ; attempt++) {
    intentId = opts.intentId ?? await beginRead(client, sourceId, { cursor, limit });
    try {
      rows = (await client.query('SELECT * FROM si.si_read_evidence($1, $2::uuid, $3, $4::int)', [sourceId, intentId, cursor, limit])).rows;
      break;
    } catch (err) {
      const failure = new ReadFailed(classifyReadError(err), sqlstateOf(err), intentId);
      if (failure.code === 'INTENT_NOT_DURABLE' && opts.intentId === undefined && attempt < NOT_DURABLE_ATTEMPTS) continue;
      throw failure;
    }
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
  return { records, nextCursor: typeof last === 'string' ? last : null, intentId };
}

/** si_rights_admin: grant one reader principal internal access to one source. */
export async function grantReader(client: ClientBase, principal: string, sourceId: string, reason: string): Promise<number> {
  return Number((await client.query('SELECT si.si_grant_reader($1, $2, $3) AS id', [principal, sourceId, reason])).rows[0].id);
}

/** si_rights_admin: revoke it (final; a new grant can be made afterwards). */
export async function revokeReader(client: ClientBase, principal: string, sourceId: string, reason: string): Promise<number> {
  return Number((await client.query('SELECT si.si_revoke_reader($1, $2, $3) AS id', [principal, sourceId, reason])).rows[0].id);
}

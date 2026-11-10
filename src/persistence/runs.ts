/**
 * T1 preflight (B-002 Milestone 2, step 2): one READ COMMITTED transaction around the
 * SECURITY DEFINER si.si_begin_run(). The database applies the whole decision table under
 * the request-key lock; this module only maps outcomes to typed results and errors.
 *
 * Step 3 adds token-checked heartbeat, T3 failure with coded error records, and the
 * independent expired-run reaper. Step 4 adds the T2 protocol for EMPTY runs (completeRun).
 * Milestone 3 part 1 adds the scoped T1 (t1PreflightScoped): the database verifies the v1 request
 * hash and records the request scope a later non-empty completion will be checked against.
 * Milestone 3 part 2B adds completeRunWithEvidence: bounded, synthetic-only evidence persistence.
 */
import { randomUUID } from 'node:crypto';
import type { ClientBase } from 'pg';
import { checkCollectorLogging } from './preconditions.js';

export interface T1Request {
  sourceId: string;
  requestKey: string;
  requestSha256: string;
  evidenceKind: string;
  networks: string[];
}

export interface T1Result {
  outcome: 'RUNNING' | 'REJECTED' | 'ALREADY_COMPLETED';
  runId: string;
  attempt: number;
  status: string;
  outcomeCode: string | null;
  rightsVersionId: string | null;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
  startControlSeq: number;
  retentionState: string;
}

export type T1ErrorCode =
  | 'IDEMPOTENCY_KEY_REUSED' | 'RUN_IN_PROGRESS' | 'ATTEMPT_LIMIT_EXCEEDED' | 'SOURCE_SUSPENDED'
  | 'UNKNOWN_SOURCE' | 'BAD_ARGUMENT' | 'ISOLATION' | 'REQUEST_HASH_MISMATCH';

/** A thrown T1 outcome: nothing was stored (2.1 failure-state table, Q3). */
export class T1Refused extends Error {
  constructor(readonly code: T1ErrorCode, message: string, readonly sqlstate?: string) {
    super(message);
    this.name = 'T1Refused';
  }
}

const PREFIX: Record<string, T1ErrorCode> = {
  SI_IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  SI_RUN_IN_PROGRESS: 'RUN_IN_PROGRESS',
  SI_ATTEMPT_LIMIT: 'ATTEMPT_LIMIT_EXCEEDED',
  SI_SOURCE_SUSPENDED: 'SOURCE_SUSPENDED',
  SI_UNKNOWN_SOURCE: 'UNKNOWN_SOURCE',
  SI_BAD_ARGUMENT: 'BAD_ARGUMENT',
  SI_ISOLATION: 'ISOLATION',
  SI_REQUEST_HASH_MISMATCH: 'REQUEST_HASH_MISMATCH'
};

function mapError(err: unknown): unknown {
  const e = err as { message?: string; code?: string };
  const prefix = /^(SI_[A-Z_]+):/.exec(e?.message ?? '')?.[1];
  const code = prefix ? PREFIX[prefix] : undefined;
  return code ? new T1Refused(code, e.message ?? code, e.code) : err;
}

async function runT1(client: ClientBase, sql: string, params: unknown[]): Promise<T1Result> {
  await client.query('BEGIN');
  try {
    const res = await client.query(sql, params);
    await client.query('COMMIT');
    const r = res.rows[0];
    return {
      outcome: r.outcome, runId: r.run_id, attempt: r.attempt, status: r.status, outcomeCode: r.outcome_code,
      rightsVersionId: r.rights_version_id, leaseToken: r.lease_token, leaseExpiresAt: r.lease_expires_at,
      startControlSeq: r.start_control_seq, retentionState: r.retention_state
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection may be gone */ }
    throw mapError(err);
  }
}

export async function t1Preflight(client: ClientBase, req: T1Request): Promise<T1Result> {
  return runT1(client, 'SELECT * FROM si.si_begin_run($1, $2, $3, $4, $5::text[])',
    [req.sourceId, req.requestKey, req.requestSha256, req.evidenceKind, req.networks]);
}

/** A scoped T1 request: `fixtureSha256` is the v1 fixture hash the request hash was computed from. */
export interface ScopedT1Request extends T1Request {
  fixtureSha256: string;
}

/**
 * Scoped T1 (B-002 Milestone 3, FD7 option C): the same one-transaction protocol around
 * si.si_begin_run_scoped. The database refuses with REQUEST_HASH_MISMATCH, before T1 and without
 * consuming an attempt, unless requestSha256 is the v1 hash of (sourceId, evidenceKind, networks,
 * fixtureSha256); a RUNNING attempt then carries exactly this network set as its request scope.
 */
export async function t1PreflightScoped(client: ClientBase, req: ScopedT1Request): Promise<T1Result> {
  return runT1(client, 'SELECT * FROM si.si_begin_run_scoped($1, $2, $3, $4, $5::text[], $6)',
    [req.sourceId, req.requestKey, req.requestSha256, req.evidenceKind, req.networks, req.fixtureSha256]);
}

/** Returns false when the run is absent, terminal, expired or the lease token is stale. */
export async function heartbeatRun(client: ClientBase, runId: string, leaseToken: string): Promise<boolean> {
  const r = await client.query('SELECT si.si_heartbeat_run($1::uuid, $2::uuid) AS accepted', [runId, leaseToken]);
  return r.rows[0]?.accepted === true;
}

/** One stored error: a code, an optional input row index and an optional field name (no free text). */
export interface RunError {
  code: string;
  rowIndex: number | null;
  field: string | null;
}

/** Errors observed by a failed attempt: the total, and at most the first 100 records. */
export interface RunErrors {
  errorCount: number;
  records: RunError[];
  correlationId: string;
}

/**
 * Fail a matching RUNNING attempt without permitting free-text failure details. The status
 * change and the error records commit together; records.length must equal min(errorCount, 100).
 */
export async function failRun(
  client: ClientBase, runId: string, leaseToken: string,
  code: 'SOURCE_ERROR' | 'VALIDATION_FAILED' | 'DUPLICATE_CONFLICT' | 'LEASE_EXPIRED'
    | 'RIGHTS_TERMINATED' | 'SOURCE_SUSPENDED' | 'SOURCE_RETIRED' | 'RIGHTS_CHANGED'
    | 'RIGHTS_EXPIRING' | 'LOCK_TIMEOUT' | 'PERSISTENCE_ERROR' | 'INTERNAL',
  errors?: RunErrors
): Promise<boolean> {
  const recs = errors?.records ?? [];
  const r = await client.query(
    'SELECT si.si_fail_run($1::uuid, $2::uuid, $3::text, $4::int, $5::text[], $6::int[], $7::text[], $8::uuid) AS accepted',
    [runId, leaseToken, code, errors?.errorCount ?? 0, recs.map(e => e.code), recs.map(e => e.rowIndex),
     recs.map(e => e.field), errors?.correlationId ?? null]);
  return r.rows[0]?.accepted === true;
}

/** Independent reaper: fails up to `limit` RUNNING attempts whose lease has expired. No lease token needed. */
export async function reapExpiredRuns(client: ClientBase, limit = 100): Promise<number> {
  const r = await client.query('SELECT si.si_reap_expired_runs($1::int) AS reaped', [limit]);
  return r.rows[0].reaped;
}

/** T2 failure codes, in the order the database decides them (plan section 3.3). */
export type T2FailureCode =
  | 'LEASE_EXPIRED' | 'RIGHTS_TERMINATED' | 'SOURCE_SUSPENDED' | 'SOURCE_RETIRED' | 'RIGHTS_CHANGED'
  | 'RIGHTS_EXPIRING' | 'VALIDATION_FAILED' | 'DUPLICATE_CONFLICT' | 'LOCK_TIMEOUT' | 'PERSISTENCE_ERROR';

export type T2Result =
  | { outcome: 'COMPLETED'; runId: string; publishControlSeq: number; finishedAt: Date }
  /** Rolled back; failRecorded tells whether T3 then marked the attempt FAILED with this code. */
  | { outcome: 'FAILED'; code: T2FailureCode; failRecorded: boolean }
  /** The caller does not hold a RUNNING attempt with this lease (stale token, finished or unknown run). */
  | { outcome: 'NOT_OWNER' };

/** A caller error refused before any write (bad arguments, wrong isolation). No T3 is attempted. */
export class T2Refused extends Error {
  constructor(readonly code: 'BAD_ARGUMENT' | 'ISOLATION' | 'UNSAFE_LOGGING' | 'UNSAFE_PAYLOAD', message: string,
              readonly sqlstate?: string) {
    super(message);
    this.name = 'T2Refused';
  }
}

const T2_CODES = new Set<T2FailureCode>(['LEASE_EXPIRED', 'RIGHTS_TERMINATED', 'SOURCE_SUSPENDED', 'SOURCE_RETIRED',
  'RIGHTS_CHANGED', 'RIGHTS_EXPIRING', 'VALIDATION_FAILED', 'DUPLICATE_CONFLICT', 'LOCK_TIMEOUT', 'PERSISTENCE_ERROR']);

/**
 * T2 (controlled protocol, D2'): sends exactly BEGIN, SELECT si.si_complete_run(...), COMMIT.
 * Completes EMPTY runs only: the payload is always the empty array and the database derives every
 * count (migration 0004; non-empty completion is not enabled). A scoped run bound to a non-empty
 * fixture is refused as VALIDATION_FAILED. Any error, including one raised by the commit-time
 * publication check, is followed by ROLLBACK and then T3 with the mapped code.
 */
export async function completeRun(client: ClientBase, runId: string, leaseToken: string): Promise<T2Result> {
  await client.query('BEGIN');
  try {
    const res = await client.query("SELECT * FROM si.si_complete_run($1::uuid, $2::uuid, '[]'::jsonb)", [runId, leaseToken]);
    await client.query('COMMIT');
    const r = res.rows[0];
    return { outcome: 'COMPLETED', runId: r.run_id, publishControlSeq: r.publish_control_seq, finishedAt: r.finished_at };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection may be gone */ }
    const e = err as { message?: string; code?: string };
    const prefix = /^SI_([A-Z0-9_]+):/.exec(e?.message ?? '')?.[1];
    if (prefix === 'BAD_ARGUMENT' || prefix === 'ISOLATION') throw new T2Refused(prefix, e.message ?? prefix, e.code);
    if (prefix === 'T2_NOT_OWNER') return { outcome: 'NOT_OWNER' };
    const named = prefix?.startsWith('T2_') ? prefix.slice(3) as T2FailureCode : undefined;
    const code: T2FailureCode = named && T2_CODES.has(named) ? named : e?.code === '55P03' ? 'LOCK_TIMEOUT' : 'PERSISTENCE_ERROR';
    let failRecorded = false;
    try { failRecorded = await failRun(client, runId, leaseToken, code); } catch { /* the reaper will expire it */ }
    return { outcome: 'FAILED', code, failRecorded };
  }
}

// ---------------------------------------------------------------------------------------------
// Milestone 3 part 2B: non-empty evidence completion.
// ---------------------------------------------------------------------------------------------

/** Bounds enforced before transmission (the database enforces them again, on the jsonb text form). */
export const MAX_EVIDENCE_ROWS = 500;
export const MAX_EVIDENCE_BYTES = 1048576;

const EVIDENCE_FIELDS = new Set(['network', 'nativeAdId', 'advertiserName', 'countries', 'seenAt', 'sourceUrl', 'title',
  'destinationUrl', 'creativeUrl', 'sourceReportedFirstSeen', 'sourceReportedLastSeen']);

/** Coded diagnostics of a refused payload: codes, row indices and field names only. */
export interface T2Diagnostics {
  errorCount: number;
  records: RunError[];
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/**
 * Strict parser for the database's diagnostics DETAIL. Accepts exactly
 * {"v":1,"n":N,"e":[{"c":CODE,"r":row|null,"f":field|null} x min(N,100)]} with known field names
 * and in-range row indices; anything else returns null (fail closed: no records are trusted).
 */
export function parseT2Diagnostics(detail: unknown, rowCount: number): T2Diagnostics | null {
  if (typeof detail !== 'string' || detail.length > 8192) return null;
  let d: unknown;
  try { d = JSON.parse(detail); } catch { return null; }
  if (!isPlainObject(d) || Object.keys(d).sort().join(',') !== 'e,n,v') return null;
  const { v, n, e } = d;
  if (v !== 1 || typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 1_000_000) return null;
  if (!Array.isArray(e) || e.length !== Math.min(n, 100)) return null;
  const records: RunError[] = [];
  for (const x of e) {
    if (!isPlainObject(x) || Object.keys(x).sort().join(',') !== 'c,f,r') return null;
    const { c, r, f } = x;
    if (typeof c !== 'string' || !/^[A-Z][A-Z_]{2,40}$/.test(c)) return null;
    if (!(r === null || (typeof r === 'number' && Number.isInteger(r) && r >= 0 && r < rowCount))) return null;
    if (!(f === null || (typeof f === 'string' && EVIDENCE_FIELDS.has(f)))) return null;
    records.push({ code: c, rowIndex: r, field: f });
  }
  return { errorCount: n, records };
}

// A NUL or an unpaired surrogate makes PostgreSQL's JSON input fail with an error that quotes
// the input, so such payloads are refused before transmission.
const UNSAFE_TEXT = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
function payloadSafe(v: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (typeof v === 'string') return !UNSAFE_TEXT.test(v);
  if (v === null || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.every(x => payloadSafe(x, depth + 1));
  if (isPlainObject(v)) return Object.entries(v).every(([k, x]) => !UNSAFE_TEXT.test(k) && payloadSafe(x, depth + 1));
  return false;                                           // undefined, functions, class instances
}

export type T2EvidenceResult =
  | { outcome: 'COMPLETED'; runId: string; publishControlSeq: number; finishedAt: Date; retentionState: string;
      counts: { received: number; published: number; duplicate: number; conflict: number } }
  /** Rolled back; T3 then recorded the code and, when the diagnostics parsed strictly, the coded errors. */
  | { outcome: 'FAILED'; code: T2FailureCode; failRecorded: boolean; diagnostics: T2Diagnostics | null }
  | { outcome: 'NOT_OWNER' };

const REFUSAL: Record<string, string> = {
  BAD_ARGUMENT: 'the evidence payload is outside the accepted bounds',
  ISOLATION: 'collection runs require READ COMMITTED',
  UNSAFE_LOGGING: 'this collector session could log evidence parameters'
};

/**
 * T2 with an evidence payload (synthetic sources only). Before anything is sent: row and byte
 * bounds, NUL / malformed-Unicode / non-JSON values, and collector logging safety in this very
 * session (D7). Then exactly BEGIN, SELECT si.si_complete_run(run, token, rows), COMMIT; on error
 * ROLLBACK and T3. Never returns or throws PostgreSQL error text: results carry codes only.
 */
export async function completeRunWithEvidence(
  client: ClientBase, runId: string, leaseToken: string, rows: unknown[]
): Promise<T2EvidenceResult> {
  if (!Array.isArray(rows)) throw new T2Refused('BAD_ARGUMENT', 'evidence rows must be an array');
  if (rows.length > MAX_EVIDENCE_ROWS) throw new T2Refused('BAD_ARGUMENT', REFUSAL.BAD_ARGUMENT as string);
  if (!payloadSafe(rows)) throw new T2Refused('UNSAFE_PAYLOAD', 'the evidence payload contains NUL, malformed Unicode or non-JSON values');
  const body = JSON.stringify(rows);
  if (Buffer.byteLength(body, 'utf8') > MAX_EVIDENCE_BYTES) throw new T2Refused('BAD_ARGUMENT', REFUSAL.BAD_ARGUMENT as string);
  if (rows.length > 0) {
    const unsafe = (await checkCollectorLogging(client)).filter(p => !p.ok).map(p => p.name);
    if (unsafe.length > 0) throw new T2Refused('UNSAFE_LOGGING', `${REFUSAL.UNSAFE_LOGGING}: ${unsafe.join(', ')}`);
  }
  await client.query('BEGIN');
  try {
    const res = await client.query('SELECT * FROM si.si_complete_run($1::uuid, $2::uuid, $3::jsonb)', [runId, leaseToken, body]);
    await client.query('COMMIT');
    const r = res.rows[0];
    return { outcome: 'COMPLETED', runId: r.run_id, publishControlSeq: r.publish_control_seq, finishedAt: r.finished_at,
             retentionState: r.retention_state,
             counts: { received: r.received_count, published: r.published_count, duplicate: r.duplicate_count, conflict: r.conflict_count } };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection may be gone */ }
    const e = err as { message?: string; code?: string; detail?: unknown };
    const prefix = /^SI_([A-Z0-9_]+):/.exec(typeof e?.message === 'string' ? e.message : '')?.[1];
    if (prefix === 'BAD_ARGUMENT' || prefix === 'ISOLATION' || prefix === 'UNSAFE_LOGGING') {
      throw new T2Refused(prefix, REFUSAL[prefix] as string, e.code);
    }
    if (prefix === 'T2_NOT_OWNER') return { outcome: 'NOT_OWNER' };
    const named = prefix?.startsWith('T2_') ? prefix.slice(3) as T2FailureCode : undefined;
    const code: T2FailureCode = named && T2_CODES.has(named) ? named : e?.code === '55P03' ? 'LOCK_TIMEOUT' : 'PERSISTENCE_ERROR';
    const diagnostics = code === 'VALIDATION_FAILED' || code === 'DUPLICATE_CONFLICT' ? parseT2Diagnostics(e.detail, rows.length) : null;
    let failRecorded = false;
    try {
      failRecorded = await failRun(client, runId, leaseToken, code,
        diagnostics ? { errorCount: diagnostics.errorCount, records: diagnostics.records, correlationId: randomUUID() } : undefined);
    } catch {
      try { failRecorded = await failRun(client, runId, leaseToken, code); } catch { /* the reaper will expire it */ }
    }
    return { outcome: 'FAILED', code, failRecorded, diagnostics };
  }
}

/**
 * T1 preflight (B-002 Milestone 2, step 2): one READ COMMITTED transaction around the
 * SECURITY DEFINER si.si_begin_run(). The database applies the whole decision table under
 * the request-key lock; this module only maps outcomes to typed results and errors.
 *
 * Step 3 adds token-checked heartbeat, T3 failure with coded error records, and the
 * independent expired-run reaper. T2 publication is not implemented yet.
 */
import type { ClientBase } from 'pg';

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
  | 'UNKNOWN_SOURCE' | 'BAD_ARGUMENT' | 'ISOLATION';

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
  SI_ISOLATION: 'ISOLATION'
};

function mapError(err: unknown): unknown {
  const e = err as { message?: string; code?: string };
  const prefix = /^(SI_[A-Z_]+):/.exec(e?.message ?? '')?.[1];
  const code = prefix ? PREFIX[prefix] : undefined;
  return code ? new T1Refused(code, e.message ?? code, e.code) : err;
}

export async function t1Preflight(client: ClientBase, req: T1Request): Promise<T1Result> {
  await client.query('BEGIN');
  try {
    const res = await client.query(
      'SELECT * FROM si.si_begin_run($1, $2, $3, $4, $5::text[])',
      [req.sourceId, req.requestKey, req.requestSha256, req.evidenceKind, req.networks]
    );
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

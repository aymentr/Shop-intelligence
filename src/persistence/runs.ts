/**
 * T1 preflight (B-002 Milestone 2, step 2): one READ COMMITTED transaction around the
 * SECURITY DEFINER si.si_begin_run(). The database applies the whole decision table under
 * the request-key lock; this module only maps outcomes to typed results and errors.
 *
 * Not in this step: heartbeat, T3, reaper (step 3) and T2 publication (step 4).
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

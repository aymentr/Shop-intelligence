/**
 * Receipt verification (migration 0007). Deterministic and content-free: results are codes, times and
 * counts; failures are a fixed code plus the five-character SQLSTATE, never PostgreSQL text.
 * Every function needs an si_monitor session. Nothing here schedules itself, and nothing reads evidence.
 * A VALID verdict is necessary for a future read path, never sufficient (si_evidence_readable).
 */
import type { ClientBase } from 'pg';
import { classifyRetentionError } from './retention.js';

export const MAX_VERIFY_RUNS = 500;
export const DEFAULT_VERIFY_RUNS = 100;

export type VerifyOutcome = 'VERIFIED' | 'NOTHING_PENDING';
export interface VerifyResult { outcome: VerifyOutcome; verified: number; valid: number; invalid: number; unverifiable: number }

export type VerificationFailureCode =
  'BAD_ARGUMENT' | 'LOCK_TIMEOUT' | 'STATEMENT_TIMEOUT' | 'ISOLATION' | 'INTEGRITY' | 'PRIVILEGE' | 'COMMIT_TS_DISABLED' |
  'CONNECTION' | 'INTERNAL';

/** Fixed message only: `VERIFICATION_FAILED: <code>`. */
export class VerificationFailed extends Error {
  constructor(readonly code: VerificationFailureCode, readonly sqlstate: string | null, readonly recorded: boolean) {
    super(`VERIFICATION_FAILED: ${code}`);
    this.name = 'VerificationFailed';
  }
}

function sqlstateOf(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : null;
}

export function classifyVerificationError(err: unknown): VerificationFailureCode {
  if (sqlstateOf(err) === '55000') return 'COMMIT_TS_DISABLED';        // object_not_in_prerequisite_state
  return classifyRetentionError(err);
}

const int = (v: unknown): number => Number(v);
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : null);

/** One bounded, idempotent batch in its own transaction; a failure is recorded afterwards, separately. */
export async function verifyReceipts(client: ClientBase, limit: number = DEFAULT_VERIFY_RUNS): Promise<VerifyResult> {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_VERIFY_RUNS) throw new VerificationFailed('BAD_ARGUMENT', null, false);
  let row: Record<string, unknown>;
  try {
    row = (await client.query('SELECT * FROM si.si_verify_receipts($1::int)', [limit])).rows[0];
  } catch (err) {
    const code = classifyVerificationError(err);
    const sqlstate = sqlstateOf(err);
    let recorded = false;
    if (code !== 'CONNECTION') {
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL statement_timeout = '5s'`);
        await client.query('SELECT si.si_record_verification_failure($1, $2)', [code, sqlstate]);
        await client.query('COMMIT');
        recorded = true;
      } catch {
        await client.query('ROLLBACK').catch(() => {});
      }
    }
    throw new VerificationFailed(code, sqlstate, recorded);
  }
  const outcome = row.outcome;
  if (outcome !== 'VERIFIED' && outcome !== 'NOTHING_PENDING') throw new VerificationFailed('INTERNAL', null, false);
  return { outcome, verified: int(row.verified), valid: int(row.valid), invalid: int(row.invalid), unverifiable: int(row.unverifiable) };
}

export interface VerificationStatus {
  pending: number;
  valid: number;
  invalid: number;
  unverifiable: number;
  oldestPendingFinishedAt: string | null;
  oldestPendingAgeSeconds: number | null;
  lagTargetSeconds: number;
  lagExceeded: boolean;
  maxPendingXidAge: number | null;
  xidAgeWarning: boolean;
  failures24h: number;
  lastFailureAt: string | null;
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (err) {
    if (err instanceof VerificationFailed) throw err;
    throw new VerificationFailed(classifyVerificationError(err), sqlstateOf(err), false);
  }
}

export async function verificationStatus(client: ClientBase): Promise<VerificationStatus> {
  return guarded(async () => {
    const r = (await client.query('SELECT * FROM si.si_verification_status()')).rows[0];
    return {
      pending: int(r.pending), valid: int(r.valid), invalid: int(r.invalid), unverifiable: int(r.unverifiable),
      oldestPendingFinishedAt: iso(r.oldest_pending_finished_at),
      oldestPendingAgeSeconds: r.oldest_pending_age_seconds === null ? null : int(r.oldest_pending_age_seconds),
      lagTargetSeconds: int(r.lag_target_seconds), lagExceeded: r.lag_exceeded === true,
      maxPendingXidAge: r.max_pending_xid_age === null ? null : int(r.max_pending_xid_age), xidAgeWarning: r.xid_age_warning === true,
      failures24h: int(r.failures_24h), lastFailureAt: iso(r.last_failure_at)
    };
  });
}

export interface VerificationFailureRecord { failureId: number; occurredAt: string | null; code: string; sqlstate: string | null; recordedBy: string }

export async function verificationFailures(client: ClientBase, limit = 20): Promise<VerificationFailureRecord[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new VerificationFailed('BAD_ARGUMENT', null, false);
  return guarded(async () => (await client.query('SELECT * FROM si.si_verification_failures($1::int)', [limit])).rows.map(r => ({
    failureId: int(r.failure_id), occurredAt: iso(r.occurred_at), code: String(r.code),
    sqlstate: r.sqlstate === null ? null : String(r.sqlstate), recordedBy: String(r.recorded_by)
  })));
}

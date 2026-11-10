/**
 * Retention operations (migration 0006). Deterministic; no evidence values ever leave the database
 * through this module: results are codes, ids, times and counts, and failures are reduced to a
 * fixed code plus the five-character SQLSTATE (never the PostgreSQL message or detail).
 *
 * purgeDue needs an si_retention session; retentionStatus and purgeFailures accept si_retention or
 * si_monitor. Nothing here schedules itself: an operator or scheduler invokes it.
 */
import type { ClientBase } from 'pg';

export const MAX_PURGE_RUNS = 20;
export const DEFAULT_PURGE_RUNS = 10;

export type PurgeOutcome = 'PURGED' | 'NOTHING_DUE' | 'BUSY';
export interface PurgeResult {
  outcome: PurgeOutcome;
  sourceId: string | null;
  runsPurged: number;
  observationsPurged: number;
  identitiesPurged: number;
  lateRuns: number;
}

export type RetentionFailureCode =
  'BAD_ARGUMENT' | 'LOCK_TIMEOUT' | 'STATEMENT_TIMEOUT' | 'ISOLATION' | 'INTEGRITY' | 'PRIVILEGE' | 'CONNECTION' | 'INTERNAL';

/** Fixed message only: `RETENTION_FAILED: <code>`. */
export class RetentionFailed extends Error {
  constructor(readonly code: RetentionFailureCode, readonly sqlstate: string | null, readonly recorded: boolean) {
    super(`RETENTION_FAILED: ${code}`);
    this.name = 'RetentionFailed';
  }
}

function sqlstateOf(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : null;
}

export function classifyRetentionError(err: unknown): RetentionFailureCode {
  const s = sqlstateOf(err);
  if (s === '55P03') return 'LOCK_TIMEOUT';
  if (s === '57014') return 'STATEMENT_TIMEOUT';
  if (s === '25000' || s === '25001' || s === '40001') return 'ISOLATION';
  if (s === '42501') return 'PRIVILEGE';
  if (s !== null && s.startsWith('23')) return 'INTEGRITY';
  if (s !== null && (s.startsWith('08') || s.startsWith('57P'))) return 'CONNECTION';
  if (s === null) return 'CONNECTION';               // client-side: connection lost or never established
  return 'INTERNAL';
}

const int = (v: unknown): number => Number(v);

/**
 * One bounded purge batch (one source, at most `limit` runs) in its own transaction. On failure the
 * batch has rolled back completely; a content-free failure record is then written in a separate
 * transaction (best effort: `recorded` says whether it was).
 */
export async function purgeDue(client: ClientBase, limit: number = DEFAULT_PURGE_RUNS): Promise<PurgeResult> {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PURGE_RUNS) {
    throw new RetentionFailed('BAD_ARGUMENT', null, false);
  }
  let row: Record<string, unknown>;
  try {
    row = (await client.query('SELECT * FROM si.si_purge_due($1::int)', [limit])).rows[0];
  } catch (err) {
    const code = classifyRetentionError(err);
    const sqlstate = sqlstateOf(err);
    let recorded = false;
    if (code !== 'CONNECTION') {
      // Own short transaction with its own timeout, so a session-level statement_timeout that ended
      // the purge cannot also prevent the record.
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL statement_timeout = '5s'`);
        await client.query('SELECT si.si_record_purge_failure($1, $2)', [code, sqlstate]);
        await client.query('COMMIT');
        recorded = true;
      } catch {
        await client.query('ROLLBACK').catch(() => {});      // the original failure is what is reported
      }
    }
    throw new RetentionFailed(code, sqlstate, recorded);
  }
  const outcome = row.outcome;
  if (outcome !== 'PURGED' && outcome !== 'NOTHING_DUE' && outcome !== 'BUSY') throw new RetentionFailed('INTERNAL', null, false);
  return {
    outcome,
    sourceId: typeof row.purged_source === 'string' ? row.purged_source : null,
    runsPurged: int(row.runs_purged), observationsPurged: int(row.observations_purged),
    identitiesPurged: int(row.identities_purged), lateRuns: int(row.late_runs)
  };
}

export interface RetentionStatus {
  sourceId: string;
  retainedRuns: number;
  dueRuns: number;
  overdueRuns: number;
  nextEnd: string | null;
  oldestOverdueDueBy: string | null;
  purgedRuns: number;
  latePurges: number;
  lastPurgedAt: string | null;
}

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : null);

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (err) {
    if (err instanceof RetentionFailed) throw err;
    throw new RetentionFailed(classifyRetentionError(err), sqlstateOf(err), false);
  }
}

export async function retentionStatus(client: ClientBase): Promise<RetentionStatus[]> {
  return guarded(async () => (await client.query('SELECT * FROM si.si_retention_status()')).rows.map(r => ({
    sourceId: String(r.status_source), retainedRuns: int(r.retained_runs), dueRuns: int(r.due_runs),
    overdueRuns: int(r.overdue_runs), nextEnd: iso(r.next_end), oldestOverdueDueBy: iso(r.oldest_overdue_due_by),
    purgedRuns: int(r.purged_runs), latePurges: int(r.late_purges), lastPurgedAt: iso(r.last_purged_at)
  })));
}

/** Sources holding evidence past its cleanup deadline (effective end + the stricter cleanup_within). */
export async function overdueRetention(client: ClientBase): Promise<RetentionStatus[]> {
  return (await retentionStatus(client)).filter(s => s.overdueRuns > 0);
}

export interface PurgeFailureRecord {
  failureId: number;
  occurredAt: string | null;
  code: string;
  sqlstate: string | null;
  recordedBy: string;
}

export async function purgeFailures(client: ClientBase, limit = 20): Promise<PurgeFailureRecord[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RetentionFailed('BAD_ARGUMENT', null, false);
  return guarded(async () => (await client.query('SELECT * FROM si.si_purge_failures($1::int)', [limit])).rows.map(r => ({
    failureId: int(r.failure_id), occurredAt: iso(r.occurred_at), code: String(r.code),
    sqlstate: r.sqlstate === null ? null : String(r.sqlstate), recordedBy: String(r.recorded_by)
  })));
}

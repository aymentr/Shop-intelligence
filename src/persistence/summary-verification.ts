/**
 * M4-P3.3 Phase 2 (migration 0024, docs §18): bounded, resumable, auditable verification of the 0020 advertiser
 * summaries. Every function needs an si_monitor session, except clearDrift (the owner's authorized recovery).
 * Content-free: results are ids, states, codes and counts; a failure is a fixed code plus the five-character SQLSTATE.
 *
 * Each batch is ONE REPEATABLE READ transaction (one consistent snapshot), bounded by runs, observations and identities,
 * and by statement_timeout; it takes no source lock. A sweep never claims one snapshot across batches; what a
 * COMPLETED_CLEAN sweep proves is stated in docs §18.1. A batch whose response was lost is resubmitted with the SAME seq
 * and replayed by the database (nothing is verified twice); an attempt that did not commit is recorded separately.
 */
import type { ClientBase } from 'pg';

export interface SweepBudget { maxRuns: number; maxObservations: number; maxIdentities: number }
export const DEFAULT_SWEEP_BUDGET: SweepBudget = Object.freeze({ maxRuns: 50, maxObservations: 5000, maxIdentities: 1000 });
export const DEFAULT_BATCH_TIMEOUT_MS = 5000;

export type SweepState = 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED_CLEAN' | 'COMPLETED_DRIFT' | 'INCOMPLETE' | 'STALE';
export type SweepFailureCode = 'TIMEOUT' | 'BUSY' | 'SERIALIZATION' | 'ISOLATION' | 'SEQUENCE' | 'CLOSED' | 'CONNECTION' | 'ERROR';
const RETRYABLE: ReadonlySet<SweepFailureCode> = new Set(['TIMEOUT', 'BUSY', 'SERIALIZATION', 'CONNECTION']);

export interface SweepStart { sweepId: number; created: boolean; state: SweepState }
export interface SweepBatch {
  seq: number; state: SweepState; phase: string; outcome: 'OK' | 'DRIFT' | 'UNVERIFIABLE' | 'STALE';
  runs: number; observations: number; identities: number; findings: number; unverifiable: number; replayed: boolean;
}
export interface SweepStatus {
  sourceId: string; sweepId: number | null; state: SweepState; phase: string | null; batches: number | null; scopeRuns: number | null;
  runsVerified: number | null; unverifiableRuns: number | null; observationsVerified: number | null; identitiesVerified: number | null;
  driftFindings: number | null; failures: number | null; staleReason: string | null; startedAt: string | null; lastBatchAt: string | null;
  completedAt: string | null; lastCleanCompletedAt: string | null; driftOpen: boolean; summaryEligible: boolean | null;
}

/** Fixed message only: `SUMMARY_VERIFICATION_FAILED: <code>`. */
export class SweepBatchFailed extends Error {
  constructor(readonly code: SweepFailureCode, readonly sqlstate: string | null, readonly recorded: boolean) {
    super(`SUMMARY_VERIFICATION_FAILED: ${code}`);
    this.name = 'SweepBatchFailed';
  }
  get retryable(): boolean { return RETRYABLE.has(this.code); }
}

function sqlstateOf(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : null;
}
export function classifySweepError(err: unknown): SweepFailureCode {
  const s = sqlstateOf(err), m = err instanceof Error ? err.message : '';
  if (s === null || s.startsWith('08') || s.startsWith('57P')) return 'CONNECTION';
  if (s === '57014') return 'TIMEOUT';
  if (s === '55P03') return 'BUSY';
  if (s === '40001' || s === '40P01') return 'SERIALIZATION';
  if (/^SI_ISOLATION/.test(m)) return 'ISOLATION';
  if (/^SI_SWEEP_SEQUENCE/.test(m)) return 'SEQUENCE';
  if (/^SI_SWEEP_CLOSED/.test(m)) return 'CLOSED';
  return 'ERROR';
}
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : null);
function checkBudget(b: SweepBudget): void {
  for (const [k, lo, hi] of [['maxRuns', 1, 200], ['maxObservations', 500, 20000], ['maxIdentities', 1, 5000]] as const) {
    const v = b[k];
    if (!Number.isInteger(v) || v < lo || v > hi) throw new SweepBatchFailed('ERROR', null, false);
  }
}

export async function startSweep(client: ClientBase, sourceId: string): Promise<SweepStart> {
  const r = (await client.query('SELECT * FROM si.si_summary_sweep_start($1)', [sourceId])).rows[0];
  return { sweepId: Number(r.sweep_id), created: r.created === true, state: r.state as SweepState };
}

/** One batch: REPEATABLE READ, bounded by statement_timeout; a non-committed attempt is recorded in a new transaction. */
export async function runSweepBatch(client: ClientBase, sweepId: number, seq: number, budget: SweepBudget = DEFAULT_SWEEP_BUDGET,
                                     timeoutMs: number = DEFAULT_BATCH_TIMEOUT_MS): Promise<SweepBatch> {
  checkBudget(budget);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new SweepBatchFailed('ERROR', null, false);
  let row: Record<string, unknown>;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await client.query(`SET LOCAL statement_timeout = '${timeoutMs}ms'`);
    await client.query(`SET LOCAL lock_timeout = '1s'`);
    row = (await client.query('SELECT * FROM si.si_summary_sweep_batch($1::bigint, $2::int, $3::int, $4::int, $5::int)',
      [sweepId, seq, budget.maxRuns, budget.maxObservations, budget.maxIdentities])).rows[0];
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    const code = classifySweepError(err), sqlstate = sqlstateOf(err);
    let recorded = false;
    if (code !== 'CONNECTION') {
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL statement_timeout = '5s'`);
        await client.query('SELECT si.si_summary_sweep_record_failure($1::bigint, $2::int, $3, $4)', [sweepId, seq, code, sqlstate]);
        await client.query('COMMIT');
        recorded = true;
      } catch {
        await client.query('ROLLBACK').catch(() => {});
      }
    }
    throw new SweepBatchFailed(code, sqlstate, recorded);
  }
  return { seq: Number(row.seq), state: row.state as SweepState, phase: String(row.phase), outcome: row.outcome as SweepBatch['outcome'],
           runs: Number(row.runs), observations: Number(row.observations), identities: Number(row.identities),
           findings: Number(row.findings), unverifiable: Number(row.unverifiable), replayed: row.replayed === true };
}

export async function verificationStatus(client: ClientBase): Promise<SweepStatus[]> {
  return (await client.query('SELECT * FROM si.si_summary_verification_status()')).rows.map(r => ({
    sourceId: String(r.source_id), sweepId: num(r.sweep_id), state: r.state as SweepState, phase: r.phase ?? null, batches: num(r.batches),
    scopeRuns: num(r.scope_runs), runsVerified: num(r.runs_verified), unverifiableRuns: num(r.unverifiable_runs),
    observationsVerified: num(r.observations_verified), identitiesVerified: num(r.identities_verified), driftFindings: num(r.drift_findings),
    failures: num(r.failures), staleReason: r.stale_reason ?? null, startedAt: iso(r.started_at), lastBatchAt: iso(r.last_batch_at),
    completedAt: iso(r.completed_at), lastCleanCompletedAt: iso(r.last_clean_completed_at), driftOpen: r.drift_open === true,
    summaryEligible: r.summary_eligible === null ? null : r.summary_eligible === true }));
}

export interface SweepRun { sweepId: number; state: SweepState; batches: SweepBatch[]; failures: SweepBatchFailed[] }

/**
 * Starts (or resumes) the sweep of a source and runs batches until it is final or `maxBatches` were committed. The next
 * seq always comes from the database (batches + 1), so a restarted verifier continues exactly where the last committed
 * batch left it; a retryable failure is retried up to `maxRetries` times in a row (a lost response replays its batch).
 */
export async function verifySource(client: ClientBase, sourceId: string, o: {
  budget?: SweepBudget; maxBatches?: number; maxRetries?: number; timeoutMs?: number;
} = {}): Promise<SweepRun> {
  const start = await startSweep(client, sourceId);
  const out: SweepRun = { sweepId: start.sweepId, state: start.state, batches: [], failures: [] };
  let retries = 0;
  for (let i = 0; i < (o.maxBatches ?? 100000) && out.state === 'IN_PROGRESS';) {
    const st = (await verificationStatus(client)).find(s => s.sweepId === start.sweepId);
    if (!st) throw new SweepBatchFailed('ERROR', null, false);
    if (st.state !== 'IN_PROGRESS') { out.state = st.state; break; }
    try {
      const b = await runSweepBatch(client, start.sweepId, (st.batches ?? 0) + 1, o.budget ?? DEFAULT_SWEEP_BUDGET, o.timeoutMs);
      out.batches.push(b); out.state = b.state; retries = 0; i++;
    } catch (e) {
      if (!(e instanceof SweepBatchFailed) || !e.retryable || ++retries > (o.maxRetries ?? 3)) throw e;
      out.failures.push(e);
    }
  }
  return out;
}

/** The owner's authorized recovery (docs §18.4): requires a COMPLETED_CLEAN sweep started after the last drift/rebuild. */
export async function clearDrift(client: ClientBase, sourceId: string, sweepId: number): Promise<number> {
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL ROLE si_owner');
    const ev = Number((await client.query('SELECT si.si_summary_clear_drift($1, $2::bigint) AS e', [sourceId, sweepId])).rows[0].e);
    await client.query('COMMIT');
    return ev;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  }
}

/**
 * M4-P3.3 Phase 3 (migration 0026, docs §19): content-free operational observability, read by the si_monitor login.
 * Every value is an id, a role name, a fixed code, a count, a duration or a time: no query term, advertiser name, URL,
 * ad content or reason text. Nothing here delivers an alert anywhere; an external scheduler must poll `operationalAlerts`.
 */
import type { ClientBase } from 'pg';

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : null);
const pgInterval = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 366 * 86400) throw new Error('OBSERVABILITY_BAD_ARGUMENT: window');
  return `${Math.round(seconds)} seconds`;
};

export interface ReadPathStatus {
  sourceId: string; requestKind: 'search' | 'history'; requests: number; summaryPath: number; observationPath: number;
  fallback: { drift: number; incomplete: number; guard: number; notApplicable: number };
  p50Ms: number | null; p95Ms: number | null; maxMs: number | null;
  failuresReported: number; failureCodes: Record<string, number>;
  /** The SOURCE's intents left OPEN past expiry (all request kinds: intents carry no kind). */
  intentsExpiredOpen: number;
}
export async function readPathStatus(client: ClientBase, windowSeconds = 3600): Promise<ReadPathStatus[]> {
  return (await client.query('SELECT * FROM si.si_read_path_status($1::interval)', [pgInterval(windowSeconds)])).rows.map(r => ({
    sourceId: String(r.source_id), requestKind: r.request_kind, requests: Number(r.requests), summaryPath: Number(r.summary_path),
    observationPath: Number(r.observation_path),
    fallback: { drift: Number(r.fallback_drift), incomplete: Number(r.fallback_incomplete), guard: Number(r.fallback_guard),
                notApplicable: Number(r.fallback_not_applicable) },
    p50Ms: num(r.p50_ms), p95Ms: num(r.p95_ms), maxMs: num(r.max_ms), failuresReported: Number(r.failures_reported),
    failureCodes: (r.failure_codes ?? {}) as Record<string, number>, intentsExpiredOpen: Number(r.source_intents_expired_open) }));
}

export interface VerificationHealth {
  sourceId: string; driftOpen: boolean; driftDetectedAt: string | null; lastCleanSweepId: number | null; lastCleanCompletedAt: string | null;
  secondsSinceClean: number | null; active: { sweepId: number; phase: string; runsDone: number; scopeRuns: number; identitiesDone: number;
  scopeIdentities: number; lastBatchAt: string | null; failuresSinceLastBatch: number } | null;
  latestTerminalState: string | null; latestStaleReason: string | null; recentBusy: number; recentTimeouts: number; recentOtherFailures: number;
  lastClearanceAt: string | null; lastClearanceSweepId: number | null; lastRebuildAt: string | null; rebuildsSinceDrift: number;
}
export async function verificationHealth(client: ClientBase, windowSeconds = 3600): Promise<VerificationHealth[]> {
  return (await client.query('SELECT * FROM si.si_verification_health($1::interval)', [pgInterval(windowSeconds)])).rows.map(r => ({
    sourceId: String(r.source_id), driftOpen: r.drift_open === true, driftDetectedAt: iso(r.drift_detected_at),
    lastCleanSweepId: num(r.last_clean_sweep_id), lastCleanCompletedAt: iso(r.last_clean_completed_at), secondsSinceClean: num(r.seconds_since_clean),
    active: r.active_sweep_id === null ? null : { sweepId: Number(r.active_sweep_id), phase: String(r.active_phase), runsDone: Number(r.active_runs_done),
      scopeRuns: Number(r.active_scope_runs), identitiesDone: Number(r.active_identities_done), scopeIdentities: Number(r.active_scope_identities),
      lastBatchAt: iso(r.active_last_batch_at), failuresSinceLastBatch: Number(r.active_failures_since_last_batch) },
    latestTerminalState: r.latest_terminal_state ?? null, latestStaleReason: r.latest_stale_reason ?? null,
    recentBusy: Number(r.recent_busy), recentTimeouts: Number(r.recent_timeouts), recentOtherFailures: Number(r.recent_other_failures),
    lastClearanceAt: iso(r.last_clearance_at), lastClearanceSweepId: num(r.last_clearance_sweep_id), lastRebuildAt: iso(r.last_rebuild_at),
    rebuildsSinceDrift: Number(r.rebuilds_since_drift) }));
}

export interface ControlLatency {
  sourceId: string; kind: string; controls: number; p50WaitMs: number | null; p95WaitMs: number | null; maxWaitMs: number | null; overBudget: number;
  /** Client-reported refusals (recordControlFailure): a refused control rolls back, so only its client can count it. */
  refused: number; refusalCodes: Record<string, number>;
}
export async function controlLatency(client: ClientBase, windowSeconds = 86400, budgetMs = 5000): Promise<ControlLatency[]> {
  return (await client.query('SELECT * FROM si.si_control_latency_status($1::interval, $2::numeric)', [pgInterval(windowSeconds), budgetMs])).rows.map(r => ({
    sourceId: String(r.source_id), kind: String(r.kind), controls: Number(r.controls), p50WaitMs: num(r.p50_wait_ms),
    p95WaitMs: num(r.p95_wait_ms), maxWaitMs: num(r.max_wait_ms), overBudget: Number(r.over_budget ?? 0),
    refused: Number(r.refused), refusalCodes: (r.refusal_codes ?? {}) as Record<string, number> }));
}

export type ControlKind = 'SUSPEND' | 'LIFT' | 'TERMINATE_RETENTION';
export type ControlFailureCode = 'LOCK_TIMEOUT' | 'STATEMENT_TIMEOUT' | 'ISOLATION' | 'CLOCK_REGRESSION' | 'COMPARE_AND_SET' | 'BAD_ARGUMENT' | 'OTHER';
export function classifyControlError(err: unknown): ControlFailureCode {
  const code = (err as { code?: unknown } | null)?.code, m = err instanceof Error ? err.message : '';
  if (code === '55P03') return 'LOCK_TIMEOUT';
  if (code === '57014') return 'STATEMENT_TIMEOUT';
  if (/^SI_ISOLATION/.test(m)) return 'ISOLATION';
  if (/^SI_CLOCK_REGRESSION/.test(m)) return 'CLOCK_REGRESSION';
  if (/^SI_(STALE|LIFT|CONTROL_SEQ|EXPECTED|VERSION)/.test(m)) return 'COMPARE_AND_SET';
  if (/^SI_BAD_ARGUMENT/.test(m)) return 'BAD_ARGUMENT';
  return 'OTHER';
}
/**
 * The control client's refusal report (si_rights_admin, docs §19.4): after a source control failed, in a NEW transaction.
 * Best effort (never throws); records only the source, the kind and a fixed code.
 */
export async function recordControlFailure(client: ClientBase, sourceId: string, kind: ControlKind, err: unknown): Promise<ControlFailureCode> {
  const code = classifyControlError(err);
  try { await client.query('SELECT si.si_record_control_failure($1, $2, $3)', [sourceId, kind, code]); } catch { /* telemetry only */ }
  return code;
}

export interface LockWait { waiterPid: number; waiterRole: string; waitMs: number; lockType: string; onSources: boolean; blockerPids: number[]; blockerRoles: string[] }
export async function controlLockWaits(client: ClientBase): Promise<LockWait[]> {
  return (await client.query('SELECT * FROM si.si_control_lock_waits()')).rows.map(r => ({
    waiterPid: Number(r.waiter_pid), waiterRole: String(r.waiter_role), waitMs: Number(r.wait_ms), lockType: String(r.lock_type),
    onSources: r.on_sources === true, blockerPids: (r.blocker_pids ?? []).map(Number), blockerRoles: r.blocker_roles ?? [] }));
}

/** Alert thresholds (docs §19.5). Every field optional; the defaults are the database function's. */
export interface AlertThresholds {
  maxCleanAgeSeconds?: number; windowSeconds?: number; fallbackMinRequests?: number; fallbackRatio?: number; failureMax?: number;
  controlBudgetMs?: number; controlWindowSeconds?: number; readerP95Ms?: number; readerMinRequests?: number;
}
export const DEFAULT_ALERT_THRESHOLDS: Required<AlertThresholds> = Object.freeze({
  maxCleanAgeSeconds: 86400, windowSeconds: 3600, fallbackMinRequests: 20, fallbackRatio: 0.5, failureMax: 3,
  controlBudgetMs: 5000, controlWindowSeconds: 86400, readerP95Ms: 400, readerMinRequests: 20 });
export type AlertCode = 'DRIFT_OPEN' | 'VERIFICATION_OVERDUE' | 'VERIFICATION_FAILING' | 'VERIFICATION_STALLED' | 'PERSISTENT_FALLBACK'
  | 'READER_LATENCY' | 'CONTROL_DEADLINE_BREACH' | 'CONTROL_REFUSED' | 'CONTROL_WAITING';
export interface Alert { alert: AlertCode; sourceId: string | null; observed: number | null; threshold: number | null }
export async function operationalAlerts(client: ClientBase, t: AlertThresholds = {}): Promise<Alert[]> {
  const v = { ...DEFAULT_ALERT_THRESHOLDS, ...t };
  for (const [k, x] of Object.entries(v)) if (typeof x !== 'number' || !Number.isFinite(x) || x < 0) throw new Error(`OBSERVABILITY_BAD_ARGUMENT: ${k}`);
  if (v.fallbackRatio > 1 || !Number.isInteger(v.fallbackMinRequests) || !Number.isInteger(v.failureMax) || !Number.isInteger(v.readerMinRequests)) {
    throw new Error('OBSERVABILITY_BAD_ARGUMENT: thresholds');
  }
  return (await client.query(
    `SELECT * FROM si.si_operational_alerts($1::interval, $2::interval, $3::int, $4::numeric, $5::int, $6::numeric, $7::interval, $8::numeric, $9::int)`,
    [pgInterval(v.maxCleanAgeSeconds), pgInterval(v.windowSeconds), v.fallbackMinRequests, v.fallbackRatio, v.failureMax,
     v.controlBudgetMs, pgInterval(v.controlWindowSeconds), v.readerP95Ms, v.readerMinRequests])).rows.map(r => ({
    alert: r.alert as AlertCode, sourceId: r.source_id ?? null, observed: num(r.observed), threshold: num(r.threshold) }));
}

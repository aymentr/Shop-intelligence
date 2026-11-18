/**
 * DEMO-V1 — the application service: every database access of the local interface, through the EXISTING library and
 * database functions, each under the least-privileged existing role that may perform it.
 *
 *   analyst (dedicated si_reader principal) — availability, source status, evidence scan, search, history
 *       (src/persistence/intelligence.ts: si_read_source_availability, si_read_source_status, si_read_evidence,
 *        si_search_advertisers [summary-backed, 0023], si_advertiser_history). Each call is its own audited request.
 *   si_collector  — source catalog and run metadata (SELECT on si.sources, si.source_controls, si.collection_runs,
 *       si.publication_receipts: the collector's existing grants), and the collection workflow (T1 / T2).
 *   si_monitor    — receipt verification (si_verify_receipts) and its content-free status.
 *   si_rights_admin — source controls (si_record_source_control: SUSPEND / LIFT).
 *
 * There is no second implementation of search, history or readability here: what the analyst may read is decided by
 * the database on every call. Credentials stay in this process; the browser only ever receives JSON results.
 */
import pg from 'pg';
import { advertiserHistory, IntelligenceFailed, scanEvidence, searchAdvertisers, sourceAvailability, sourceStatus,
         normalizeAdvertiser, MAX_SEARCH_RESULTS, type Period } from '../../dist/persistence/intelligence.js';
import { ReadFailed } from '../../dist/persistence/reader.js';
import { T1Refused, T2Refused } from '../../dist/persistence/runs.js';
import { verifyReceipts, VerificationFailed } from '../../dist/persistence/verification.js';
import { ANALYST, SCENARIOS, SOURCES } from './dataset.js';
import { collectRun, type DbTarget, type RolePasswords } from './seed.js';

/** A failure the interface may show: a fixed code (never PostgreSQL text), optional source and reason codes. */
export class AppError extends Error {
  constructor(readonly status: number, readonly code: string, readonly detail: { sourceId?: string | null; reasons?: readonly string[] } = {}) {
    super(code);
    this.name = 'AppError';
  }
}

/** Maps the library's typed failures to fixed, content-free codes. Anything else is INTERNAL (logged by code only). */
export function toAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  if (e instanceof IntelligenceFailed) {
    const status = e.code === 'BAD_ARGUMENT' || e.code === 'BAD_CURSOR' ? 400 : e.code === 'SOURCE_UNAVAILABLE' ? 409 : 422;
    return new AppError(status, e.code, { sourceId: e.sourceId, reasons: e.reasons });
  }
  if (e instanceof ReadFailed) return new AppError(e.code === 'NOT_AUTHORIZED' ? 403 : e.code === 'BAD_ARGUMENT' || e.code === 'BAD_CURSOR' ? 400 : 503, e.code);
  if (e instanceof T1Refused || e instanceof T2Refused) return new AppError(409, e.code);
  if (e instanceof VerificationFailed) return new AppError(503, e.code);
  return new AppError(500, 'INTERNAL');
}

const SOURCE_ID = /^[a-z0-9][a-z0-9-]{1,62}$/;
const DAY = 86400000;

export interface ServiceConfig { db: DbTarget; passwords: RolePasswords }

export class DemoService {
  readonly analyst: pg.Pool; readonly collector: pg.Pool; readonly monitor: pg.Pool; readonly rightsAdmin: pg.Pool;

  constructor(cfg: ServiceConfig) {
    const pool = (user: string, password: string, max: number) => {
      const p = new pg.Pool({ ...cfg.db, user, password, max, application_name: 'si-demo-v1', idleTimeoutMillis: 30000 });
      p.on('error', () => {});
      return p;
    };
    this.analyst = pool(ANALYST, cfg.passwords.analyst, 4);
    this.collector = pool('si_collector', cfg.passwords.collector, 2);
    this.monitor = pool('si_monitor', cfg.passwords.monitor, 1);
    this.rightsAdmin = pool('si_rights_admin', cfg.passwords.rightsAdmin, 1);
  }

  async close(): Promise<void> {
    await Promise.all([this.analyst, this.collector, this.monitor, this.rightsAdmin].map(p => p.end().catch(() => {})));
  }

  private async with<T>(p: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await p.connect();
    try { return await fn(c); } finally { c.release(); }
  }

  // ---------------------------------------------------------------- sources and availability

  /** The source catalog as the collector sees it (operational metadata: no evidence). */
  async catalog() {
    return this.with(this.collector, async c => (await c.query(
      `SELECT s.source_id, s.display_name, s.evidence_kind, s.supported_networks::text[] AS networks, s.retired_at,
              (SELECT k.kind FROM si.source_controls k WHERE k.source_id = s.source_id ORDER BY k.control_seq DESC LIMIT 1) AS last_control
         FROM si.sources s ORDER BY s.source_id`)).rows.map(r => ({
      sourceId: r.source_id as string, displayName: r.display_name as string, evidenceKind: r.evidence_kind as string,
      networks: r.networks as string[], retired: r.retired_at !== null, lastControl: (r.last_control as string | null) ?? null,
      purpose: SOURCES.find(s => s.sourceId === r.source_id)?.purpose ?? null })));
  }

  /** The analyst's view of one source: AVAILABLE, UNAVAILABLE (with reasons) or NOT_GRANTED. Decided by the database. */
  async access(sourceId: string): Promise<{ sourceId: string; state: 'AVAILABLE' | 'UNAVAILABLE' | 'NOT_GRANTED'; reasons: string[]; asOf: string | null }> {
    try {
      const a = await this.with(this.analyst, c => sourceAvailability(c, sourceId));
      return { sourceId, state: a.available ? 'AVAILABLE' : 'UNAVAILABLE', reasons: [...a.reasons], asOf: a.asOf };
    } catch (e) {
      if (e instanceof ReadFailed && e.code === 'NOT_AUTHORIZED') return { sourceId, state: 'NOT_GRANTED', reasons: [], asOf: null };
      throw e;
    }
  }

  // ---------------------------------------------------------------- A. overview

  async overview() {
    const catalog = await this.catalog();
    const now = Date.now();
    const period: Period = { from: new Date(now - 30 * DAY), to: new Date(now + 60 * 60000) };
    const sources = [];
    for (const s of catalog) {
      const access = await this.access(s.sourceId);
      let evidence = null, status = null, error: string | null = null;
      if (access.state === 'AVAILABLE') {
        try {
          const scan = await this.with(this.analyst, c => scanEvidence(c, s.sourceId));
          const advertisers = new Set(scan.records.map(r => normalizeAdvertiser(r.advertiserName)));
          const ads = new Set(scan.records.map(r => `${r.network}|${r.nativeAdId}`));
          const runs = new Set(scan.records.map(r => r.runId));
          const networks = [...new Set(scan.records.map(r => r.network))].sort();
          const latest = scan.records.reduce<string | null>((m, r) => (m === null || r.collectedAt > m ? r.collectedAt : m), null);
          evidence = { observations: scan.records.length, advertisers: advertisers.size, distinctAds: ads.size, runsWithEvidence: runs.size,
                       networks, latestCollectedAt: latest, auditedPages: scan.pages };
          const st = await this.with(this.analyst, c => sourceStatus(c, s.sourceId, period));
          status = { runsCompleted: st.runsCompleted, runsFailed: st.runsFailed, runsEmpty: st.runsEmpty, runsWithEvidence: st.runsWithEvidence,
                     runsVerifiedValid: st.runsVerifiedValid, runsVerifiedInvalid: st.runsVerifiedInvalid,
                     runsVerifiedUnverifiable: st.runsVerifiedUnverifiable, runsVerificationPending: st.runsVerificationPending,
                     runsReadable: st.runsReadable, latestSuccessfulCollectionAt: st.latestSuccessfulCollectionAt,
                     latestVerifiedEvidenceAt: st.latestVerifiedEvidenceAt, asOf: st.asOf };
        } catch (e) { error = toAppError(e).code; }
      }
      sources.push({ ...s, access, evidence, status, error });
    }
    const runs = await this.runs(12);
    const controls = await this.controls(8);
    const pub = await this.with(this.collector, async c => (await c.query(
      `SELECT count(*) FILTER (WHERE status = 'COMPLETED')::int AS completed, count(*) FILTER (WHERE status = 'COMPLETED' AND published_count > 0)::int AS published,
              count(*) FILTER (WHERE status = 'FAILED')::int AS failed, count(*) FILTER (WHERE status = 'REJECTED')::int AS rejected,
              count(*) FILTER (WHERE status = 'RUNNING')::int AS running FROM si.collection_runs`)).rows[0]);
    const readable = sources.filter(s => s.evidence);
    return {
      period: { from: period.from.toISOString(), to: period.to.toISOString() },
      totals: {
        sources: catalog.length,
        sourcesAvailable: sources.filter(s => s.access.state === 'AVAILABLE').length,
        advertiserIdentities: readable.reduce((n, s) => n + (s.evidence?.advertisers ?? 0), 0),
        distinctAds: readable.reduce((n, s) => n + (s.evidence?.distinctAds ?? 0), 0),
        readableObservations: readable.reduce((n, s) => n + (s.evidence?.observations ?? 0), 0),
        runs: pub
      },
      sources, recentRuns: runs, recentControls: controls
    };
  }

  // ---------------------------------------------------------------- B. search (summary-backed, 0023)

  async search(q: { query: string; sources?: string[]; networks?: string[]; period?: Period; cursor?: string | null; limit?: number }) {
    let sources: string[];
    const excluded: { sourceId: string; state: string; reasons: string[] }[] = [];
    if (q.cursor) {
      // A cursor is bound to the exact source list of its first page; it is never re-filtered (and never an authorization).
      if (!q.sources?.length) throw new AppError(400, 'BAD_ARGUMENT');
      sources = q.sources;
    } else {
      const requested = q.sources?.length ? q.sources : (await this.catalog()).map(s => s.sourceId);
      sources = [];
      for (const id of requested) {
        if (!SOURCE_ID.test(id)) throw new AppError(400, 'BAD_ARGUMENT');
        const a = await this.access(id);
        if (a.state === 'AVAILABLE') sources.push(id); else excluded.push({ sourceId: id, state: a.state, reasons: a.reasons });
      }
      if (!sources.length) return { hits: [], nextCursor: null, sources: [], excluded, scannedPages: 0 };
    }
    const page = await this.with(this.analyst, c => searchAdvertisers(c, {
      sources, query: q.query, ...(q.networks?.length ? { networks: q.networks } : {}), ...(q.period ? { period: q.period } : {}),
      limit: q.limit ?? 20, cursor: q.cursor ?? null }));
    return { hits: page.hits, nextCursor: page.nextCursor, sources, excluded, scannedPages: page.scannedPages };
  }

  // ---------------------------------------------------------------- C/D. advertiser detail and history

  async advertiser(sourceId: string, name: string, opts: { networks?: string[]; period?: Period }) {
    const h = await this.with(this.analyst, c => advertiserHistory(c, sourceId, name, {
      ...(opts.period ? { period: opts.period } : {}), ...(opts.networks?.length ? { networks: opts.networks } : {}) }));
    const now = Date.now();
    const statusPeriod: Period = opts.period ?? { from: new Date(now - 365 * DAY), to: new Date(now + 60 * 60000) };
    const st = await this.with(this.analyst, c => sourceStatus(c, sourceId, statusPeriod));
    const ads = new Map<string, { network: string; nativeAdId: string; title: string | null; observations: number; firstCollectedAt: string; lastCollectedAt: string;
                                  firstSeenAt: string; lastSeenAt: string; sourceUrl: string }>();
    for (const o of h.observations) {
      const k = `${o.network}|${o.nativeAdId}`;
      const a = ads.get(k);
      if (!a) ads.set(k, { network: o.network, nativeAdId: o.nativeAdId, title: o.title, observations: 1, firstCollectedAt: o.collectedAt,
                           lastCollectedAt: o.collectedAt, firstSeenAt: o.seenAt, lastSeenAt: o.seenAt, sourceUrl: o.sourceUrl });
      else {
        a.observations++;
        if (o.collectedAt < a.firstCollectedAt) a.firstCollectedAt = o.collectedAt;
        if (o.collectedAt > a.lastCollectedAt) a.lastCollectedAt = o.collectedAt;
        if (o.seenAt < a.firstSeenAt) a.firstSeenAt = o.seenAt;
        if (o.seenAt > a.lastSeenAt) a.lastSeenAt = o.seenAt;
      }
    }
    return {
      history: h,
      ads: [...ads.values()].sort((x, y) => (x.network + x.nativeAdId).localeCompare(y.network + y.nativeAdId)),
      sourceStatus: { period: { from: statusPeriod.from.toISOString(), to: statusPeriod.to.toISOString() },
                      runsVerifiedValid: st.runsVerifiedValid, runsVerifiedInvalid: st.runsVerifiedInvalid,
                      runsVerifiedUnverifiable: st.runsVerifiedUnverifiable, runsVerificationPending: st.runsVerificationPending,
                      runsWithEvidence: st.runsWithEvidence, latestVerifiedEvidenceAt: st.latestVerifiedEvidenceAt }
    };
  }

  // ---------------------------------------------------------------- E. collection and publication

  async runs(limit = 50) {
    return this.with(this.collector, async c => (await c.query(
      `SELECT r.run_id, r.source_id, r.request_key, r.attempt, r.status, r.outcome_code, r.retention_state, r.started_at, r.finished_at,
              r.received_count, r.published_count, r.duplicate_count, r.conflict_count, r.error_count,
              rc.receipt_at
         FROM si.collection_runs r LEFT JOIN si.publication_receipts rc ON rc.run_id = r.run_id
        ORDER BY r.started_at DESC, r.run_id LIMIT $1`, [limit])).rows.map(runRow));
  }

  async run(runId: string) {
    const rows = await this.with(this.collector, async c => (await c.query(
      `SELECT r.run_id, r.source_id, r.request_key, r.attempt, r.status, r.outcome_code, r.retention_state, r.started_at, r.finished_at,
              r.received_count, r.published_count, r.duplicate_count, r.conflict_count, r.error_count, rc.receipt_at
         FROM si.collection_runs r LEFT JOIN si.publication_receipts rc ON rc.run_id = r.run_id WHERE r.run_id = $1`, [runId])).rows);
    return rows[0] ? runRow(rows[0]) : null;
  }

  async controls(limit = 20, sourceId: string | null = null) {
    return this.with(this.collector, async c => (await c.query(
      `SELECT source_id, control_seq, kind, reason, occurred_at, recorded_by FROM si.source_controls
        WHERE $2::text IS NULL OR source_id = $2 ORDER BY occurred_at DESC, control_event_id DESC LIMIT $1`,
      [limit, sourceId])).rows.map(r => ({ sourceId: r.source_id, controlSeq: r.control_seq, kind: r.kind, reason: r.reason,
                                 occurredAt: (r.occurred_at as Date).toISOString(), recordedBy: r.recorded_by })));
  }

  async verificationStatus() {
    const r = await this.with(this.monitor, async c => (await c.query('SELECT * FROM si.si_verification_status()')).rows[0]);
    return { pending: r.pending, valid: r.valid, invalid: r.invalid, unverifiable: r.unverifiable, lagExceeded: r.lag_exceeded, failures24h: r.failures_24h };
  }

  async operations() {
    return { runs: await this.runs(50), controls: await this.controls(20), verification: await this.verificationStatus(),
             scenarios: SCENARIOS.map(s => ({ id: s.id, title: s.title, description: s.description })), sources: await this.catalog() };
  }

  /** Executes one catalog scenario as a real collection (T1 + T2). The result is the run as PERSISTED afterwards. */
  async collect(sourceId: string, scenarioId: string) {
    const scenario = SCENARIOS.find(s => s.id === scenarioId);
    if (!scenario || !SOURCE_ID.test(sourceId)) throw new AppError(400, 'BAD_ARGUMENT');
    const source = (await this.catalog()).find(s => s.sourceId === sourceId);
    if (!source) throw new AppError(404, 'UNKNOWN_SOURCE');
    const seenAt = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
    const rows = scenario.rows(seenAt);
    try {
      const r = await this.with(this.collector, c => collectRun(c, sourceId, source.networks, rows, `ui-${scenario.id}`));
      return { scenario: scenario.id, outcome: r.outcome, code: r.code, published: r.published,
               diagnostics: r.diagnostics ? { errorCount: r.diagnostics.errorCount, errors: r.diagnostics.records.slice(0, 10) } : null,
               run: await this.run(r.runId) };
    } catch (e) {
      if (e instanceof T1Refused) return { scenario: scenario.id, outcome: 'REFUSED', code: e.code, published: 0, diagnostics: null, run: null };
      throw e;
    }
  }

  async verify() {
    const r = await this.with(this.monitor, c => verifyReceipts(c, 100));
    return { result: r, status: await this.verificationStatus() };
  }

  /** SUSPEND or LIFT through si_record_source_control (si_rights_admin). LIFT uses the compare-and-set view as the
   *  existing lifecycle demonstration does. The result is the control as persisted. */
  async control(sourceId: string, kind: string, reason: string) {
    if (!SOURCE_ID.test(sourceId) || (kind !== 'SUSPEND' && kind !== 'LIFT') || typeof reason !== 'string' ||
        reason.trim().length < 3 || reason.length > 200) throw new AppError(400, 'BAD_ARGUMENT');
    try {
      await this.with(this.rightsAdmin, async c => {
        let v: number | null = null, s: number | null = null;
        if (kind === 'LIFT') {
          const row = (await c.query(`SELECT (SELECT coalesce(max(version), 0) FROM si.rights_versions WHERE source_id = $1)::int AS v,
                                             (SELECT coalesce(max(control_seq), 0) FROM si.source_controls WHERE source_id = $1)::int AS s`, [sourceId])).rows[0];
          v = row.v; s = row.s;
        }
        await c.query('SELECT * FROM si.si_record_source_control($1, $2, $3, NULL, $4, $5, NULL, NULL)', [sourceId, kind, reason.trim(), v, s]);
      });
    } catch (e) {
      const m = (e as { message?: unknown })?.message;
      const code = typeof m === 'string' ? /^(SI_[A-Z_]+):/.exec(m)?.[1] : undefined;
      throw new AppError(409, code ?? 'CONTROL_REFUSED');
    }
    return { control: (await this.controls(1, sourceId))[0] ?? null, access: await this.access(sourceId) };
  }
}

function runRow(r: Record<string, unknown>) {
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : null);
  return { runId: r.run_id as string, sourceId: r.source_id as string, requestKey: r.request_key as string, attempt: r.attempt as number,
           status: r.status as string, outcomeCode: (r.outcome_code as string | null) ?? null, retentionState: r.retention_state as string,
           startedAt: iso(r.started_at), finishedAt: iso(r.finished_at), receiptAt: iso(r.receipt_at),
           counts: { received: r.received_count, published: r.published_count, duplicate: r.duplicate_count, conflict: r.conflict_count, errors: r.error_count } };
}

export { MAX_SEARCH_RESULTS };

// B-002 M4-P3.3 Phase 2 (migration 0024): cost of a bounded summary verification sweep against the legacy one-transaction
// si_verify_summaries, at SI_SWEEP_RUNS runs x SI_SWEEP_OBS observations of one source (default 400 x 500 = 200,000),
// published through the product path (si_complete_run, which writes the summaries). Measured:
//   - per batch: latency p50 / p95 / max, observations verified (asserted <= budget);
//   - emergency controls (SUSPEND then LIFT) issued every ~50 ms while the sweep runs: their wait p50 / p95 / max
//     (asserted p95 < 1 s), and the same while the legacy verification holds the source FOR SHARE (reported);
//   - that no batch holds a row lock on the source (FOR UPDATE NOWAIT on the source row succeeds mid-batch);
//   - buffer reads / hits and WAL bytes of the sweep (database load), sweep and legacy duration, storage of the records.
// A synthetic benchmark on a test container (tmpfs, fsync off) is NOT evidence of production-storage performance.
//   SI_SWEEP_RUNS=400 SI_SWEEP_OBS=500 node tests/db/run.mjs tests/slow/m4-sweep-bench.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { asOwner, connect, control, createSources, freshDatabase, lift, recordRights, roles } from '../db/helpers.mjs';
import { fixtureSha256, requestSha256 } from '../../dist/persistence/request-hash.js';
import { runSweepBatch, startSweep, verificationStatus } from '../../dist/persistence/summary-verification.js';

const RUNS = Number(process.env.SI_SWEEP_RUNS ?? 400), OBS = Number(process.env.SI_SWEEP_OBS ?? 500);
const BUDGET = { maxRuns: 50, maxObservations: 5000, maxIdentities: 1000 };
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] : 0; };
const fmt = a => `p50 ${q(a, 0.5).toFixed(1)} / p95 ${q(a, 0.95).toFixed(1)} / max ${Math.max(0, ...a).toFixed(1)} ms (n=${a.length})`;
let n = 0;

async function collect(c, src, rows) {
  const fx = fixtureSha256(rows), sha = requestSha256({ adapterId: src, evidenceKind: 'SYNTHETIC', networks: ['META'], fixtureSha256: fx });
  const run = (await c.query('SELECT * FROM si.si_begin_run_scoped($1,$2,$3,$4,$5::text[],$6)', [src, `swb${++n}`, sha, 'SYNTHETIC', ['META'], fx])).rows[0];
  await c.query('BEGIN');
  await c.query('SELECT * FROM si.si_complete_run($1::uuid, $2::uuid, $3::jsonb)', [run.run_id, run.lease_token, JSON.stringify(rows)]);
  await c.query('COMMIT');
}
/** SUSPEND / LIFT pairs every ~50 ms until stop(); returns each control's wait, and the controls refused by lock_timeout
 *  (55P03: the control could not take the source row in time; any other error fails the benchmark). */
function controls(ra, src) {
  const waits = []; let run = true, suspended = false, lockTimeouts = 0;
  const timed = async f => {
    const t0 = performance.now();
    try { await f(); waits.push(performance.now() - t0); return true; }
    catch (e) { if (e?.code !== '55P03') throw e; lockTimeouts++; waits.push(performance.now() - t0); return false; }
  };
  const loop = (async () => { while (run) {
    if (!suspended) suspended = await timed(() => control(ra, src, 'SUSPEND'));
    if (suspended) suspended = !(await timed(() => lift(ra, src)));
    await sleep(50);
  } })();
  return { stop: async () => { run = false; await loop; return { waits, lockTimeouts, suspended }; } };
}
const dbStats = async a => (await a.query(`SELECT blks_read + 0 AS r, blks_hit + 0 AS h FROM pg_stat_database WHERE datname = current_database()`)).rows[0];

test(`SWB: sweep of ${RUNS} runs x ${OBS} observations in bounded batches vs the legacy one-transaction verification`, { timeout: 3 * 3600 * 1000 }, async t => {
  const db = await freshDatabase(t, 'm4swb');
  const x = await roles(t, db, ['admin', 'si_rights_admin', 'si_collector', 'si_monitor']);
  const src = `swb-${++n}`;
  await createSources(x.admin, [src], ['META']);
  await recordRights(x.si_rights_admin, src, {});
  const t0 = performance.now();
  for (let r = 0; r < RUNS; r++)
    await collect(x.si_collector, src, Array.from({ length: OBS }, (_, k) => ({ network: 'META', nativeAdId: `b-${r}-${k}`, advertiserName: `Synthetic Co ${(r * 7 + k) % 2000}`,
      countries: ['DE'], seenAt: '2026-01-01T00:00:00.000Z', sourceUrl: 'https://example.test/a', title: 't' })));
  await x.admin.query('VACUUM ANALYZE');
  console.log(`# SWB loaded ${RUNS} runs x ${OBS} = ${RUNS * OBS} observations in ${((performance.now() - t0) / 1000).toFixed(0)} s`);
  const ctl = await connect({ user: 'si_rights_admin', database: db }); t.after(() => ctl.end());
  const probe = await connect({ database: db }); t.after(() => probe.end());

  // ---- bounded sweep, with emergency controls running throughout
  const before = await dbStats(x.admin);
  const lsn0 = (await x.admin.query('SELECT pg_current_wal_insert_lsn()::text AS l')).rows[0].l;
  const c = controls(ctl, src);
  const st = await startSweep(x.si_monitor, src);
  const lat = [], obs = []; let state = 'IN_PROGRESS', seq = 0, noRowLock = null;
  const s0 = performance.now();
  while (state === 'IN_PROGRESS') {
    seq++;
    const b0 = performance.now();
    if (seq === 3) {                                                   // mid-batch: is the source row locked by the verifier?
      const v = await connect({ user: 'si_monitor', database: db });
      await v.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await v.query('SELECT * FROM si.si_summary_sweep_batch($1, $2, $3, $4, $5)', [st.sweepId, seq, BUDGET.maxRuns, BUDGET.maxObservations, BUDGET.maxIdentities]);
      await probe.query('BEGIN');
      noRowLock = await probe.query(`SELECT 1 FROM si.sources WHERE source_id = $1 FOR UPDATE NOWAIT`, [src]).then(() => true, () => false);
      await probe.query('ROLLBACK');
      await v.query('COMMIT'); await v.end();
      const w = (await x.admin.query('SELECT state FROM si.summary_sweeps WHERE sweep_id = $1', [st.sweepId])).rows[0];
      state = w.state; lat.push(performance.now() - b0); continue;
    }
    const b = await runSweepBatch(x.si_monitor, st.sweepId, seq, BUDGET);
    lat.push(performance.now() - b0); obs.push(b.observations); state = b.state;
    assert.ok(b.observations <= BUDGET.maxObservations && b.runs <= BUDGET.maxRuns, JSON.stringify(b));
  }
  const sweepMs = performance.now() - s0;
  const { waits, lockTimeouts } = await c.stop();
  const wal = Number((await x.admin.query('SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(), $1::pg_lsn)::bigint AS b', [lsn0])).rows[0].b);
  const after = await dbStats(x.admin);
  const status = (await verificationStatus(x.si_monitor)).find(s => s.sourceId === src);
  const store = (await x.admin.query(`SELECT pg_size_pretty(sum(pg_total_relation_size(c.oid))) AS s, sum(pg_total_relation_size(c.oid))::bigint AS b FROM pg_class c
     WHERE c.relnamespace = 'si'::regnamespace AND c.relname IN ('summary_sweeps', 'summary_sweep_batches', 'summary_sweep_runs', 'summary_sweep_identities', 'summary_sweep_failures')`)).rows[0];
  console.log(`# SWB sweep ${status.state}: ${seq} batches in ${(sweepMs / 1000).toFixed(1)} s; runs ${status.runsVerified}, observations ${status.observationsVerified}, identities ${status.identitiesVerified}`);
  console.log(`# SWB batch latency ${fmt(lat)}; observations per batch max ${Math.max(...obs)} (budget ${BUDGET.maxObservations})`);
  console.log(`# SWB emergency controls during the sweep: wait ${fmt(waits)}; source row lock held by a batch: ${noRowLock === false}; controls refused by lock_timeout: ${lockTimeouts}`);
  console.log(`# SWB database load of the sweep: blocks read ${Number(after.r) - Number(before.r)}, hit ${Number(after.h) - Number(before.h)}; WAL ${(wal / 1048576).toFixed(2)} MB; verification records ${store.s} (${Math.round(Number(store.b) / Math.max(1, status.runsVerified))} B per run)`);
  assert.equal(status.state, 'COMPLETED_CLEAN');
  assert.equal(noRowLock, true, 'no batch holds a row lock on the source');
  assert.equal(lockTimeouts, 0, 'no emergency control is refused by lock_timeout during the sweep');
  assert.ok(q(waits, 0.95) < 1000, `control wait p95 ${q(waits, 0.95).toFixed(0)} ms during the sweep`);

  // ---- legacy: one transaction over the whole source, holding it FOR SHARE (report only)
  const c2 = controls(ctl, src);
  await sleep(100);
  const l0 = performance.now();
  await asOwner(x.admin, async a => { await a.query('BEGIN'); await a.query('SELECT * FROM si.si_verify_summaries($1)', [src]); await a.query('ROLLBACK'); });
  const legacyMs = performance.now() - l0;
  const l2 = await c2.stop();
  if (l2.suspended) await lift(ctl, src);
  console.log(`# SWB legacy si_verify_summaries: ${(legacyMs / 1000).toFixed(1)} s in one transaction; emergency controls meanwhile: wait ${fmt(l2.waits)}; refused by lock_timeout: ${l2.lockTimeouts}`);
});

// B-002 M4-P3.3-P2-CLOSE-01 (migration 0025, docs §18.1, §18.7): batched verification safety closure.
//   CL-1..CL-3   idle transactions of the verification login (si_monitor) vs emergency controls (SUSPEND, TERMINATE_RETENTION)
//   CL-4..CL-9   the strengthened clearance: fingerprint, late commits inside the boundary, isolation, post-boundary runs
//   NM1..NM4     detectors of the mutants of tests/mutations/m4-p33-p2-close.mjs (deterministic schedules, no SQL-text checks)
// Fixtures a product path cannot perform are labelled as in m4-sweep.test.mjs (CORRUPTION, NORMALIZER CHANGE, LATE COMMIT).
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { asOwner, cfg, connect, control, createSources, freshDatabase, lift, recordRights, roles, schemaFingerprint, settle } from './helpers.mjs';
import { fixtureSha256, requestSha256 } from '../../dist/persistence/request-hash.js';
import { clearDrift, runSweepBatch, startSweep, SweepBatchFailed, verificationStatus, verifySource } from '../../dist/persistence/summary-verification.js';
import { migrateDown, migrateUp } from '../../dist/persistence/migrate.js';

const ROLES = ['admin', 'si_rights_admin', 'si_collector', 'si_monitor', 'si_retention'];
const B = (maxRuns = 50, maxObservations = 5000, maxIdentities = 1000) => ({ maxRuns, maxObservations, maxIdentities });
let n = 0;
const AD = (id, name = `Synthetic Co ${id % 3}`, network = 'META') => ({ network, nativeAdId: `ad-${id}`, advertiserName: name, countries: ['DE'],
  seenAt: '2026-01-01T00:00:00.000Z', sourceUrl: `https://example.test/${id}`, title: `Synthetic ${id}` });

async function fresh(t) {
  const db = await freshDatabase(t, 'm4sw');
  const x = await roles(t, db, ROLES);
  const extra = [];
  t.after(async () => { for (const e of extra) await e.end().catch(() => {}); });
  Object.defineProperty(x, 'db', { value: db, enumerable: false });
  Object.defineProperty(x, 'conn', { enumerable: false, value: async (user, app) => {
    const k = await connect({ user, database: db, ...(app ? { app } : {}) }); k.on('error', () => {}); extra.push(k); return k; } });
  return x;
}
async function source(x) { const s = `sw-${++n}`; await createSources(x.admin, [s], ['META', 'TIKTOK']); await recordRights(x.si_rights_admin, s, {}); return s; }
async function begin(c, src, rows) {
  const nets = [...new Set(rows.map(r => r.network))].sort(), fx = fixtureSha256(rows);
  const sha = requestSha256({ adapterId: src, evidenceKind: 'SYNTHETIC', networks: nets.length ? nets : ['META'], fixtureSha256: fx });
  return (await c.query('SELECT * FROM si.si_begin_run_scoped($1,$2,$3,$4,$5::text[],$6)', [src, `sw${++n}`, sha, 'SYNTHETIC', nets.length ? nets : ['META'], fx])).rows[0];
}
async function collect(x, src, rows, c = x.si_collector) {
  const run = await begin(c, src, rows);
  await c.query('BEGIN');
  try { await c.query('SELECT * FROM si.si_complete_run($1::uuid, $2::uuid, $3::jsonb)', [run.run_id, run.lease_token, JSON.stringify(rows)]); await c.query('COMMIT'); }
  catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
  return run.run_id;
}
async function runs(x, src, count, size, from = 0) {
  const ids = [];
  for (let r = 0; r < count; r++) ids.push(await collect(x, src, Array.from({ length: size }, (_, k) => AD(from + r * 1000 + k))));
  return ids;
}
async function replica(x, sql, params = []) {                                                   // CORRUPTION / BULK ROWS
  await x.admin.query('BEGIN');
  try { await x.admin.query('SET LOCAL session_replication_role = replica'); await x.admin.query(sql, params); await x.admin.query('COMMIT'); }
  catch (e) { await x.admin.query('ROLLBACK').catch(() => {}); throw e; }
}
const legacy = async (x, src) => (await asOwner(x.admin, a => a.query('SELECT run_id, finding FROM si.si_verify_summaries($1)', [src])))
  .rows.map(r => `${r.run_id ?? '-'}:${r.finding}`).sort();
/** The sweep's findings as recorded by its batches (summary_events after the sweep's start event). */
async function sweepFindings(x, src, sweepId) {
  return (await x.admin.query(`SELECT coalesce(e.run_id::text, '-') || ':' || e.finding AS f FROM si.summary_events e JOIN si.summary_sweeps w ON w.sweep_id = $2
                                WHERE e.source_id = $1 AND e.kind = 'DRIFT_DETECTED' AND e.event_id > w.start_event_id`, [src, sweepId])).rows.map(r => r.f).sort();
}
const sweepRow = async (x, id) => (await x.admin.query('SELECT * FROM si.summary_sweeps WHERE sweep_id = $1', [id])).rows[0];
const batchRows = async (x, id) => (await x.admin.query('SELECT * FROM si.summary_sweep_batches WHERE sweep_id = $1 ORDER BY seq', [id])).rows;
const driftOpen = async (x, src) => (await asOwner(x.admin, a => a.query('SELECT si.si_summary_drift_open($1) AS d', [src]))).rows[0].d;
const coverage = async (x, src) => (await asOwner(x.admin, a => a.query('SELECT * FROM si.si_summary_coverage($1)', [src]))).rows[0];
const status = async (x, src) => (await verificationStatus(x.si_monitor)).find(s => s.sourceId === src);
const failures = async (x, id) => (await x.admin.query('SELECT code, seq FROM si.summary_sweep_failures WHERE sweep_id = $1 ORDER BY failure_id', [id])).rows.map(r => `${r.seq}:${r.code}`);

import { ownerRecovery, pid, waitUntilBlocked } from './helpers.mjs';
import { assertProductionReady } from '../../dist/persistence/production-readiness.js';
import { checkMonitorSessionBounds } from '../../dist/persistence/preconditions.js';

const IDLE_MS = 2000, BUDGET_MS = 5000;                                         // role setting (db/bootstrap/roles.sql); SUSPEND budget M3-T14
const inSweep = async (x, id, run) => (await x.admin.query('SELECT 1 FROM si.summary_sweep_runs WHERE sweep_id = $1 AND run_id = $2', [id, run])).rowCount === 1;
async function holdPublication(x, s, rows) {                                      // LATE COMMIT: finished_at taken now, COMMIT later
  const c = await x.conn('si_collector');
  const r = await begin(c, s, rows);
  await c.query('BEGIN');
  await c.query('SELECT * FROM si.si_complete_run($1::uuid, $2::uuid, $3::jsonb)', [r.run_id, r.lease_token, JSON.stringify(rows)]);
  return { run: r.run_id, conn: c, commit: () => c.query('COMMIT') };
}
const phaseOf = async (x, id) => (await sweepRow(x, id)).phase;
/** Drift open, then a rebuild and a COMPLETED_CLEAN sweep started after it: the starting point of every clearance test. */
async function recoverable(x, nRuns = 3) {
  const s = await source(x);
  const ids = await runs(x, s, nRuns, 2);
  await replica(x, 'UPDATE si.run_summary_status SET observation_count = observation_count + 1 WHERE run_id = $1', [ids[0]]);   // CORRUPTION
  assert.equal((await verifySource(x.si_monitor, s)).state, 'COMPLETED_DRIFT');
  await asOwner(x.admin, a => a.query('SELECT si.si_rebuild_run_summaries($1)', [ids[0]]));
  return { s, ids };
}
const timed = async f => { const t0 = performance.now(); const r = await settle(f()); return { ...r, ms: performance.now() - t0 }; };
const gone = async (x, p) => (await x.admin.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [p])).rowCount === 0;

// ------------------------------------------------------------------ idle transactions vs emergency controls
test('CL-1: idle after a sweep START (KEY SHARE on the source): SUSPEND and TERMINATE_RETENTION wait at most the idle bound, inside the 5 s budget; the session is terminated; retry works', async t => {
  const x = await fresh(t); const s = await source(x);
  await runs(x, s, 2, 2);
  const out = [];
  for (const kind of ['SUSPEND', 'TERMINATE_RETENTION']) {
    const v = await x.conn('si_monitor');
    assert.equal((await v.query('SHOW idle_in_transaction_session_timeout')).rows[0].idle_in_transaction_session_timeout, '2s');
    const vp = await pid(v);
    await v.query('BEGIN');
    await v.query('SELECT * FROM si.si_summary_sweep_start($1)', [s]);          // then the client goes silent (idle in transaction)
    const r = await timed(() => control(x.si_rights_admin, s, kind));
    out.push(`${kind} ${r.status} ${r.ms.toFixed(0)} ms`);
    assert.equal(r.status, 'ok', JSON.stringify(r));
    assert.ok(r.ms >= IDLE_MS - 200 && r.ms < BUDGET_MS, `${kind} waited ${r.ms.toFixed(0)} ms (idle bound ${IDLE_MS}, budget ${BUDGET_MS})`);
    await assert.rejects(v.query('SELECT 1'), 'the idle session was terminated');
    assert.equal(await gone(x, vp), true, 'no backend left behind');
    if (kind === 'SUSPEND') await lift(x.si_rights_admin, s);
  }
  assert.equal((await x.admin.query('SELECT count(*)::int AS n FROM si.summary_sweeps WHERE source_id = $1', [s])).rows[0].n, 0, 'the idle starts rolled back');
  const r = await verifySource(x.si_monitor, s);                                  // retry through the library
  assert.equal(r.state, 'COMPLETED_CLEAN');
  console.log(`# CL-1 idle after sweep start: ${out.join('; ')}; retry ${r.state}`);
});

test('CL-2: idle after a DRIFT-recording batch: the controls wait at most the idle bound; the batch (and its drift event) rolls back; the retried batch records the drift', async t => {
  const x = await fresh(t); const s = await source(x);
  const ids = await runs(x, s, 4, 2);
  await replica(x, 'UPDATE si.run_summary_status SET observation_count = observation_count + 1 WHERE run_id = ANY ($1::uuid[])', [[ids[0], ids[2]]]);   // CORRUPTION
  const st = await startSweep(x.si_monitor, s);
  const out = [];
  for (const kind of ['SUSPEND', 'TERMINATE_RETENTION']) {
    const v = await x.conn('si_monitor'); const vp = await pid(v);
    const w = await sweepRow(x, st.sweepId);
    const events = async () => (await x.admin.query(`SELECT count(*)::int AS n FROM si.summary_events WHERE source_id = $1 AND kind = 'DRIFT_DETECTED'`, [s])).rows[0].n;
    const e0 = await events();
    await v.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const b = (await v.query('SELECT * FROM si.si_summary_sweep_batch($1, $2, 2, 5000, 1000)', [st.sweepId, w.batches + 1])).rows[0];
    assert.equal(b.outcome, 'DRIFT');
    const r = await timed(() => control(x.si_rights_admin, s, kind));
    out.push(`${kind} ${r.status} ${r.ms.toFixed(0)} ms`);
    assert.equal(r.status, 'ok', JSON.stringify(r));
    assert.ok(r.ms >= IDLE_MS - 200 && r.ms < BUDGET_MS, `${kind} waited ${r.ms.toFixed(0)} ms`);
    assert.equal(await gone(x, vp), true);
    assert.equal((await sweepRow(x, st.sweepId)).batches, w.batches, 'the idle batch rolled back');
    assert.equal(await events(), e0, 'its drift event rolled back with it');
    const retry = await runSweepBatch(x.si_monitor, st.sweepId, w.batches + 1, B(2));   // retried: the drift is recorded
    assert.equal(retry.outcome, 'DRIFT'); assert.equal(await events(), e0 + 1); assert.equal(await driftOpen(x, s), true);
    if (kind === 'SUSPEND') await lift(x.si_rights_admin, s);
  }
  console.log(`# CL-2 idle after a drift batch: ${out.join('; ')}`);
});

test('CL-3: the bounds are compatible with legitimate verification (largest budgets, 500-row runs, library and CLI pattern) and enforced by production readiness', async t => {
  const x = await fresh(t); const s = await source(x);
  for (let r = 0; r < 6; r++) await collect(x, s, Array.from({ length: 500 }, (_, k) => AD(500000 + r * 1000 + k, `Bound Co ${k % 40}`)));
  const t0 = performance.now();
  const r = await verifySource(x.si_monitor, s, { budget: { maxRuns: 200, maxObservations: 20000, maxIdentities: 5000 } });
  const ms = performance.now() - t0;
  assert.equal(r.state, 'COMPLETED_CLEAN'); assert.equal(r.failures.length, 0, 'no batch hit the idle or lock bound');
  const lat = r.batches.length;
  // readiness: the effective role configuration is checked, fail closed
  const ok = await checkMonitorSessionBounds(x.admin);
  assert.deepEqual(ok.map(c => [c.name, c.ok, c.actual]), [['si_monitor_idle_in_transaction_session_timeout', true, '2s'], ['si_monitor_lock_timeout', true, '2s']]);
  const dbName = x.db;
  const bad = async (sql, expectName) => {
    await x.admin.query(sql.replace('$DB', `"${dbName}"`));
    const c = (await checkMonitorSessionBounds(x.admin)).find(z => z.name === expectName);
    assert.equal(c.ok, false, `${sql}: ${JSON.stringify(c)}`);
    await assert.rejects(assertProductionReady(x.admin), e => new RegExp(expectName).test(e.message));
    return c.actual;
  };
  t.after(() => x.admin.query(`ALTER ROLE si_monitor IN DATABASE "${dbName}" RESET ALL`).catch(() => {}));
  const a1 = await bad(`ALTER ROLE si_monitor IN DATABASE $DB SET idle_in_transaction_session_timeout = 0`, 'si_monitor_idle_in_transaction_session_timeout');
  const a2 = await bad(`ALTER ROLE si_monitor IN DATABASE $DB SET idle_in_transaction_session_timeout = '30s'`, 'si_monitor_idle_in_transaction_session_timeout');
  await x.admin.query(`ALTER ROLE si_monitor IN DATABASE "${dbName}" RESET ALL`);
  const a3 = await bad(`ALTER ROLE si_monitor IN DATABASE $DB SET lock_timeout = '1min'`, 'si_monitor_lock_timeout');
  await x.admin.query(`ALTER ROLE si_monitor IN DATABASE "${dbName}" RESET ALL`);
  assert.ok((await checkMonitorSessionBounds(x.admin)).every(c => c.ok));
  console.log(`# CL-3 3,000 observations at the largest budgets: ${r.state} in ${lat} batches, ${ms.toFixed(0)} ms, 0 failures; readiness refuses idle ${a1} / ${a2}, lock ${a3}`);
});

// ------------------------------------------------------------------ the strengthened clearance
test('CL-4: clearance refuses a sweep under an OLD normalizer fingerprint (RV-C3 closed); a sweep under the new fingerprint is accepted', async t => {
  const x = await fresh(t);
  const { s } = await recoverable(x);
  const c = await verifySource(x.si_monitor, s); assert.equal(c.state, 'COMPLETED_CLEAN');
  const def = (await x.admin.query(`SELECT pg_get_functiondef('si.si_normalizer_fingerprint()'::regprocedure) AS d`)).rows[0].d;
  await asOwner(x.admin, a => a.query(def.replace("'v1|icu='", "'v2|icu='")));                 // NORMALIZER CHANGE
  await assert.rejects(clearDrift(x.admin, s, c.sweepId), /SI_SWEEP_STALE_FINGERPRINT/);
  assert.equal(await driftOpen(x, s), true);
  await asOwner(x.admin, a => a.query('SELECT * FROM si.si_backfill_summaries(100)'));          // re-derive under the new fingerprint
  const n = await verifySource(x.si_monitor, s); assert.equal(n.state, 'COMPLETED_CLEAN');
  await clearDrift(x.admin, s, n.sweepId);
  assert.equal(await driftOpen(x, s), false);
});

test('CL-5: LATE COMMIT of a run inside the boundary after the gap phase (RV-C1; no new identity): the sweep is still COMPLETED_CLEAN (meaning unchanged) but clearance refuses it; a new sweep verifies the run and clears', async t => {
  const x = await fresh(t);
  const { s } = await recoverable(x);
  const A = await holdPublication(x, s, [AD(81001, 'Synthetic Co 0')]);        // an existing advertiser: no new identity
  await sleep(20);
  await collect(x, s, [AD(82001, 'Boundary Late Co')]);                            // commits first: the boundary
  const c = await verifySource(x.si_monitor, s);
  assert.equal(c.state, 'COMPLETED_CLEAN');
  await A.commit();
  assert.equal(await inSweep(x, c.sweepId, A.run), false, 'never verified by this sweep');
  await assert.rejects(clearDrift(x.admin, s, c.sweepId), /SI_SWEEP_SCOPE_INCOMPLETE/);
  assert.equal(await driftOpen(x, s), true);
  const n = await verifySource(x.si_monitor, s);
  assert.equal(n.state, 'COMPLETED_CLEAN'); assert.equal(await inSweep(x, n.sweepId, A.run), true);
  await clearDrift(x.admin, s, n.sweepId);
  assert.equal(await driftOpen(x, s), false);
});

test('CL-5b: an IDENTITY inside the identity boundary that the sweep never recorded (a late commit, simulated) makes clearance refuse', async t => {
  const x = await fresh(t);
  const { s, ids } = await recoverable(x);
  const c = await verifySource(x.si_monitor, s); assert.equal(c.state, 'COMPLETED_CLEAN');
  // LATE COMMIT (simulated, superuser, replica mode): an identity with an id below the sweep's identity boundary appears after
  // the identity gap phase; its run is already verified (the run half of the check cannot see it)
  await replica(x, `INSERT INTO si.advertiser_identities (identity_id, source_id, normalizer, advertiser_key, normalized_name, first_run_id)
                    OVERRIDING SYSTEM VALUE SELECT -1, $1, si.si_normalizer_fingerprint(), sha256(convert_to('late identity co', 'UTF8')), 'late identity co', $2`, [s, ids[1]]);
  await assert.rejects(clearDrift(x.admin, s, c.sweepId), /SI_SWEEP_SCOPE_INCOMPLETE/);
  assert.equal(await driftOpen(x, s), true);
});

test('CL-6: a publication IN FLIGHT at clearance (holds the source FOR SHARE): clearance waits for its commit, then sees it and refuses; nothing commits between check and DRIFT_CLEARED', async t => {
  const x = await fresh(t);
  const { s } = await recoverable(x);
  const A = await holdPublication(x, s, [AD(83001, 'In Flight Co')]);            // in scope by key, uncommitted through the sweep
  await sleep(20);
  await collect(x, s, [AD(84001, 'Boundary In Flight Co')]);
  const c = await verifySource(x.si_monitor, s); assert.equal(c.state, 'COMPLETED_CLEAN');
  const o = await connect({ database: x.db }); t.after(() => o.end().catch(() => {})); const op = await pid(o);
  const cl = settle(clearDrift(o, s, c.sweepId));
  const blocked = await waitUntilBlocked(x.admin, op, await pid(A.conn), 1500).then(() => true, () => false);   // deterministic schedule
  await A.commit();
  const r = await cl;
  assert.equal(blocked, true, 'clearance waited for the in-flight publication (source FOR UPDATE vs FOR SHARE)');
  console.log(`# CL-6 clearance vs an in-flight in-scope publication: ${r.status} ${r.message ?? ''}`.slice(0, 200));
  assert.notEqual(r.status, 'ok'); assert.match(r.message, /SI_SWEEP_SCOPE_INCOMPLETE/);
  assert.equal(await driftOpen(x, s), true);
});

test('CL-7: clearance requires READ COMMITTED (a REPEATABLE READ snapshot taken before the lock could miss a commit)', async t => {
  const x = await fresh(t);
  const { s } = await recoverable(x);
  const c = await verifySource(x.si_monitor, s);
  await x.admin.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  await x.admin.query('SET LOCAL ROLE si_owner');
  const e = await x.admin.query('SELECT si.si_summary_clear_drift($1, $2)', [s, c.sweepId]).then(() => null, z => z);
  await x.admin.query('ROLLBACK');
  assert.match(e?.message ?? '', /SI_ISOLATION/);
  await clearDrift(x.admin, s, c.sweepId);                                         // READ COMMITTED: accepted
  assert.equal(await driftOpen(x, s), false);
});

test('CL-8: runs published AFTER the sweep boundary do not block clearance (outside its scope; publication-time trust, docs §18.1) and are verified by the next sweep', async t => {
  const x = await fresh(t);
  const { s } = await recoverable(x);
  const c = await verifySource(x.si_monitor, s);
  const after = await collect(x, s, [AD(85001, 'After Boundary Co')]);
  const ev = await clearDrift(x.admin, s, c.sweepId);
  assert.ok(ev > 0); assert.equal(await inSweep(x, c.sweepId, after), false);
  const rec = (await x.admin.query('SELECT sweep_id, cleared_by FROM si.summary_drift_clearances WHERE event_id = $1', [ev])).rows[0];
  assert.deepEqual([Number(rec.sweep_id), rec.cleared_by], [c.sweepId, cfg.adminUser], 'auditable: which sweep, which login');
  const n = await verifySource(x.si_monitor, s);
  assert.equal(n.state, 'COMPLETED_CLEAN'); assert.equal(await inSweep(x, n.sweepId, after), true);
});

test('CL-9: authorization: only the owner clears; si_monitor, collector, retention and rights roles are refused; the legacy verifier never clears', async t => {
  const x = await fresh(t);
  const { s } = await recoverable(x);
  const c = await verifySource(x.si_monitor, s);
  for (const role of ['si_monitor', 'si_collector', 'si_retention', 'si_rights_admin'])
    await assert.rejects(x[role].query('SELECT si.si_summary_clear_drift($1, $2)', [s, c.sweepId]), e => e.code === '42501', role);
  assert.deepEqual((await asOwner(x.admin, a => a.query('SELECT * FROM si.si_verify_summaries($1)', [s]))).rows, []);
  assert.equal(await driftOpen(x, s), true, 'a clean legacy pass leaves the drift open (0025)');
  await clearDrift(x.admin, s, c.sweepId);
  assert.equal(await driftOpen(x, s), false);
});

// ------------------------------------------------------------------ mutant detectors
test('NM1: a clean sweep of ANOTHER source never clears this source (even one started after its drift)', async t => {
  const x = await fresh(t);
  const { s: b } = await recoverable(x);                                           // B: drift open, rebuilt, no sweep since
  const a = await source(x); await runs(x, a, 2, 2);
  const ca = await verifySource(x.si_monitor, a);                                  // A: clean, started after every event of B
  assert.equal(ca.state, 'COMPLETED_CLEAN');
  await assert.rejects(clearDrift(x.admin, b, ca.sweepId), /SI_SWEEP_NOT_CLEAN/);
  assert.equal(await driftOpen(x, b), true);
});

test('NM2: deterministic race: a drift batch open at clearance holds the source KEY SHARE; clearance (FOR UPDATE) waits, then sees the new drift and refuses; drift stays open', async t => {
  const x = await fresh(t);
  const { s, ids } = await recoverable(x, 4);
  const c = await verifySource(x.si_monitor, s); assert.equal(c.state, 'COMPLETED_CLEAN');
  await replica(x, 'UPDATE si.run_summary_status SET observation_count = observation_count + 1 WHERE run_id = $1', [ids[1]]);   // CORRUPTION after the clean sweep
  const s2 = await startSweep(x.si_monitor, s);
  const v = await x.conn('si_monitor'); const vp = await pid(v);
  await v.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  const b = (await v.query('SELECT * FROM si.si_summary_sweep_batch($1, 1, 50, 5000, 1000)', [s2.sweepId])).rows[0];
  assert.equal(b.outcome, 'DRIFT');                                                 // DRIFT_DETECTED inserted, not committed
  const o = await connect({ database: x.db }); t.after(() => o.end().catch(() => {})); const op = await pid(o);
  const cl = settle(clearDrift(o, s, c.sweepId));
  const blocked = await waitUntilBlocked(x.admin, op, vp, 1500).then(() => true, () => false);   // the lock makes clearance wait
  await v.query('COMMIT');
  const r = await cl;
  assert.equal(blocked, true, 'clearance waited for the open drift batch (FOR UPDATE vs KEY SHARE)');
  assert.notEqual(r.status, 'ok', `clearance must not succeed: ${JSON.stringify(r)}`); assert.match(r.message, /SI_SWEEP_SUPERSEDED/);
  assert.equal(await driftOpen(x, s), true, 'the committed finding is not hidden by a clearance');
});

test('NM3: an identity committed below the identity cursor during IDENTITIES is verified by the IDENTITY_GAPS phase', async t => {
  const x = await fresh(t); const s = await source(x);
  await runs(x, s, 3, 2);
  const A = await holdPublication(x, s, [AD(86001, 'Gap Identity Late Co')]);    // its identity id is allocated now (low)
  await sleep(20);
  await collect(x, s, [AD(87001, 'Gap Identity Boundary Co')]);                    // a higher identity id, committed first
  const st = await startSweep(x.si_monitor, s);
  let seq = 0;
  while (await phaseOf(x, st.sweepId) !== 'IDENTITIES') await runSweepBatch(x.si_monitor, st.sweepId, ++seq, B(50));
  while ((await sweepRow(x, st.sweepId)).phase === 'IDENTITIES') {
    const w = await sweepRow(x, st.sweepId);
    if (w.cursor_identity_id !== null && Number(w.cursor_identity_id) >= Number(w.boundary_identity_id)) break;
    await runSweepBatch(x.si_monitor, st.sweepId, ++seq, B(50, 5000, 1));
  }
  await A.commit();                                                                  // below the identity cursor now
  let r; do { r = await runSweepBatch(x.si_monitor, st.sweepId, ++seq, B(50, 5000, 1)); } while (r.state === 'IN_PROGRESS');
  const late = (await x.admin.query(`SELECT i.identity_id FROM si.advertiser_identities i WHERE i.source_id = $1 AND i.normalized_name = 'gap identity late co'`, [s])).rows[0].identity_id;
  const rec = (await x.admin.query(`SELECT b.phase FROM si.summary_sweep_identities v JOIN si.summary_sweep_batches b ON b.sweep_id = v.sweep_id AND b.seq = v.seq
                                     WHERE v.sweep_id = $1 AND v.identity_id = $2`, [st.sweepId, late])).rows[0];
  assert.ok(Number(late) < Number((await sweepRow(x, st.sweepId)).boundary_identity_id), 'in scope');
  assert.equal(rec?.phase, 'IDENTITY_GAPS', 'verified by the identity gap phase');
});

test('NM4: the gap phase uses THIS sweep\'s records only: a run verified by an earlier sweep, corrupted since and skipped by a moved cursor, is still verified', async t => {
  const x = await fresh(t); const s = await source(x);
  const ids = await runs(x, s, 6, 2);
  assert.equal((await verifySource(x.si_monitor, s)).state, 'COMPLETED_CLEAN');     // sweep 1 records every run
  await replica(x, 'UPDATE si.run_summary_status SET observation_count = observation_count + 1 WHERE run_id = $1', [ids[2]]);   // CORRUPTION
  const st = await startSweep(x.si_monitor, s);
  await runSweepBatch(x.si_monitor, st.sweepId, 1, B(1));
  const last = (await x.admin.query('SELECT finished_at, run_id FROM si.collection_runs WHERE run_id = $1', [ids[5]])).rows[0];
  await replica(x, 'UPDATE si.summary_sweeps SET cursor_finished_at = $2, cursor_run_id = $3 WHERE sweep_id = $1', [st.sweepId, last.finished_at, last.run_id]);   // CORRUPTION: cursor skips 2..5
  const r = await verifySource(x.si_monitor, s, { budget: B(1) });
  assert.equal(r.state, 'COMPLETED_DRIFT', 'the skipped corrupt run was verified by the gap phase');
  assert.deepEqual(await sweepFindings(x, s, st.sweepId), [`${ids[2]}:STATUS_MISMATCH`]);
});

test('CL-10: 0025 down restores the exact 0024 catalog (the two function texts); up re-applies identically; down 0025 re-enables the legacy auto-clear', async t => {
  const x = await fresh(t);
  const v25 = await schemaFingerprint(x.admin);
  const ref = await freshDatabase(t, 'm4swc24', { migrate: false });
  const r = await roles(t, ref, ['admin']);
  await migrateUp(r.admin, { to: 24 });
  assert.deepEqual(await migrateDown(x.admin, { to: 24, allowDestructive: true }), [25]);
  assert.deepEqual(await schemaFingerprint(x.admin), await schemaFingerprint(r.admin));
  assert.deepEqual(await migrateUp(x.admin), [25]);
  assert.deepEqual(await schemaFingerprint(x.admin), v25);
});

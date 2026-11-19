// B-002 M4-P3.3 Phase 2 (migration 0024, docs §18): bounded, resumable, auditable summary verification sweeps.
// Real disposable PostgreSQL 16, synthetic sources, verified as si_monitor through src/persistence/summary-verification.ts.
// The reference for every finding is the legacy single-transaction si_verify_summaries (0020), run as the owner.
// Fixtures a product path cannot perform, labelled where used:
//   - CORRUPTION: the test superuser rewrites summaries / status / observations in replica mode (owner or superuser
//     tampering: outside the trust boundary, contract B) — what a sweep exists to detect.
//   - BULK ROWS: replica-mode observations added to a completed run (a run larger than the 500-row publication cap).
//   - DIGEST CHECK: advertiser_identities_digest dropped in a disposable database to plant an IDENTITY_MISMATCH.
//   - NORMALIZER CHANGE: si_normalizer_fingerprint replaced (owner) to simulate an ICU / major-version change.
//   - LATE COMMIT: a publication transaction held open across the sweep start, committed below the cursor.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { asOwner, connect, control, createSources, freshDatabase, lift, recordRights, roles, schemaFingerprint, settle } from './helpers.mjs';
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

test('SW-1: correct summaries: one sweep in bounded batches is COMPLETED_CLEAN; every run and identity recorded; nothing cleared or raised', async t => {
  const x = await fresh(t); const s = await source(x);
  const ids = await runs(x, s, 7, 20);
  assert.equal((await status(x, s)).state, 'NOT_STARTED');
  const r = await verifySource(x.si_monitor, s, { budget: B(3) });
  assert.equal(r.state, 'COMPLETED_CLEAN');
  const w = await sweepRow(x, r.sweepId);
  assert.deepEqual([w.runs_verified, Number(w.observations_verified), w.unverifiable_runs, w.drift_findings, w.scope_runs], [7, 140, 0, 0, 7]);
  assert.equal(w.identities_verified, w.scope_identities);
  assert.ok(r.batches.every(b => b.runs <= 3), 'run budget');
  assert.deepEqual((await x.admin.query('SELECT run_id FROM si.summary_sweep_runs WHERE sweep_id = $1 ORDER BY run_id', [r.sweepId])).rows.map(z => z.run_id), [...ids].sort());
  assert.deepEqual(await legacy(x, s), []);
  assert.equal(Number((await x.admin.query(`SELECT count(*) AS n FROM si.summary_events WHERE source_id = $1`, [s])).rows[0].n), 0);
  const st = await status(x, s);
  assert.deepEqual([st.state, st.driftOpen, st.summaryEligible, st.phase], ['COMPLETED_CLEAN', false, true, 'DONE']);
  assert.ok(st.lastCleanCompletedAt);
});

test('SW-2: each corruption is found with the legacy finding, durably, the source becomes ineligible, and the sweep never clears it', async t => {
  const cases = [
    ['incorrect count', async (x, r) => replica(x, 'UPDATE si.run_summary_status SET observation_count = observation_count + 1 WHERE run_id = $1', [r])],
    ['incorrect identity membership', async (x, r) => replica(x, `UPDATE si.run_advertiser_summaries SET ad_ids = ad_ids[2:] || ad_ids[1:1]
       WHERE run_id = $1 AND identity_id = (SELECT min(identity_id) FROM si.run_advertiser_summaries WHERE run_id = $1 AND cardinality(ad_ids) > 1)`, [r])],
    ['ad moved to another identity', async (x, r) => replica(x, `UPDATE si.run_advertiser_summaries s SET ad_ids = s.ad_ids || ARRAY[999999999::bigint], observations = s.observations + 1
       WHERE s.run_id = $1 AND s.identity_id = (SELECT min(identity_id) FROM si.run_advertiser_summaries WHERE run_id = $1)`, [r])],
    ['missing summary row', async (x, r) => replica(x, `DELETE FROM si.run_advertiser_summaries WHERE run_id = $1 AND identity_id = (SELECT min(identity_id) FROM si.run_advertiser_summaries WHERE run_id = $1)`, [r])],
    ['missing status', async (x, r) => replica(x, 'DELETE FROM si.run_summary_status WHERE run_id = $1', [r])],
    ['status digest forged', async (x, r) => replica(x, `UPDATE si.run_summary_status SET content_digest = sha256('forged'::bytea) WHERE run_id = $1`, [r])],
    ['extra summary row', async (x, r) => replica(x, `INSERT INTO si.run_advertiser_summaries (run_id, source_id, identity_id, network, observations, ad_ids, names)
       SELECT run_id, source_id, identity_id, 'TIKTOK', observations, ad_ids, names FROM si.run_advertiser_summaries WHERE run_id = $1 ORDER BY identity_id LIMIT 1`, [r])],
    ['observation evidence rewritten', async (x, r) => replica(x, `UPDATE si.observations SET advertiser_name = 'Tampered Name'
       WHERE run_id = $1 AND ordinal = (SELECT min(ordinal) FROM si.observations WHERE run_id = $1)`, [r])],
    ['orphan identity', async (x, r) => asOwner(x.admin, a => a.query(`INSERT INTO si.advertiser_identities (source_id, normalizer, advertiser_key, normalized_name, first_run_id)
       SELECT source_id, si.si_normalizer_fingerprint(), sha256(convert_to('orphan synthetic', 'UTF8')), 'orphan synthetic', run_id FROM si.collection_runs WHERE run_id = $1`, [r]))],
    ['identity key/name mismatch', async (x, r) => {                                           // DIGEST CHECK
      await x.admin.query('ALTER TABLE si.advertiser_identities DROP CONSTRAINT advertiser_identities_digest');
      await replica(x, `UPDATE si.advertiser_identities SET normalized_name = normalized_name || ' x' WHERE identity_id = (SELECT min(identity_id) FROM si.run_advertiser_summaries WHERE run_id = $1)`, [r]);
    }],
  ];
  for (const [name, fault] of cases) {
    const x = await fresh(t); const s = await source(x);
    const ids = await runs(x, s, 4, 6);
    await fault(x, ids[2]);
    const expected = await asOwner(x.admin, async a => {                 // the legacy answer, without letting it record anything
      await a.query('BEGIN');
      const r = (await a.query('SELECT run_id, finding FROM si.si_verify_summaries($1)', [s])).rows.map(z => `${z.run_id ?? '-'}:${z.finding}`).sort();
      await a.query('ROLLBACK'); return r;
    });
    assert.ok(expected.length > 0, `${name}: the fixture is a real corruption`);
    const r = await verifySource(x.si_monitor, s, { budget: B(2) });
    assert.equal(r.state, 'COMPLETED_DRIFT', name);
    assert.deepEqual(await sweepFindings(x, s, r.sweepId), expected, `${name}: the sweep's findings equal the legacy verification`);
    assert.equal(await driftOpen(x, s), true, name);
    assert.ok((await coverage(x, s)).reasons.includes('DRIFT'), `${name}: summary-backed reads refused (observation path)`);
    const again = await verifySource(x.si_monitor, s, { budget: B(50) });          // a later sweep finds it again; never clears
    assert.equal(again.state, 'COMPLETED_DRIFT'); assert.equal(await driftOpen(x, s), true);
    assert.equal(Number((await x.admin.query(`SELECT count(*) AS n FROM si.summary_events WHERE source_id = $1 AND kind = 'DRIFT_CLEARED'`, [s])).rows[0].n), 0);
  }
});

test('SW-3: a stale-fingerprint status is not verifiable: the sweep ends INCOMPLETE, never CLEAN; a normalizer change mid-sweep makes it STALE', async t => {
  const x = await fresh(t); const s = await source(x);
  const ids = await runs(x, s, 3, 5);
  await replica(x, `UPDATE si.run_summary_status SET normalizer = 'v0|icu=old|pg=15' WHERE run_id = $1`, [ids[1]]);
  const r = await verifySource(x.si_monitor, s, { budget: B(10) });
  assert.equal(r.state, 'INCOMPLETE');
  assert.deepEqual((await x.admin.query(`SELECT outcome FROM si.summary_sweep_runs WHERE sweep_id = $1 AND run_id = $2`, [r.sweepId, ids[1]])).rows[0].outcome, 'UNVERIFIABLE_STALE_STATUS');
  // NORMALIZER CHANGE between two batches of one sweep
  const y = await fresh(t); const s2 = await source(y);
  await runs(y, s2, 4, 3);
  const st = await startSweep(y.si_monitor, s2);
  await runSweepBatch(y.si_monitor, st.sweepId, 1, B(1));
  const def = (await y.admin.query(`SELECT pg_get_functiondef('si.si_normalizer_fingerprint()'::regprocedure) AS d`)).rows[0].d;
  await asOwner(y.admin, a => a.query(def.replace("'v1|icu='", "'v2|icu='")));
  const b = await runSweepBatch(y.si_monitor, st.sweepId, 2, B(1));
  assert.deepEqual([b.state, b.outcome], ['STALE', 'STALE']);
  const w = await sweepRow(y, st.sweepId);
  assert.deepEqual([w.state, w.stale_reason, w.runs_verified], ['STALE', 'FINGERPRINT_CHANGED', 1]);
  await assert.rejects(runSweepBatch(y.si_monitor, st.sweepId, 3, B(1)), e => e instanceof SweepBatchFailed && e.code === 'CLOSED' && e.recorded);
  const n2 = await startSweep(y.si_monitor, s2);
  assert.ok(n2.created && n2.sweepId !== st.sweepId, 'a new sweep under the new fingerprint');
});

test('SW-4a: the largest run the schema admits (500 observations: CHECK ordinal 0..499, PK (run_id, ordinal)) is verified alone at the minimum budget', async t => {
  const x = await fresh(t); const s = await source(x);
  await runs(x, s, 2, 300);
  const big = await collect(x, s, Array.from({ length: 500 }, (_, k) => AD(500000 + k, `Max Co ${k % 9}`)));
  const r = await verifySource(x.si_monitor, s, { budget: B(10, 500) });
  assert.equal(r.state, 'COMPLETED_CLEAN');
  const rows = await batchRows(x, r.sweepId);
  for (const z of rows) assert.ok(Number(z.observations) <= 500, `batch ${z.seq}: ${z.observations}`);
  const seq = (await x.admin.query('SELECT seq, observations FROM si.summary_sweep_runs WHERE sweep_id = $1 AND run_id = $2', [r.sweepId, big])).rows[0];
  assert.equal(seq.observations, 500);
  assert.equal(rows.find(z => z.seq === seq.seq).runs, 1, 'the 500-observation run fills its batch alone');
});

test('SW-4b: a run larger than the schema admits (ordinal CHECK dropped: DDL bypass) is never verified within a bounded batch: UNVERIFIABLE_OVERSIZED, explicit, INCOMPLETE', async t => {
  const x = await fresh(t); const s = await source(x);
  const ids = await runs(x, s, 3, 10);
  await x.admin.query('ALTER TABLE si.observations DROP CONSTRAINT observations_ordinal_check');               // BULK ROWS (DDL bypass)
  await replica(x, `WITH a AS (INSERT INTO si.ads (source_id, network, native_ad_id, first_run_id) SELECT $2, 'META', 'bulk-' || g, $1 FROM generate_series(1, 30000) g RETURNING ad_id)
    INSERT INTO si.observations (run_id, source_id, rights_version_id, ordinal, ad_id, network, native_ad_id, advertiser_name, countries, seen_at, source_url, content_sha256)
    SELECT $1, $2, (SELECT rights_version_id FROM si.collection_runs WHERE run_id = $1), 1000 + row_number() OVER (), a.ad_id, 'META', 'bulk-' || a.ad_id,
           'Bulk Co', ARRAY['DE'], now(), 'https://example.test/b', repeat('a', 64) FROM a`, [ids[1], s]);
  assert.ok(Number((await x.admin.query('SELECT count(*) AS n FROM si.observations WHERE run_id = $1', [ids[1]])).rows[0].n) > 20000);
  const t0 = performance.now();
  const r = await verifySource(x.si_monitor, s, { budget: B(10, 5000) });
  const ms = performance.now() - t0;
  assert.equal(r.state, 'INCOMPLETE');
  const big = (await x.admin.query('SELECT outcome, observations FROM si.summary_sweep_runs WHERE sweep_id = $1 AND run_id = $2', [r.sweepId, ids[1]])).rows[0];
  assert.deepEqual(big, { outcome: 'UNVERIFIABLE_OVERSIZED', observations: 0 });
  for (const b of await batchRows(x, r.sweepId)) assert.ok(Number(b.observations) <= 5000, `batch ${b.seq} observations ${b.observations}`);
  const w = await sweepRow(x, r.sweepId);
  assert.deepEqual([w.runs_verified, w.unverifiable_runs], [2, 1]);
  console.log(`# SW-4b sweep with a 30,010-observation run at budget 5,000: ${ms.toFixed(0)} ms, ${r.batches.length} batches`);
});

test('SW-5: many small runs and the observation budget: every batch within both budgets, cursor strictly increasing, all runs once', async t => {
  const x = await fresh(t); const s = await source(x);
  await runs(x, s, 60, 2);
  const big = await runs(x, s, 5, 400, 900000);
  const r = await verifySource(x.si_monitor, s, { budget: B(25, 1000) });
  assert.equal(r.state, 'COMPLETED_CLEAN');
  const rows = await batchRows(x, r.sweepId);
  for (const b of rows) { assert.ok(b.runs <= 25 && Number(b.observations) <= 1000, JSON.stringify(b)); }
  const keys = rows.filter(b => b.phase === 'RUNS' && b.runs > 0).map(b => `${b.cursor_finished_at.toISOString()}|${b.cursor_run_id}`);
  assert.deepEqual(keys, [...new Set(keys)].sort(), 'cursor strictly increasing');
  assert.equal(Number((await x.admin.query('SELECT count(*) AS n FROM si.summary_sweep_runs WHERE sweep_id = $1', [r.sweepId])).rows[0].n), 65);
  assert.ok(rows.filter(b => Number(b.observations) >= 800).length >= 2 && rows.every(b => !(b.runs > 2 && Number(b.observations) > 1000)));
  void big;
});

test('SW-6: publication during a sweep: runs after the boundary are outside its scope; a LATE COMMIT below the cursor is verified by the gap phase', async t => {
  const x = await fresh(t); const s = await source(x);
  await runs(x, s, 3, 2);
  const lateRows = [AD(70001, 'Late Co A'), AD(70002, 'Late Co A')];
  const late = await begin(x.si_collector, s, lateRows);                      // LATE COMMIT: finished_at taken now, committed later
  const c2 = await x.conn('si_collector');
  await x.si_collector.query('BEGIN');
  await x.si_collector.query('SELECT * FROM si.si_complete_run($1::uuid, $2::uuid, $3::jsonb)', [late.run_id, late.lease_token, JSON.stringify(lateRows)]);
  await sleep(20);
  const after = await collect(x, s, [AD(80001, 'Late Co B')], c2);            // finished later, committed first
  const st = await startSweep(x.si_monitor, s);
  for (let seq = 1; seq <= 2; seq++) await runSweepBatch(x.si_monitor, st.sweepId, seq, B(50));   // RUNS done, cursor past `late`
  await x.si_collector.query('COMMIT');
  const outside = await collect(x, s, [AD(90001, 'Late Co C')]);                            // after the boundary: excluded
  const r = await verifySource(x.si_monitor, s, { budget: B(50) });
  assert.equal(r.state, 'COMPLETED_CLEAN');
  const rec = new Map((await x.admin.query('SELECT run_id, seq FROM si.summary_sweep_runs WHERE sweep_id = $1', [st.sweepId])).rows.map(z => [z.run_id, z.seq]));
  assert.ok(rec.has(late.run_id), 'the late-committed run was verified (gap phase)');
  const gapBatch = (await batchRows(x, st.sweepId)).find(b => b.seq === rec.get(late.run_id));
  assert.equal(gapBatch.phase, 'RUN_GAPS');
  assert.ok(rec.has(after)); assert.ok(!rec.has(outside), 'a run published after the sweep started is outside its scope');
});

test('SW-7: purge during a sweep: never blocked by a batch, purged runs leave the scope without a finding; an open batch sees one snapshot', async t => {
  const x = await fresh(t); const s = await source(x);
  const ids = await runs(x, s, 6, 4);
  await replica(x, `UPDATE si.collection_runs SET retain_until = clock_timestamp() - interval '1 minute' WHERE run_id = ANY ($1::uuid[])`, [ids.slice(0, 3)]);
  const st = await startSweep(x.si_monitor, s);
  // a batch transaction open (not committed) while the purge runs
  const v = await x.conn('si_monitor');
  await v.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  await v.query('SELECT * FROM si.si_summary_sweep_batch($1, 1, 2, 5000, 1000)', [st.sweepId]);
  const ret = await x.conn('si_retention');
  const t0 = performance.now();
  const p = (await ret.query('SELECT * FROM si.si_purge_due(20)')).rows[0];
  const purgeMs = performance.now() - t0;
  assert.equal(p.outcome, 'PURGED', 'the purge did not wait for (or skip) the open batch');
  await v.query('COMMIT');
  const r = await verifySource(x.si_monitor, s, { budget: B(2) });
  assert.equal(r.state, 'COMPLETED_CLEAN', 'no false drift from purged runs');
  assert.deepEqual(await sweepFindings(x, s, st.sweepId), []);
  const rec = (await x.admin.query('SELECT run_id FROM si.summary_sweep_runs WHERE sweep_id = $1', [st.sweepId])).rows.map(z => z.run_id);
  assert.ok(rec.includes(ids[0]) && rec.includes(ids[1]), 'verified in the batch snapshot before the purge');
  assert.ok(!rec.includes(ids[2]), 'purged before its batch: out of scope');
  console.log(`# SW-7 purge while a verification batch is open: ${purgeMs.toFixed(0)} ms`);
});

test('SW-8: emergency SUSPEND / LIFT / TERMINATE_RETENTION never wait for a clean batch; a drift-recording batch delays them only until it commits', async t => {
  const x = await fresh(t); const s = await source(x);
  const ids = await runs(x, s, 6, 5);
  const st = await startSweep(x.si_monitor, s);
  const v = await x.conn('si_monitor');
  await v.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  await v.query('SELECT * FROM si.si_summary_sweep_batch($1, 1, 2, 5000, 1000)', [st.sweepId]);       // open, uncommitted, clean
  for (const kind of ['SUSPEND', 'LIFT']) {
    const t0 = performance.now();
    if (kind === 'SUSPEND') await control(x.si_rights_admin, s, 'SUSPEND'); else await lift(x.si_rights_admin, s);
    assert.ok(performance.now() - t0 < 1000, `${kind} completed while the clean batch was still open`);
  }
  await v.query('COMMIT');
  await control(x.si_rights_admin, s, 'SUSPEND');                              // verification continues on a suspended source
  assert.equal((await runSweepBatch(x.si_monitor, st.sweepId, 2, B(2))).runs, 2);
  await lift(x.si_rights_admin, s);
  // a batch that RECORDS drift holds the FK key-share on the source row until it commits: a control waits for that commit only
  await replica(x, 'UPDATE si.run_summary_status SET observation_count = observation_count + 1 WHERE run_id = $1', [ids[5]]);
  await v.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  const b3 = (await v.query('SELECT * FROM si.si_summary_sweep_batch($1, 3, 50, 5000, 1000)', [st.sweepId])).rows[0];
  assert.equal(b3.outcome, 'DRIFT');
  const t1 = performance.now(); let doneAt = 0;
  const ctl = settle(control(x.si_rights_admin, s, 'TERMINATE_RETENTION').then(r => { doneAt = performance.now(); return r; }));
  await sleep(300);
  assert.equal(doneAt, 0, 'the control waits while the drift batch is open');
  const commitAt = performance.now();
  await v.query('COMMIT');
  const res = await ctl;
  assert.equal(res.status, 'ok', JSON.stringify(res));
  assert.ok(doneAt >= commitAt && doneAt - t1 < 3000, `the control completed right after the commit (${(doneAt - t1).toFixed(0)} ms)`);
  assert.equal(await driftOpen(x, s), true);
});

test('SW-9: timeout, restart, duplicate submission, lost response: explicit failures, exact resumption, no double counting', async t => {
  const x = await fresh(t); const s = await source(x);
  await runs(x, s, 8, 30);
  const st = await startSweep(x.si_monitor, s);
  // timeout: nothing committed, failure recorded, the same seq succeeds afterwards
  await assert.rejects(runSweepBatch(x.si_monitor, st.sweepId, 1, B(8), 1), e => e instanceof SweepBatchFailed && e.code === 'TIMEOUT' && e.recorded && e.retryable);
  assert.equal((await sweepRow(x, st.sweepId)).batches, 0);
  assert.deepEqual(await failures(x, st.sweepId), ['1:TIMEOUT']);
  const b1 = await runSweepBatch(x.si_monitor, st.sweepId, 1, B(2));
  // duplicate submission / response lost after commit: the same seq replays the stored result
  const dup = await runSweepBatch(x.si_monitor, st.sweepId, 1, B(2)).catch(e => assert.fail(`a resubmitted batch must be replayed, not refused: ${e.message}`));
  assert.deepEqual({ ...dup, replayed: false }, b1); assert.equal(dup.replayed, true);
  const w1 = await sweepRow(x, st.sweepId);
  assert.deepEqual([w1.batches, w1.runs_verified], [1, 2], 'not counted twice');
  // out of order
  await assert.rejects(runSweepBatch(x.si_monitor, st.sweepId, 5, B(2)), e => e.code === 'SEQUENCE' && e.recorded);
  // verifier crash mid-batch: the backend is terminated during its batch; nothing of it commits
  const k = await x.conn('si_monitor', 'sw-crash');
  await k.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  const crashed = settle(k.query(`SELECT * FROM si.si_summary_sweep_batch($1, 2, 2, 5000, 1000), pg_sleep(5)`, [st.sweepId]));
  await sleep(200);
  await x.admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'sw-crash'`);
  assert.equal((await crashed).status, 'terminated');
  assert.equal((await sweepRow(x, st.sweepId)).batches, 1);
  // a NEW verifier process resumes from the database's own position
  const fresh2 = await x.conn('si_monitor');
  const r = await verifySource(fresh2, s, { budget: B(2) });
  assert.equal(r.sweepId, st.sweepId); assert.equal(r.state, 'COMPLETED_CLEAN');
  const w = await sweepRow(x, st.sweepId);
  assert.deepEqual([w.runs_verified, Number(w.observations_verified)], [8, 240]);
  const seqs = (await batchRows(x, st.sweepId)).map(b => b.seq);
  assert.deepEqual(seqs, Array.from({ length: seqs.length }, (_, i) => i + 1), 'contiguous batches');
});

test('SW-10: a conflicting verifier: one sweep per source; concurrent batches of a sweep are BUSY, never interleaved', async t => {
  const x = await fresh(t); const s = await source(x);
  await runs(x, s, 4, 3);
  const a = await startSweep(x.si_monitor, s);
  const other = await x.conn('si_monitor');
  const b = await startSweep(other, s);
  assert.deepEqual([b.sweepId, b.created], [a.sweepId, false]);
  await assert.rejects(x.admin.query(`INSERT INTO si.summary_sweeps (source_id, normalizer, start_event_id, scope_runs, scope_identities)
    VALUES ($1, si.si_normalizer_fingerprint(), 0, 0, 0)`, [s]), e => e.code === '23505', 'a second IN_PROGRESS sweep is refused by the database');
  const v = await x.conn('si_monitor');
  await v.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  await v.query('SELECT * FROM si.si_summary_sweep_batch($1, 1, 1, 5000, 1000)', [a.sweepId]);
  const tb = performance.now();
  await assert.rejects(runSweepBatch(other, a.sweepId, 2, B(1)), e => e.code === 'BUSY' && e.recorded);
  assert.ok(performance.now() - tb < 500, 'BUSY at once (NOWAIT), not after a lock wait');
  await assert.rejects(runSweepBatch(other, a.sweepId, 1, B(1)), e => e.code === 'BUSY');
  await v.query('COMMIT');
  assert.equal((await runSweepBatch(other, a.sweepId, 2, B(1))).replayed, false);
  await assert.rejects(x.admin.query('SELECT * FROM si.si_summary_sweep_batch($1, 3, 1, 5000, 1000)', [a.sweepId]), /SI_ISOLATION/, 'READ COMMITTED is refused');
});

test('SW-11: cursor corruption is refused by the state machine; a cursor moved forward anyway (trigger disabled) is caught by the gap phase', async t => {
  const x = await fresh(t); const s = await source(x);
  const ids = await runs(x, s, 6, 3);
  const st = await startSweep(x.si_monitor, s);
  await runSweepBatch(x.si_monitor, st.sweepId, 1, B(1));
  const last = (await x.admin.query(`SELECT finished_at, run_id FROM si.collection_runs WHERE run_id = $1`, [ids[4]])).rows[0];
  await assert.rejects(asOwner(x.admin, a => a.query('UPDATE si.summary_sweeps SET cursor_finished_at = $2, cursor_run_id = $3 WHERE sweep_id = $1',
    [st.sweepId, last.finished_at, last.run_id])), /SI_SWEEP_TRANSITION/);
  await assert.rejects(asOwner(x.admin, a => a.query('UPDATE si.summary_sweeps SET batches = batches + 1, cursor_finished_at = $2, cursor_run_id = $3 WHERE sweep_id = $1',
    [st.sweepId, last.finished_at, last.run_id])), /SI_SWEEP_TRANSITION: sweep \d+ does not match its batch/, 'an advance without its batch record');
  for (const sql of ['DELETE FROM si.summary_sweeps WHERE sweep_id = $1', 'DELETE FROM si.summary_sweep_batches WHERE sweep_id = $1',
                     'DELETE FROM si.summary_sweep_runs WHERE sweep_id = $1', 'UPDATE si.summary_sweep_batches SET runs = 0 WHERE sweep_id = $1'])
    await assert.rejects(asOwner(x.admin, a => a.query(sql, [st.sweepId])), /SI_SWEEP_TRANSITION|SI_VERIFICATION_APPEND_ONLY/, sql);
  await assert.rejects(asOwner(x.admin, a => a.query(`UPDATE si.summary_sweeps SET state = 'COMPLETED_CLEAN', phase = 'DONE', completed_at = now() WHERE sweep_id = $1`, [st.sweepId])), /SI_SWEEP_TRANSITION/);
  // CORRUPTION: the transition trigger disabled by the superuser, the cursor skips runs 2..5, and one of them is corrupt
  await replica(x, 'UPDATE si.run_summary_status SET observation_count = observation_count + 1 WHERE run_id = $1', [ids[2]]);
  await replica(x, 'UPDATE si.summary_sweeps SET cursor_finished_at = $2, cursor_run_id = $3 WHERE sweep_id = $1', [st.sweepId, last.finished_at, last.run_id]);
  const r = await verifySource(x.si_monitor, s, { budget: B(1) });
  assert.equal(r.state, 'COMPLETED_DRIFT', 'the skipped corrupt run was verified anyway');
  assert.deepEqual(await sweepFindings(x, s, st.sweepId), [`${ids[2]}:STATUS_MISMATCH`]);
  assert.equal(Number((await x.admin.query('SELECT count(*) AS n FROM si.summary_sweep_runs WHERE sweep_id = $1', [st.sweepId])).rows[0].n), 6);
});

test('SW-12: partial and stale sweeps prove nothing; abandoned sweeps expire; a terminal sweep is final', async t => {
  const x = await fresh(t); const s = await source(x);
  await runs(x, s, 5, 2);
  const st = await startSweep(x.si_monitor, s);
  await runSweepBatch(x.si_monitor, st.sweepId, 1, B(1));
  const p = await status(x, s);
  assert.deepEqual([p.state, p.batches, p.runsVerified, p.lastCleanCompletedAt], ['IN_PROGRESS', 1, 1, null]);
  await x.admin.query(`INSERT INTO si.summary_events (source_id, kind, finding) VALUES ($1, 'DRIFT_DETECTED', 'MISSING')`, [s]);
  await assert.rejects(clearDrift(x.admin, s, st.sweepId), /SI_SWEEP_NOT_CLEAN/, 'a partial sweep cannot justify clearance');
  await replica(x, `UPDATE si.summary_sweeps SET last_batch_at = now() - interval '7 hours', started_at = now() - interval '8 hours' WHERE sweep_id = $1`, [st.sweepId]);
  assert.equal(Number((await x.si_monitor.query(`SELECT si.si_summary_sweep_expire(interval '6 hours') AS k`)).rows[0].k), 1);
  assert.deepEqual([(await sweepRow(x, st.sweepId)).state, (await sweepRow(x, st.sweepId)).stale_reason], ['STALE', 'ABANDONED']);
  await assert.rejects(runSweepBatch(x.si_monitor, st.sweepId, 2, B(1)), e => e.code === 'CLOSED');
  await assert.rejects(clearDrift(x.admin, s, st.sweepId), /SI_SWEEP_NOT_CLEAN/);
  const n2 = await startSweep(x.si_monitor, s);
  assert.ok(n2.created);
});

test('SW-13: least privilege: si_monitor runs sweeps only; no table, summary, observation, rebuild, legacy-verify or clearance access; other roles nothing', async t => {
  const x = await fresh(t); const s = await source(x);
  await runs(x, s, 2, 2);
  const r = await verifySource(x.si_monitor, s);
  assert.equal(r.state, 'COMPLETED_CLEAN');
  const denied = async (c, sql, params = []) => assert.rejects(c.query(sql, params), e => e.code === '42501', sql);
  for (const sql of ['SELECT 1 FROM si.summary_sweeps', 'SELECT 1 FROM si.summary_sweep_runs', 'SELECT 1 FROM si.run_advertiser_summaries',
                     'SELECT 1 FROM si.observations', 'SELECT 1 FROM si.advertiser_identities', 'SELECT 1 FROM si.summary_events',
                     `INSERT INTO si.summary_events (source_id, kind) VALUES ('${s}', 'DRIFT_CLEARED')`, `UPDATE si.summary_sweeps SET batches = 0`,
                     `SELECT * FROM si.si_verify_summaries('${s}')`, `SELECT si.si_summary_clear_drift('${s}', ${r.sweepId})`,
                     `SELECT si.si_rebuild_run_summaries(gen_random_uuid())`, `SELECT * FROM si.si_summary_content(gen_random_uuid())`,
                     'CREATE TABLE si.x (a int)', 'SET ROLE si_owner'])
    await assert.rejects(x.si_monitor.query(sql), e => ['42501', '22023'].includes(e.code), `si_monitor: ${sql}`);
  for (const role of ['si_collector', 'si_retention', 'si_rights_admin']) {
    for (const sql of [`SELECT * FROM si.si_summary_sweep_start('${s}')`, `SELECT * FROM si.si_summary_verification_status()`,
                       `SELECT si.si_summary_sweep_record_failure(${r.sweepId}, 1, 'ERROR', NULL)`, `SELECT si.si_summary_sweep_expire()`])
      await denied(x[role], sql);
  }
  const rows = (await x.si_monitor.query('SELECT * FROM si.si_summary_verification_status()')).rows;
  assert.ok(rows.every(z => Object.keys(z).every(k => !/name|title|url|query/.test(k))), 'content-free status');
  const rec = (await x.admin.query('SELECT recorded_by FROM si.summary_sweep_batches WHERE sweep_id = $1', [r.sweepId])).rows;
  assert.ok(rec.length && rec.every(z => z.recorded_by === 'si_monitor'), 'the actor is recorded');
  assert.equal((await sweepRow(x, r.sweepId)).started_by, 'si_monitor');
});

test('SW-14: drift clearance needs the owner AND a clean sweep started after the last drift and rebuild; a clean batch never clears', async t => {
  const x = await fresh(t); const s = await source(x);
  const ids = await runs(x, s, 3, 4);
  const c0 = await verifySource(x.si_monitor, s);                                // clean, BEFORE the drift
  await replica(x, 'UPDATE si.run_summary_status SET observation_count = observation_count + 1 WHERE run_id = $1', [ids[0]]);
  const d = await verifySource(x.si_monitor, s);
  assert.equal(d.state, 'COMPLETED_DRIFT');
  await assert.rejects(clearDrift(x.admin, s, c0.sweepId), /SI_SWEEP_SUPERSEDED/, 'a clean sweep from before the drift');
  await assert.rejects(clearDrift(x.admin, s, d.sweepId), /SI_SWEEP_NOT_CLEAN/);
  await assert.rejects(x.si_monitor.query('SELECT si.si_summary_clear_drift($1, $2)', [s, d.sweepId]), e => e.code === '42501', 'the monitor cannot clear');
  // recovery: rebuild under the open drift, then a NEW clean sweep, then the owner clears
  await asOwner(x.admin, a => a.query('SELECT si.si_rebuild_run_summaries($1)', [ids[0]]));
  const c1 = await verifySource(x.si_monitor, s);
  assert.equal(c1.state, 'COMPLETED_CLEAN');
  assert.equal(await driftOpen(x, s), true, 'a clean sweep does not clear drift by itself');
  assert.deepEqual((await coverage(x, s)).reasons, ['DRIFT']);
  await asOwner(x.admin, a => a.query('SELECT si.si_rebuild_run_summaries($1)', [ids[1]]));       // a rebuild after c1 started
  await assert.rejects(clearDrift(x.admin, s, c1.sweepId), /SI_SWEEP_SUPERSEDED/);
  const c2 = await verifySource(x.si_monitor, s);
  const ev = await clearDrift(x.admin, s, c2.sweepId);
  assert.equal(await driftOpen(x, s), false);
  assert.equal((await coverage(x, s)).eligible, true);
  const who = (await x.admin.query('SELECT session_user AS u')).rows[0].u;
  assert.deepEqual((await x.admin.query('SELECT source_id, sweep_id, cleared_by FROM si.summary_drift_clearances WHERE event_id = $1', [ev])).rows[0],
                   { source_id: s, sweep_id: String(c2.sweepId), cleared_by: who }, 'the clearance and its actor are recorded');
  await assert.rejects(clearDrift(x.admin, s, c2.sweepId), /SI_SUMMARY_NO_DRIFT/);
});

test('SW-15: 0025 and 0024 down restore the exact 0023 catalog; up re-applies identically', async t => {
  const x = await fresh(t);
  const v24 = await schemaFingerprint(x.admin);
  const ref = await freshDatabase(t, 'm4sw23', { migrate: false });
  const r = await roles(t, ref, ['admin']);
  await migrateUp(r.admin, { to: 23 });
  assert.deepEqual(await migrateDown(x.admin, { to: 23, allowDestructive: true }), [26, 25, 24]);
  assert.deepEqual(await schemaFingerprint(x.admin), await schemaFingerprint(r.admin));
  assert.deepEqual(await migrateUp(x.admin), [24, 25, 26]);
  assert.deepEqual(await schemaFingerprint(x.admin), v24);
});

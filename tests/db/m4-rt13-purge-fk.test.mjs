// B-002 M4-P3.1-RT13-01 (migration 0022): the emergency-purge latency defect of RT-13 and its fix. Real disposable
// PostgreSQL 16, synthetic sources only. Docs b002-m4-intelligence.md §15C.
//
// Defect: each identity deleted by si_purge_due fires the ON DELETE RESTRICT check of observations_ad. Without a
// supporting index, a never-analyzed si.observations made that check a bitmap over every index entry of the source
// (observations_by_source_advertiser_key), i.e. O(source) per deleted ad and 1e8 index tuples for a maximum batch.
// The detector is STRUCTURAL and size-independent: the index tuples the purge transaction read on si.observations
// (pg_stat_get_xact_tuples_returned, the purge's own transaction) must be linear in the rows it deleted. Elapsed time
// is also checked against the unchanged RT-13 bound (5 s) but is not the detector: a slow path can be under 5 s on a
// fast host, and a fast path over it on a starved one.
//
// Statistics modes (each made deterministic: autovacuum is disabled on the si tables of the test database first):
//   cold   never analyzed (reltuples 0 from the vacuumed template, no pg_stats rows): the RT-13 slow path
//   warm   ANALYZE after loading
//   stale  ANALYZE after the first run only, then 19 more runs loaded
// Fixture time travel (age) is the superuser UPDATE under session_replication_role = replica of m3-retention.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { connect, control, createSources, freshDatabase, pid, recordRights, roles, settle } from './helpers.mjs';
import { fixtureSha256, requestSha256 } from '../../dist/persistence/request-hash.js';
import { MAX_PURGE_RUNS } from '../../dist/persistence/retention.js';

const BOUND_MS = 5000;                     // RT-13 / M3-T14: maximum purge batch and emergency-control wait (unchanged)
const PER_ROW = 5;                         // index tuples per deleted observation allowed on si.observations (measured: 4)
const MAX_OBS = MAX_PURGE_RUNS * 500;
const ROW = (id, title = 't'.repeat(900)) => ({ network: 'META', nativeAdId: id, advertiserName: 'Synthetic Co', countries: ['DE'],
  seenAt: '2026-01-01T00:00:00.000Z', sourceUrl: 'https://example.test/a', title });
let n = 0;

async function fresh(t, prefix = 'm4rt13') {
  const db = await freshDatabase(t, prefix);
  const x = await roles(t, db, ['admin', 'si_rights_admin', 'si_collector', 'si_retention', 'si_monitor']);
  const extra = [];
  t.after(async () => { for (const e of extra) await e.end().catch(() => {}); });
  Object.defineProperty(x, 'db', { value: db });
  Object.defineProperty(x, 'connect', { value: async user => { const k = await connect({ user, database: db }); extra.push(k); return k; } });
  // Deterministic statistics: nothing analyzes behind the test's back.
  for (const { r } of (await x.admin.query(`SELECT c.oid::regclass::text AS r FROM pg_class c
                                              WHERE c.relnamespace = 'si'::regnamespace AND c.relkind = 'r'`)).rows)
    await x.admin.query(`ALTER TABLE ${r} SET (autovacuum_enabled = off)`);
  return x;
}
async function source(x) {
  const id = `rt13-${++n}`;
  await createSources(x.admin, [id], ['META', 'TIKTOK']);
  await recordRights(x.si_rights_admin, id, {});
  return id;
}
async function collect(c, src, rows) {
  const fx = fixtureSha256(rows), key = `rk${++n}`;
  const sha = requestSha256({ adapterId: src, evidenceKind: 'SYNTHETIC', networks: ['META'], fixtureSha256: fx });
  const run = (await c.query('SELECT * FROM si.si_begin_run_scoped($1,$2,$3,$4,$5::text[],$6)', [src, key, sha, 'SYNTHETIC', ['META'], fx])).rows[0];
  assert.equal(run.outcome, 'RUNNING');
  await c.query('BEGIN');
  try {
    const r = (await c.query('SELECT * FROM si.si_complete_run($1::uuid, $2::uuid, $3::jsonb)', [run.run_id, run.lease_token, JSON.stringify(rows)])).rows[0];
    await c.query('COMMIT');
    assert.equal(r.outcome, 'COMPLETED');
    return run.run_id;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
}
async function age(x, ids) {
  await x.admin.query('BEGIN');
  await x.admin.query('SET LOCAL session_replication_role = replica');
  await x.admin.query(`UPDATE si.collection_runs SET retain_until = clock_timestamp() - interval '10 minutes' WHERE run_id = ANY ($1::uuid[])`, [ids]);
  await x.admin.query('COMMIT');
}
/** A maximum purge batch for a new source: MAX_PURGE_RUNS runs x 500 distinct identities, aged. `ids` overrides the
 *  native ids (a bystander source can reuse them). mode 'stale' analyzes after the first run. */
async function loaded(x, { mode = 'cold', tag = randomBytes(3).toString('hex'), runs = MAX_PURGE_RUNS, due = true } = {}) {
  const src = await source(x), ids = [];
  for (let i = 0; i < runs; i++) {
    ids.push(await collect(x.si_collector, src, Array.from({ length: 500 }, (_, k) => ROW(`${tag}${i}-${k}`))));
    if (mode === 'stale' && i === 0) await x.admin.query('ANALYZE si.observations; ANALYZE si.ads');
  }
  if (due) await age(x, ids);
  return { src, ids, tag };
}
async function statsOf(x) {
  return (await x.admin.query(`SELECT c.reltuples::int AS reltuples,
                                      (SELECT count(*)::int FROM pg_stats s WHERE s.schemaname = 'si' AND s.tablename = 'observations') AS cols
                                 FROM pg_class c WHERE c.oid = 'si.observations'::regclass`)).rows[0];
}
/** One si_purge_due call in its own transaction on `c`; returns the result row, elapsed ms and the index tuples that
 *  transaction read on si.observations, per index. */
async function measuredPurge(c, limit = MAX_PURGE_RUNS) {
  await c.query('BEGIN');
  try {
    const t0 = performance.now();
    const r = (await c.query('SELECT * FROM si.si_purge_due($1)', [limit])).rows[0];
    const ms = performance.now() - t0;
    const ix = Object.fromEntries((await c.query(`SELECT i.indexrelid::regclass::text AS ix, pg_stat_get_xact_tuples_returned(i.indexrelid)::bigint AS n
                                                    FROM pg_index i WHERE i.indrelid = 'si.observations'::regclass`)).rows.map(z => [z.ix, Number(z.n)]));
    await c.query('COMMIT');
    return { r, ms, ix, reads: Object.values(ix).reduce((a, b) => a + b, 0) };
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
}
/** Content of a source's evidence and identities (digest) — for isolation and rollback checks. */
async function digest(x, src) {
  return (await x.admin.query(`SELECT
      (SELECT count(*)::int FROM si.observations o WHERE o.source_id = $1) AS obs,
      (SELECT count(*)::int FROM si.ads a WHERE a.source_id = $1) AS ads,
      (SELECT md5(coalesce(string_agg(o.run_id::text || o.ordinal || o.ad_id || o.content_sha256, ',' ORDER BY o.run_id, o.ordinal), '')) FROM si.observations o WHERE o.source_id = $1) AS o_md5,
      (SELECT md5(coalesce(string_agg(a.ad_id || a.network || a.native_ad_id, ',' ORDER BY a.ad_id), '')) FROM si.ads a WHERE a.source_id = $1) AS a_md5,
      (SELECT string_agg(r.retention_state, ',' ORDER BY r.run_id) FROM si.collection_runs r WHERE r.source_id = $1) AS states,
      (SELECT count(*)::int FROM si.purge_log p WHERE p.source_id = $1) AS logs`, [src])).rows[0];
}
/** Global evidence invariants (as m3-retention) plus FK consistency (no observation without its identity). */
async function invariants(x) {
  const r = (await x.admin.query(`
    SELECT (SELECT count(*)::int FROM si.collection_runs r WHERE r.retention_state = 'RETAINED'
              AND r.published_count <> (SELECT count(*) FROM si.observations o WHERE o.run_id = r.run_id)) AS retained_mismatch,
           (SELECT count(*)::int FROM si.collection_runs r WHERE r.retention_state = 'PURGED'
              AND EXISTS (SELECT 1 FROM si.observations o WHERE o.run_id = r.run_id)) AS purged_with_evidence,
           (SELECT count(*)::int FROM si.ads a WHERE NOT EXISTS (SELECT 1 FROM si.observations o WHERE o.ad_id = a.ad_id)) AS orphans,
           (SELECT count(*)::int FROM si.observations o WHERE NOT EXISTS (SELECT 1 FROM si.ads a WHERE a.ad_id = o.ad_id
              AND a.source_id = o.source_id AND a.network = o.network AND a.native_ad_id = o.native_ad_id)) AS dangling,
           (SELECT count(*)::int FROM si.collection_runs r WHERE r.retention_state = 'PURGED'
              AND NOT EXISTS (SELECT 1 FROM si.purge_log p WHERE p.run_id = r.run_id)) AS purged_unlogged,
           (SELECT count(*)::int FROM pg_constraint c WHERE c.connamespace = 'si'::regnamespace AND c.contype = 'f' AND NOT c.convalidated) AS fk_not_valid`)).rows[0];
  assert.deepEqual(r, { retained_mismatch: 0, purged_with_evidence: 0, orphans: 0, dangling: 0, purged_unlogged: 0, fk_not_valid: 0 });
}
function expectPurged(p, runs = MAX_PURGE_RUNS) {
  assert.deepEqual([p.r.outcome, p.r.runs_purged, p.r.observations_purged, p.r.identities_purged], ['PURGED', runs, runs * 500, runs * 500]);
}
function linear(p, label) {
  assert.ok(p.reads <= PER_ROW * p.r.observations_purged,
    `${label}: the purge read ${p.reads} index tuples on si.observations for ${p.r.observations_purged} deleted rows ` +
    `(bound ${PER_ROW}/row; per index ${JSON.stringify(p.ix)})`);
}

test('PF-0: observations_ad has a supporting index whose key is exactly the FK key, valid and ready', async t => {
  const x = await fresh(t);
  const r = (await x.admin.query(`
    SELECT x.indexrelid::regclass::text AS ix, x.indisvalid, x.indisready, x.indpred IS NULL AS total, am.amname,
           (SELECT array_agg(a.attname ORDER BY u.i) FROM unnest(x.indkey::int2[]) WITH ORDINALITY u(n, i)
              JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = u.n)::text[] AS cols
      FROM pg_index x JOIN pg_class ic ON ic.oid = x.indexrelid JOIN pg_am am ON am.oid = ic.relam
     WHERE x.indrelid = 'si.observations'::regclass AND x.indnkeyatts = 4
       AND (x.indkey::int2[])[0:3] = (SELECT c.conkey FROM pg_constraint c WHERE c.conname = 'observations_ad' AND c.conrelid = 'si.observations'::regclass)`)).rows;
  assert.deepEqual(r, [{ ix: 'si.observations_by_ad_fk', indisvalid: true, indisready: true, total: true, amname: 'btree',
                         cols: ['ad_id', 'source_id', 'network', 'native_ad_id'] }]);
  const fk = (await x.admin.query(`SELECT pg_get_constraintdef(oid) AS d, convalidated FROM pg_constraint WHERE conname = 'observations_ad'`)).rows;
  assert.deepEqual(fk, [{ d: 'FOREIGN KEY (ad_id, source_id, network, native_ad_id) REFERENCES si.ads(ad_id, source_id, network, native_ad_id) ON DELETE RESTRICT',
                          convalidated: true }], 'the FK and its RESTRICT action are unchanged');
});

for (const mode of ['cold', 'warm', 'stale']) {
  test(`PF-1 (${mode} statistics): a maximum purge batch reads O(rows) index tuples and stays within the RT-13 bound; other sources untouched`, async t => {
    const x = await fresh(t);
    // A bystander source with the SAME native ad ids (distinct identities: the FK key includes source_id), not due.
    const { src, tag } = await loaded(x, { mode });
    const by = await loaded(x, { mode: 'none', tag, runs: 2, due: false });
    if (mode === 'warm') await x.admin.query('ANALYZE si.observations; ANALYZE si.ads');
    const st = await statsOf(x);
    if (mode === 'cold') assert.deepEqual(st, { reltuples: 0, cols: 0 }, 'precondition: si.observations was never analyzed (the RT-13 slow path)');
    else assert.ok(st.cols > 0, 'precondition: si.observations has statistics');
    const before = await digest(x, by.src);
    const p = await measuredPurge(x.si_retention);
    console.log(`# PF-1 ${mode}: purge ${p.ms.toFixed(0)} ms, index tuples read ${p.reads} ${JSON.stringify(p.ix)}; stats ${JSON.stringify(st)}`);
    expectPurged(p);
    linear(p, mode);
    assert.ok(p.ms <= BOUND_MS, `${mode}: maximum purge batch ${p.ms.toFixed(0)} ms <= ${BOUND_MS} ms`);
    assert.deepEqual(await digest(x, by.src), before, 'the bystander source (same native ids) is byte-identical');
    const after = await digest(x, src);
    assert.deepEqual([after.obs, after.ads, after.logs], [0, 0, MAX_PURGE_RUNS]);
    await invariants(x);
  });
}

test('PF-B (deliberate break, in-suite control): without the 0022 index the cold purge is quadratic and PF-1 detects it', async t => {
  const x = await fresh(t);
  await x.admin.query('SET ROLE si_owner; DROP INDEX si.observations_by_ad_fk; RESET ROLE');
  await loaded(x, { mode: 'cold' });
  assert.deepEqual(await statsOf(x), { reltuples: 0, cols: 0 });
  const p = await measuredPurge(x.si_retention);
  console.log(`# PF-B broken: purge ${p.ms.toFixed(0)} ms, index tuples read ${p.reads} ${JSON.stringify(p.ix)}`);
  expectPurged(p);
  // The defect: every RESTRICT lookup scans every index entry of the source (10,000 x 10,000).
  assert.ok(p.ix['si.observations_by_source_advertiser_key'] >= MAX_OBS * MAX_OBS / 2, 'the broken plan is reproduced');
  assert.throws(() => linear(p, 'broken'), /index tuples on si.observations/, 'the PF-1 detector fails on the broken schema');
  await invariants(x);                                                       // slow, not incorrect
});

test('PF-2 (rollback): a cold maximum purge rolled back leaves evidence, identities, states and audit exactly as before; a retry purges', async t => {
  const x = await fresh(t);
  const { src } = await loaded(x);
  const before = await digest(x, src);
  await x.si_retention.query('BEGIN');
  const r = (await x.si_retention.query('SELECT * FROM si.si_purge_due($1)', [MAX_PURGE_RUNS])).rows[0];
  assert.equal(r.identities_purged, MAX_OBS);
  await x.si_retention.query('ROLLBACK');
  assert.deepEqual(await digest(x, src), before, 'atomic: nothing of the purge survives its rollback');
  await invariants(x);
  const p = await measuredPurge(x.si_retention);
  expectPurged(p); linear(p, 'retry');
  await invariants(x);
});

test('PF-3 (partial failure): a failure after the identities are deleted (audit insert) aborts the whole purge', async t => {
  const x = await fresh(t);
  const { src } = await loaded(x);
  const before = await digest(x, src);
  // Superuser fault injection in this disposable database: the audit insert (the purge's last write) fails.
  await x.admin.query(`CREATE FUNCTION public.rt13_fail() RETURNS trigger LANGUAGE plpgsql AS $f$
                         BEGIN RAISE EXCEPTION 'RT13_INJECTED_FAILURE' USING ERRCODE = 'P0001'; END $f$`);
  await x.admin.query('CREATE TRIGGER rt13_fail BEFORE INSERT ON si.purge_log FOR EACH STATEMENT EXECUTE FUNCTION public.rt13_fail()');
  await assert.rejects(x.si_retention.query('SELECT * FROM si.si_purge_due($1)', [MAX_PURGE_RUNS]), /RT13_INJECTED_FAILURE/);
  assert.deepEqual(await digest(x, src), before, 'no observation, identity, state or audit row changed');
  await invariants(x);
  await x.admin.query('DROP TRIGGER rt13_fail ON si.purge_log; DROP FUNCTION public.rt13_fail()');
  const p = await measuredPurge(x.si_retention);
  expectPurged(p); linear(p, 'after the failure');
  await invariants(x);
});

test('PF-4 (contention): concurrent cold maximum purges of two sources, a collector on a third source, and SUSPEND / TERMINATE_RETENTION during each purge', async t => {
  const x = await fresh(t);
  const A = await loaded(x), B = await loaded(x), C = await source(x);
  assert.deepEqual(await statsOf(x), { reltuples: 0, cols: 0 });
  const [ra, rb] = [await x.connect('si_retention'), await x.connect('si_retention')];
  const [ca, cb] = [await x.connect('si_rights_admin'), await x.connect('si_rights_admin')];
  const col = await x.connect('si_collector');
  const pids = { ra: await pid(ra), rb: await pid(rb), ca: await pid(ca), cb: await pid(cb), col: await pid(col) };
  const blockers = new Map();
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      for (const { p, b } of (await x.admin.query('SELECT pid AS p, pg_blocking_pids(pid) AS b FROM pg_stat_activity WHERE pid = ANY ($1)', [Object.values(pids)])).rows)
        for (const q of b) { const k = `${Object.keys(pids).find(z => pids[z] === p)}<-${Object.keys(pids).find(z => pids[z] === q) ?? 'other'}`; blockers.set(k, (blockers.get(k) ?? 0) + 1); }
      await sleep(5);
    }
  })();
  const purgeA = measuredPurge(ra), purgeB = measuredPurge(rb);
  for (const c of [ra, rb]) for (let i = 0; ; i++) {
    if ((await x.admin.query(`SELECT state FROM pg_stat_activity WHERE pid = $1`, [await pidOf(c)])).rows[0]?.state === 'active') break;
    assert.ok(i < 500, 'purge started'); await sleep(2);
  }
  await sleep(30);
  const timed = (c, s, k) => { const t0 = performance.now(); return settle(control(c, s, k).then(() => performance.now() - t0)); };
  const collector = (async () => { const t0 = performance.now(); await collect(col, C, Array.from({ length: 500 }, (_, k) => ROW(`c-${k}`))); return performance.now() - t0; })();
  const [wa, wb] = await Promise.all([timed(ca, A.src, 'SUSPEND'), timed(cb, B.src, 'TERMINATE_RETENTION')]);
  const [pa, pb, cms] = await Promise.all([purgeA, purgeB, collector]);
  sampling = false; await sampler;
  console.log(`# PF-4: purge ra ${pa.ms.toFixed(0)} ms (reads ${pa.reads}), purge rb ${pb.ms.toFixed(0)} ms (reads ${pb.reads}); SUSPEND wait ${wa.value?.toFixed(0)} ms, ` +
              `TERMINATE wait ${wb.value?.toFixed(0)} ms; collector on C ${cms.toFixed(0)} ms; blocking samples ${JSON.stringify(Object.fromEntries(blockers))}`);
  assert.deepEqual([wa.status, wb.status], ['ok', 'ok']);
  for (const [p, l] of [[pa, 'ra'], [pb, 'rb']]) { expectPurged(p); linear(p, l); assert.ok(p.ms <= BOUND_MS, `purge ${l} ${p.ms.toFixed(0)} ms <= ${BOUND_MS}`); }
  for (const w of [wa, wb]) assert.ok(w.value <= BOUND_MS, `emergency-control wait ${w.value.toFixed(0)} ms <= ${BOUND_MS}`);
  assert.ok(!blockers.has('ra<-rb') && !blockers.has('rb<-ra'), 'purges of different sources never block each other (source isolation)');
  assert.ok(!blockers.has('col<-ra') && !blockers.has('col<-rb'), 'a collector on another source is not blocked by a purge');
  // si_purge_due picks the due source itself (SKIP LOCKED): map each session to the source it actually purged. A control
  // may wait only for the purge of ITS source.
  assert.deepEqual([pa.r.purged_source, pb.r.purged_source].sort(), [A.src, B.src].sort(), 'each source purged exactly once');
  const holder = { [pa.r.purged_source]: 'ra', [pb.r.purged_source]: 'rb' };
  for (const [c, s] of [['ca', A.src], ['cb', B.src]])
    for (const k of blockers.keys()) if (k.startsWith(`${c}<-`)) assert.equal(k, `${c}<-${holder[s]}`, `${c} waits only for the purge of its own source`);
  assert.equal((await digest(x, C)).obs, 500, 'the concurrent collection is intact');
  const ctl = (await x.admin.query(`SELECT source_id, kind FROM si.source_controls WHERE source_id = ANY ($1) ORDER BY source_id`, [[A.src, B.src]])).rows;
  assert.deepEqual(ctl.map(r => r.kind), ['SUSPEND', 'TERMINATE_RETENTION'], 'both controls recorded after the purges');
  await invariants(x);
});
async function pidOf(c) { return (c._rt13pid ??= await pid(c)); }

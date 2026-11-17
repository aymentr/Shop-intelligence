// B-002 M4-P3.1-CLOSE-01 condition C1: cost of the summary eligibility check (si_summary_coverage) at 30,000 runs.
// One synthetic database built through the product write path (collector reconnected every 500 runs: R-37 workaround,
// documented), 90% of the runs in the measured source. Measured on the same data: the 0021 function and the 0020 text
// (installed side by side as si_test_coverage_0020), COLD (never analyzed, new connection) and WARM (VACUUM ANALYZE);
// first call, p50 and p95 over SI_CB_N (default and minimum 100) calls; plans (EXPLAIN ANALYZE, BUFFERS) logged.
//   node tests/db/run.mjs tests/slow/m4-coverage-bench.test.mjs        (SI_CB_RUNS, default 30000)
// Asserted: identical results; 0021 at least 10x faster than 0020 at p95 cold (no statistics: 0020 evaluates the
// fingerprint per run) and not slower warm; 0021 p95 <= 40 ms cold and <= 15 ms warm (revised C1 contract, CLOSE-02). The
// acceptance target (p95 <= 10 ms) is REPORTED, not asserted: an exact check is O(runs of the source) (docs §15.7).
// M4-P3.1-TEST-CLOSE-01 (approved C1 contract, docs §15D): the hosted CI runner is the REFERENCE environment
// (SI_CB_REFERENCE=1, set by the summary-close job). There the latency limits are asserted, on at least 100 calls per
// measurement. On any other host they are measured and reported as host-dependent variation, with the same limits printed
// as MET or NOT MET; correctness (identical eligibility) and the relative assertions against 0020 are asserted everywhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { asOwner, connect, createSources, dropDatabase, freshDatabase, recordRights, roles } from '../db/helpers.mjs';
import { fixtureSha256, requestSha256 } from '../../dist/persistence/request-hash.js';

const RUNS = Number(process.env.SI_CB_RUNS ?? 30000), N = Number(process.env.SI_CB_N ?? 100), TARGET = 10;
const REFERENCE = process.env.SI_CB_REFERENCE === '1';
if (REFERENCE && (N < 100 || RUNS !== 30000)) throw new Error(`C1 reference measurement requires >= 100 calls at 30,000 runs (got ${N} at ${RUNS})`);
// M4-P3.1-CLOSE-02: the revised C1 acceptance contract (approved): p95 <= 15 ms warm, <= 40 ms cold, at 30,000 runs.
// The original 10 ms target is still reported, as MET or NOT MET.
const LIMIT = { WARM: 15, COLD: 40 };
const M20 = readFileSync(new URL('../../db/migrations/0020_advertiser_summaries.up.sql', import.meta.url), 'utf8');
const COVERAGE_0020 = (() => { const a = M20.indexOf('CREATE FUNCTION si.si_summary_coverage('); const e = '$summary_coverage$;';
  return M20.slice(a, M20.indexOf(e, a) + e.length).replace('FUNCTION si.si_summary_coverage(', 'FUNCTION si.si_test_coverage_0020('); })();
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(p / 100 * s.length) - 1)]; };

test('CB: summary eligibility at 30,000 runs — 0021 vs 0020, cold and warm', { timeout: 4 * 3600 * 1000 }, async t => {
  const db = await freshDatabase(t, 'm4cb');
  let x = await roles(t, db, ['admin', 'si_rights_admin', 'si_collector']);
  await x.admin.query(`DO $$ DECLARE r record; BEGIN FOR r IN SELECT c.oid::regclass AS t FROM pg_class c WHERE c.relnamespace = 'si'::regnamespace AND c.relkind = 'r' LOOP
    EXECUTE format('ALTER TABLE %s SET (autovacuum_enabled = off)', r.t); END LOOP; END $$`);              // COLD: no statistics
  for (const s of ['cb-a', 'cb-b']) { await createSources(x.admin, [s], ['META', 'TIKTOK']); await recordRights(x.si_rights_admin, s, {}); }
  await asOwner(x.admin, a => a.query(COVERAGE_0020));
  let n = 0; const t0 = performance.now();
  for (let k = 0; k < RUNS; k++) {
    const src = k % 10 === 9 ? 'cb-b' : 'cb-a';
    const rows = Array.from({ length: 10 }, (_, i) => ({ network: i % 3 === 1 ? 'TIKTOK' : 'META', nativeAdId: `r${k}o${i}`,
      advertiserName: `Advertiser ${String(((k * 10 + i) * 7919) % 500).padStart(6, '0')} Synthetic`, countries: ['DE'], seenAt: '2026-01-01T00:00:00.000Z',
      sourceUrl: `https://example.test/r${k}o${i}`, destinationUrl: 'https://example.test/d', creativeUrl: 'https://example.test/c', title: 'S' }));
    const nets = [...new Set(rows.map(r => r.network))].sort();
    const fx = fixtureSha256(rows), h = requestSha256({ adapterId: src, evidenceKind: 'SYNTHETIC', networks: nets, fixtureSha256: fx });
    const run = (await x.si_collector.query('SELECT * FROM si.si_begin_run_scoped($1,$2,$3,$4,$5::text[],$6)', [src, `cb${++n}`, h, 'SYNTHETIC', nets, fx])).rows[0];
    await x.si_collector.query('BEGIN');
    await x.si_collector.query('SELECT * FROM si.si_complete_run($1::uuid,$2::uuid,$3::jsonb)', [run.run_id, run.lease_token, JSON.stringify(rows)]);
    await x.si_collector.query('COMMIT');
    if (k % 500 === 499) { await x.si_collector.end(); x.si_collector = await connect({ user: 'si_collector', database: db }); }
  }
  console.log(`# CB built ${RUNS} runs in ${((performance.now() - t0) / 1000).toFixed(0)} s (collector reconnected every 500 runs)`);
  const measure = async label => {
    const out = {};
    for (const [v, fn] of [['0021', 'si_summary_coverage'], ['0020', 'si_test_coverage_0020']]) {
      const c = await connect({ database: db }); await c.query('SET ROLE si_owner');
      const ms = []; let res;
      for (let i = 0; i < N; i++) { const s = performance.now(); res = (await c.query(`SELECT * FROM si.${fn}('cb-a')`)).rows[0]; ms.push(performance.now() - s); }
      out[v] = { first: ms[0], p50: pct(ms, 50), p95: pct(ms, 95), res };
      await c.end();
    }
    const c = await connect({ database: db }); await c.query('SET ROLE si_owner');
    const fp = (await c.query('SELECT si.si_normalizer_fingerprint() AS f')).rows[0].f;
    await c.query('BEGIN'); await c.query('SET LOCAL enable_hashjoin = off; SET LOCAL enable_nestloop = off; SET LOCAL enable_sort = off');
    const plan = (await c.query(`EXPLAIN (ANALYZE, BUFFERS) SELECT EXISTS (SELECT 1 FROM si.collection_runs x WHERE x.source_id = 'cb-a' AND x.status = 'COMPLETED'
        AND x.retention_state IN ('RETAINED', 'EMPTY') AND NOT EXISTS (SELECT 1 FROM si.run_summary_status s WHERE s.source_id = 'cb-a' AND s.normalizer = $1 AND s.run_id = x.run_id))`, [fp])).rows.map(r => r['QUERY PLAN']);
    await c.query('COMMIT'); await c.end();
    console.log(`# CB ${label} plan (0021 statement): ${plan.filter(l => /Merge|Index Only|Heap Fetches|Buffers|Execution/.test(l)).map(l => l.trim()).join(' | ')}`);
    for (const v of ['0021', '0020']) console.log(`# CB ${label} ${v}: first ${out[v].first.toFixed(1)} ms, p50 ${out[v].p50.toFixed(2)} ms, p95 ${out[v].p95.toFixed(2)} ms (n=${N}); result ${JSON.stringify(out[v].res)}`);
    console.log(`# CB ${label}: acceptance target p95 <= ${TARGET} ms ${out['0021'].p95 <= TARGET ? 'MET' : 'NOT MET'} (${out['0021'].p95.toFixed(2)} ms)`);
    assert.deepEqual(out['0021'].res, out['0020'].res, `${label}: identical eligibility`);
    if (/COLD/.test(label)) assert.ok(out['0021'].p95 * 10 <= out['0020'].p95, `${label}: at least 10x faster than 0020 at p95`);
    else assert.ok(out['0021'].p95 <= out['0020'].p95, `${label}: not slower than 0020 at p95`);
    const limit = /COLD/.test(label) ? LIMIT.COLD : LIMIT.WARM;
    console.log(`# CB ${label}: revised contract p95 <= ${limit} ms ${out['0021'].p95 <= limit ? 'MET' : 'NOT MET'} (${out['0021'].p95.toFixed(2)} ms, n=${N}; ` +
                `${REFERENCE ? 'REFERENCE environment: asserted' : 'local host: host-dependent variation, reported only'})`);
    if (REFERENCE) assert.ok(out['0021'].p95 <= limit, `${label}: 0021 p95 ${out['0021'].p95.toFixed(2)} ms <= ${limit} ms (C1 contract, reference environment)`);
  };
  await measure('COLD (no statistics)');
  for (const c of Object.values(x)) await c.end().catch(() => {});
  const v = await connect({ database: db }); await v.query('VACUUM ANALYZE'); await v.end();
  x = await roles(t, db, ['admin']);
  await measure('WARM (VACUUM ANALYZE)');
  void dropDatabase;
});

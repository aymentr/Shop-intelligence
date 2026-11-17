// B-002 M4-P3.0: performance of the set-based readable-run selection (0018) against the per-run oracle path (0016),
// on one synthetic source with mixed verdicts (VALID, INVALID, pending), networks (supported, unsupported, mixed) and
// retention (retained, expired-not-purged), built through the product write path.
//
//   node tests/db/run.mjs tests/slow/m4-readability-bench.test.mjs
//   SI_BENCH_RUNS=10,100,400,2000,10000,30000 SI_BENCH_ORIG_N=20 SI_BENCH_RESTORE=1 (full measurement; long)
//
// For every layout: COLD (the build database: autovacuum off, never analyzed: no planner statistics), WARM (a clone,
// VACUUM ANALYZE, repeated requests) and optionally RESTORED (pg_dump -Fc / pg_restore into a fresh database of the
// same server: no statistics; the server is not restarted, its data is in tmpfs). Measured: the selection itself (with the readers' pinned settings and
// 10 s statement timeout) and a full reader request (search page; a one-page history) through the library, each p50/p95
// over SI_BENCH_N (default 20) requests; temporary-file bytes; the backend's peak resident size (VmHWM, includes the
// shared buffers it touched); and the candidate's plan (EXPLAIN ANALYZE, BUFFERS) written to SI_BENCH_PLANS if set.
// Asserted (M4-P3.0 targets, candidate): the readable-run selection and a one-page history request, 10,000 runs p95 <=
// 100 ms and 30,000 runs p95 <= 400 ms, cold, warm and restored; no timeout or error. The search request is reported:
// its page statement is O(observations of the source) (docs §12.4), outside M4-P3.0. The 0016 path is measured only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, appendFileSync } from 'node:fs';
import { latestDefinition } from '../db/durability-fixtures.mjs';
import { asOwner, cfg, connect, createSources, freshDatabase, dropDatabase, recordRights, roles } from '../db/helpers.mjs';
import { provisionReaderPrincipal } from '../../dist/persistence/bootstrap.js';
import { fixtureSha256, requestSha256 } from '../../dist/persistence/request-hash.js';
import { grantReader } from '../../dist/persistence/reader.js';
import * as INTEL from '../../dist/persistence/intelligence.js';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const LAYOUTS = (process.env.SI_BENCH_RUNS ?? '10000,30000').split(',').map(Number);
const N = Number(process.env.SI_BENCH_N ?? 20), ORIG_N = Number(process.env.SI_BENCH_ORIG_N ?? 3);
const RESTORE = process.env.SI_BENCH_RESTORE === '1';
const PLANS = process.env.SI_BENCH_PLANS;
const TARGET = { 10000: 100, 30000: 400 };
const SRC = 'bench-a';
const PIN = `SET LOCAL work_mem = '4MB'; SET LOCAL hash_mem_multiplier = 2; SET LOCAL max_parallel_workers_per_gather = 0; SET LOCAL jit = off;
             SET LOCAL temp_file_limit = '256MB'; SET LOCAL plan_cache_mode = force_custom_plan; SET LOCAL statement_timeout = '10s'`;
const ORIG_SQL = `SELECT coalesce(array_agg(r.run_id), '{}'::uuid[]) AS a FROM si.collection_runs r
   WHERE r.source_id = $1 AND r.status = 'COMPLETED' AND r.retention_state = 'RETAINED' AND r.published_count > 0
     AND ($2::timestamptz IS NULL OR (r.finished_at >= $2 AND r.finished_at < $3)) AND si.si_evidence_readable(r.run_id)`;   // 0016, verbatim predicate
const CAND_SQL = 'SELECT si.si_readable_runs($1, $2, $3) AS a';
const mig = f => readFileSync(new URL(`../../db/migrations/${f}`, import.meta.url), 'utf8');
const cut = (t, a, b) => { const s = t.indexOf(a); return t.slice(s, t.indexOf(b, s) + b.length); };
const M16 = mig('0016_cold_query_reliability.up.sql');
const FN16 = [cut(M16, 'CREATE OR REPLACE FUNCTION si.si_search_advertisers', 'END $search$;'), cut(M16, 'CREATE OR REPLACE FUNCTION si.si_advertiser_history', 'END $history$;')];
const L = latestDefinition('si_search_advertisers', 'END $search$;');
const FN18 = [L.text, latestDefinition('si_advertiser_history', 'END $history$;').text];
assert.equal(L.file, '0023_summary_backed_search.up.sql');   // M4-P3.2: the active search (0023) keeps the 0018 readable-run selection; its page is summary-backed (tests/slow/m4-summary-search-bench)

test.before(async () => { const a = await connect(); try { await provisionReaderPrincipal(a, 'si_reader_alice', cfg.rolePassword); } finally { await a.end(); } });

const container = () => execFileSync('docker', ['compose', 'ps', '-q', 'db'], { encoding: 'utf8' }).trim();
const pct = (a, p) => { if (!a?.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(p / 100 * s.length) - 1)]; };
const fmt = a => a.length ? `p50 ${pct(a, 50).toFixed(1)} ms, p95 ${pct(a, 95).toFixed(1)} ms (n=${a.length}, max ${Math.max(...a).toFixed(1)})` : 'n=0';
async function vmhwm(c) {
  const pid = (await c.query('SELECT pg_backend_pid() AS p')).rows[0].p;
  try { const s = execFileSync('docker', ['exec', container(), 'cat', `/proc/${pid}/status`], { encoding: 'utf8' }); return Number(/VmHWM:\s+(\d+)/.exec(s)[1]) / 1024; } catch { return NaN; }
}
async function tempBytes(admin, db) {
  await admin.query('SELECT pg_stat_force_next_flush()'); await new Promise(r => setTimeout(r, 700)); await admin.query('SELECT pg_stat_clear_snapshot()');
  return Number((await admin.query('SELECT temp_bytes FROM pg_stat_database WHERE datname = $1', [db])).rows[0].temp_bytes);
}

let n = 0;
async function build(x, from, to) {
  const t0 = performance.now();
  for (let k = from; k < to; k++) {
    const mixed = k % 7 === 3, google = k % 20 === 11;
    const rows = Array.from({ length: 10 }, (_, i) => ({ network: google ? 'GOOGLE' : mixed && i % 2 ? 'TIKTOK' : 'META', nativeAdId: `r${k}o${i}`,
      advertiserName: k % 500 === 0 && i === 0 ? 'Rare Synthetic' : `Advertiser ${String((k * 10 + i) % 200).padStart(3, '0')} Synthetic`,
      countries: ['DE'], seenAt: '2026-01-01T00:00:00.000Z', sourceUrl: `https://example.test/r${k}o${i}`, destinationUrl: 'https://example.test/d',
      creativeUrl: 'https://example.test/c', title: `Synthetic ${k}` }));
    const networks = [...new Set(rows.map(r => r.network))].sort();
    const fx = fixtureSha256(rows), sha = requestSha256({ adapterId: SRC, evidenceKind: 'SYNTHETIC', networks, fixtureSha256: fx });
    const run = (await x.si_collector.query('SELECT * FROM si.si_begin_run_scoped($1,$2,$3,$4,$5::text[],$6)', [SRC, `b${++n}`, sha, 'SYNTHETIC', networks, fx])).rows[0];
    await x.si_collector.query('BEGIN');
    await x.si_collector.query('SELECT * FROM si.si_complete_run($1::uuid, $2::uuid, $3::jsonb)', [run.run_id, run.lease_token, JSON.stringify(rows)]);
    await x.si_collector.query('COMMIT');
    if (k % 500 === 499) {                                                   // a fresh collector session: see the note in docs §14.7
      await x.si_collector.end(); x.si_collector = await connect({ user: 'si_collector', database: x.db });
    }
    if (k % 500 === 499 || k === to - 1) for (let i = 0; i < 20; i++) { const r = await x.si_monitor.query('SELECT * FROM si.si_verify_receipts(500)'); if (!r.rows.length || Number(r.rows[0].verified) === 0) break; }
  }
  // Mixed states (fixture, replica mode): 5% INVALID, 3% pending, 5% retention ended but not yet purged; GOOGLE unsupported.
  await x.admin.query('BEGIN'); await x.admin.query('SET LOCAL session_replication_role = replica');
  await x.admin.query(`WITH k AS (SELECT run_id, row_number() OVER (ORDER BY started_at, run_id) AS i FROM si.collection_runs WHERE source_id = $1)
    UPDATE si.receipt_verifications v SET verdict = 'INVALID', reason = 'COMMITTED_AFTER_WINDOW', window_end = v.commit_ts FROM k
     WHERE k.run_id = v.run_id AND k.i > $2 AND k.i % 20 = 5`, [SRC, from]);
  await x.admin.query(`WITH k AS (SELECT run_id, row_number() OVER (ORDER BY started_at, run_id) AS i FROM si.collection_runs WHERE source_id = $1)
    DELETE FROM si.receipt_verifications v USING k WHERE k.run_id = v.run_id AND k.i > $2 AND k.i % 33 = 7`, [SRC, from]);
  await x.admin.query(`WITH k AS (SELECT run_id, row_number() OVER (ORDER BY started_at, run_id) AS i FROM si.collection_runs WHERE source_id = $1)
    UPDATE si.collection_runs r SET retain_until = clock_timestamp() - interval '1 minute' FROM k WHERE k.run_id = r.run_id AND k.i > $2 AND k.i % 20 = 13`, [SRC, from]);
  await x.admin.query('COMMIT');
  return Math.round((performance.now() - t0) / 1000);
}

async function measure(label, db, runs, { orig = true } = {}) {
  const out = { label, runs };
  const c = await connect({ database: db });
  const alice = await connect({ user: 'si_reader_alice', database: db });
  try {
    const sel = async (sql, k, tk) => { const ms = []; let res;
      for (let i = 0; i < k; i++) { await c.query('BEGIN'); await c.query(PIN); const t0 = performance.now();
        try { res = (await c.query(sql, [SRC, null, null])).rows[0].a; ms.push(performance.now() - t0); } catch (e) { out[tk] = (out[tk] ?? 0) + 1; ms.push(10000); }
        await c.query('COMMIT').catch(() => c.query('ROLLBACK')); }
      return { ms, res }; };
    const tb0 = await tempBytes(c, db);
    const cand = await sel(CAND_SQL, N, 'timeouts');
    out.selCand = cand.ms; out.readable = cand.res.length; out.tempCand = (await tempBytes(c, db)) - tb0;
    out.hwmCand = await vmhwm(c);
    // A request that the durability gate refused once and the library retried (R-26, about 1 s, pre-existing and
    // independent of readability) is counted and reported apart; the per-request figures are single-attempt requests.
    let calls = 0;
    const cc = { query: (...a) => { const q = typeof a[0] === 'string' ? a[0] : ''; if (q.includes('si.si_search_advertisers(') || q.includes('si.si_advertiser_history(')) calls++; return alice.query(...a); } };
    const req = async (k, tag) => { const s = [], h = [], retried = [];
      const one = async (name, arr, fn) => { const c0 = calls, t0 = performance.now();
        try { await fn(); const ms = performance.now() - t0; if (calls - c0 > 1) retried.push(`${name}:${Math.round(ms)}ms`); else arr.push(ms); }
        catch (e) { arr.push(Infinity); out[tag] = [...(out[tag] ?? []), `${name}:${e.code}`]; } };
      for (let i = 0; i < k; i++) {
        await one('search', s, () => INTEL.searchAdvertisers(cc, { sources: [SRC], query: 'advertiser 01', limit: 20 }));
        await one('history', h, () => INTEL.advertiserHistory(cc, SRC, 'Rare Synthetic'));
      }
      return { s, h, retried }; };
    const r18 = await req(N, 'reqErrors'); out.searchCand = r18.s; out.historyCand = r18.h; out.retriedCand = r18.retried;
    if (orig) {
      const o = await sel(ORIG_SQL, ORIG_N, 'timeoutsOrig');
      out.selOrig = o.ms;
      if (o.res && !out.timeoutsOrig) assert.deepEqual([...o.res].sort(), [...cand.res].sort(), `${label}: the oracle path selects the same runs`);
      await asOwner(c, async a => { for (const f of FN16) await a.query(f); });
      try { const r16 = await req(ORIG_N, 'reqErrorsOrig'); out.searchOrig = r16.s; out.historyOrig = r16.h; out.retriedOrig = r16.retried; }
      finally { await asOwner(c, async a => { for (const f of FN18) await a.query(f); }); }
    }
    if (PLANS) {                                                             // nested plans of one selection (auto_explain, server log)
      const since = new Date(Date.now() - 1000).toISOString();
      await c.query('BEGIN'); await c.query(PIN);
      await c.query(`LOAD 'auto_explain'; SET LOCAL auto_explain.log_min_duration = 0; SET LOCAL auto_explain.log_analyze = on;
                     SET LOCAL auto_explain.log_buffers = on; SET LOCAL auto_explain.log_nested_statements = on; SET LOCAL auto_explain.log_timing = on`);
      await c.query(CAND_SQL, [SRC, null, null]);
      await c.query('COMMIT');
      await new Promise(r => setTimeout(r, 300));
      const log = execFileSync('docker', ['logs', '--since', since, container()], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      const err = execFileSync('bash', ['-c', `docker logs --since ${since} ${container()} 2>&1 >/dev/null`], { encoding: 'utf8' });
      appendFileSync(PLANS, `\n===== ${label} (${runs} runs) =====\n${log}${err}\n`);
      out.planBuffers = [...`${log}${err}`.matchAll(/Buffers: shared ([^\n]+)/g)].map(m => m[1]).slice(0, 6).join(' | ');
    }
  } finally { await c.end().catch(() => {}); await alice.end().catch(() => {}); }
  const fin = a => a ? a.filter(Number.isFinite) : [];
  console.log(`# BENCH ${label} ${runs} runs (${out.readable} readable): selection 0018 ${fmt(out.selCand)}; 0016 ${fmt(fin(out.selOrig))}${out.timeoutsOrig ? `, ${out.timeoutsOrig} statement timeout(s) at 10 s` : ''}${out.timeouts ? `; 0018 TIMEOUTS ${out.timeouts}` : ''}`);
  console.log(`# BENCH ${label} ${runs} runs: search request 0018 ${fmt(fin(out.searchCand))}; 0016 ${fmt(fin(out.searchOrig))}; history request 0018 ${fmt(fin(out.historyCand))}; 0016 ${fmt(fin(out.historyOrig))}${out.reqErrors ? `; 0018 errors ${[...new Set(out.reqErrors)].join(',')}` : ''}${out.reqErrorsOrig ? `; 0016 errors ${[...new Set(out.reqErrorsOrig)].join(',')}` : ''}; R-26 gate retries 0018 [${out.retriedCand?.join(' ') ?? ''}] 0016 [${out.retriedOrig?.join(' ') ?? ''}]`);
  console.log(`# BENCH ${label} ${runs} runs: temp bytes (20 selections) ${out.tempCand}; backend VmHWM ${out.hwmCand?.toFixed(1)} MB${out.planBuffers ? `; plan buffers ${out.planBuffers}` : ''}`);
  return out;
}
function check(out) {
  const target = TARGET[out.runs];
  if (!target) return;
  assert.ok(!out.timeouts && !out.reqErrors, `${out.label} ${out.runs}: no timeout or error (${out.reqErrors ?? ''})`);
  assert.ok(out.searchCand.length >= N / 2 && out.historyCand.length >= N / 2, `${out.label} ${out.runs}: enough single-attempt requests`);
  assert.ok(pct(out.selCand, 95) <= target, `${out.label} ${out.runs}: selection p95 ${pct(out.selCand, 95).toFixed(1)} ms <= ${target} ms`);
  assert.ok(pct(out.historyCand, 95) <= target, `${out.label} ${out.runs}: history request p95 ${pct(out.historyCand, 95).toFixed(1)} <= ${target} ms`);
  // The search request is reported, not asserted: its page statement scans every candidate observation of the source
  // (O(observations), §12.4), which M4-P3.0 does not change; its readability share is the selection above.
  assert.ok(Number.isFinite(pct(out.searchCand, 95)), `${out.label} ${out.runs}: search completes`);
}

test('BENCH: set-based readable runs vs the per-run oracle path, cold, warm and restored', { timeout: 6 * 3600 * 1000 }, async t => {
  if (PLANS) writeFileSync(PLANS, `M4-P3.0 readability plans (${new Date().toISOString()})\n`);
  const db = await freshDatabase(t, 'm4bench');
  const ROLES = ['admin', 'si_rights_admin', 'si_collector', 'si_monitor'];
  let x = await roles(t, db, ROLES);
  Object.defineProperty(x, 'db', { value: db, enumerable: false });
  const closeAll = async () => { for (const c of Object.values(x)) await c.end().catch(() => {}); };
  t.after(() => closeAll());
  await x.admin.query(`DO $$ DECLARE r record; BEGIN FOR r IN SELECT c.oid::regclass AS t FROM pg_class c WHERE c.relnamespace = 'si'::regnamespace AND c.relkind = 'r' LOOP
                         EXECUTE format('ALTER TABLE %s SET (autovacuum_enabled = off)', r.t); END LOOP; END $$`);   // COLD fixture: no statistics
  await createSources(x.admin, [SRC], ['META', 'TIKTOK', 'GOOGLE']); await recordRights(x.si_rights_admin, SRC, {});
  await grantReader(x.si_rights_admin, 'si_reader_alice', SRC, 'm4-p3.0 bench');
  let built = 0;
  const results = [];
  for (const runs of LAYOUTS) {
    await asOwner(x.admin, a => a.query(`UPDATE si.sources SET supported_networks = '{META,TIKTOK,GOOGLE}' WHERE source_id = $1`, [SRC]));
    const s = await build(x, built, runs); built = runs;
    await asOwner(x.admin, a => a.query(`UPDATE si.sources SET supported_networks = '{META,TIKTOK}' WHERE source_id = $1`, [SRC]));   // GOOGLE evidence unsupported
    const stats = (await x.admin.query(`SELECT (SELECT count(*) FROM si.observations) AS obs, (SELECT count(*) FROM pg_statistic WHERE starelid = 'si.collection_runs'::regclass) AS st`)).rows[0];
    console.log(`# BENCH layout ${runs} runs, ${stats.obs} observations (built +${s} s); collection_runs statistics rows: ${stats.st}`);
    assert.equal(Number(stats.st), 0, 'cold: no statistics');
    const cold = await measure('COLD', db, runs); check(cold); results.push(cold);
    // WARM: a clone with statistics (a template copy needs no other session on the build database).
    const warmDb = db.replace(/_test$/, "_w_test");
    await closeAll();
    const m = await connect(); try { await m.query(`CREATE DATABASE ${warmDb} TEMPLATE ${db}`); } finally { await m.end(); }
    x = await roles(t, db, ROLES); Object.defineProperty(x, 'db', { value: db, enumerable: false });
    try {
      const w = await connect({ database: warmDb });
      try { await w.query('VACUUM ANALYZE'); } finally { await w.end(); }
      const warm = await measure('WARM', warmDb, runs); check(warm); results.push(warm);
    } finally { await dropDatabase(warmDb); }
  }
  if (RESTORE) {
    const runs = built, rdb = db.replace(/_test$/, "_r_test"), id = container();
    const env = ['-e', `PGPASSWORD=${cfg.adminPassword}`];
    const dump = `${tmpdir()}/si-bench-${process.pid}.dump`;
    execFileSync('bash', ['-c', `docker exec ${env.join(' ')} ${id} pg_dump -h 127.0.0.1 -U ${cfg.adminUser} -d ${db} -Fc > ${dump}`]);
    await x.admin.query(`CREATE DATABASE ${rdb} TEMPLATE template0`);
    execFileSync('bash', ['-c', `docker exec -i ${env.join(' ')} ${id} pg_restore -h 127.0.0.1 -U ${cfg.adminUser} -d ${rdb} < ${dump}; rm -f ${dump}`]);
    const count = async d => { const k = await connect({ database: d }); try { return (await k.query('SELECT count(*)::int AS n FROM si.observations')).rows[0].n; } finally { await k.end(); } };
    assert.equal(await count(rdb), await count(db), 'restored: all observations');
    // (The test container keeps its data in tmpfs, so it is not restarted: shared buffers hold whatever the restore left.)
    const admin = await connect();
    try {
      const r = await measure('RESTORED', rdb, runs); check(r); results.push(r);
    } finally { await admin.end(); await dropDatabase(rdb); }
  }
  console.log(`# BENCH summary ${JSON.stringify(results.map(r => ({ l: r.label, runs: r.runs, readable: r.readable,
    sel18: [pct(r.selCand, 50), pct(r.selCand, 95)].map(v => +v.toFixed(1)), sel16: r.selOrig ? [pct(r.selOrig, 50), pct(r.selOrig, 95)].map(v => +v.toFixed(1)) : null,
    search18: pct(r.searchCand, 95).toFixed(1), history18: pct(r.historyCand, 95).toFixed(1),
    search16: r.searchOrig ? pct(r.searchOrig, 95).toFixed(1) : null, history16: r.historyOrig ? pct(r.historyOrig, 95).toFixed(1) : null })))}`);
});

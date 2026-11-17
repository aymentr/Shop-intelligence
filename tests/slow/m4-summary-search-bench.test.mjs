// B-002 M4-P3.2: complete reader requests (library -> intent -> durability gate -> lock -> grant -> availability ->
// readable runs -> page -> audit), search and history, on one synthetic source built through the product write path
// (the M4-P3.0 readability-bench layout: 10 observations per run, 200 advertisers plus a rare one, mixed verdicts,
// pending and expired runs, unsupported GOOGLE evidence), at SI_SSB_RUNS layouts (default 1000,10000,30000).
//
//   node tests/db/run.mjs tests/slow/m4-summary-search-bench.test.mjs        (SI_SSB_N requests per figure, default 20)
//
// For every layout, COLD (the build database: autovacuum off, never analyzed) and WARM (a clone after VACUUM ANALYZE):
//   * search, three variants on the same data: BEFORE (the 0018 text, installed side by side for the measurement only),
//     SUMMARY (0023, eligible source) and FALLBACK (0023 with an open drift: the observation path plus the eligibility
//     call); four queries: selective ('advertiser 01', 10 identities), broad ('synthetic', every identity; at 30,000 runs it
//     matches about 250,000 observations and every variant refuses it with SCAN_LIMIT, the unchanged cap), rare, none;
//   * history (unchanged by 0023), a rare and a frequent advertiser;
//   * eligibility alone (si_summary_coverage), and the plans (EXPLAIN ANALYZE, BUFFERS) of a verbatim copy of the
//     summary statement with the request's readable runs bound as parameters (the function's own custom plan);
//   * at the largest layout, search under concurrent publication and purge.
// Asserted: identical documents (hits, has_more) or identical typed refusals from all three variants; the SUMMARY variant takes the summary path and
// FALLBACK the observation path; no error; from 10,000 runs SUMMARY at least 2x faster than BEFORE at p50 for every query;
// SUMMARY p95 <= the M4-P3.0 reader targets (10,000 runs: 100 ms, 30,000 runs: 400 ms) for the fixed-cost rare and empty
// queries, cold and warm (selective and broad are reported as MET / NOT MET against the same targets). C1 (eligibility at 30,000 runs) keeps its own reference bench (m4-coverage-bench, unchanged).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { latestDefinition } from '../db/durability-fixtures.mjs';
import { asOwner, cfg, connect, createSources, freshDatabase, dropDatabase, recordRights, roles } from '../db/helpers.mjs';
import { provisionReaderPrincipal } from '../../dist/persistence/bootstrap.js';
import { fixtureSha256, requestSha256 } from '../../dist/persistence/request-hash.js';
import { grantReader } from '../../dist/persistence/reader.js';
import * as INTEL from '../../dist/persistence/intelligence.js';

const LAYOUTS = (process.env.SI_SSB_RUNS ?? '1000,10000,30000').split(',').map(Number);
const N = Number(process.env.SI_SSB_N ?? 20);
const TARGET = { 10000: 100, 30000: 400 };
const SRC = 'ssb-a';
const MIG18 = readFileSync(new URL('../../db/migrations/0018_set_based_readability.up.sql', import.meta.url), 'utf8');
const cut = (t, a, b) => { const s = t.indexOf(a); return t.slice(s, t.indexOf(b, s) + b.length); };
const FN18 = cut(MIG18, 'CREATE OR REPLACE FUNCTION si.si_search_advertisers', 'END $search$;');
const L = latestDefinition('si_search_advertisers', 'END $search$;');
assert.equal(L.file, '0023_summary_backed_search.up.sql');
const FN23 = L.text;
// The summary statement, verbatim from 0023, with its PL/pgSQL variables bound as parameters (EXPLAIN only).
const STMT = (() => {
  let s = cut(FN23, '      WITH guard AS (', '      INTO summary_ok, summary_candidates, page;').replace(/\n\s+INTO summary_ok, summary_candidates, page;$/, '');
  for (const [v, p] of [['readable_runs', '$1::uuid[]'], ['p_source_id', '$2::text'], ['fp', '$3::text'], ['p_networks', '$5::text[]'],
                        ['p_after_inclusive', '$7::boolean'], ['p_after', '$6::text'], ['p_limit', '$8::int']]) s = s.replace(new RegExp(`\\b${v}\\b`, 'g'), p);
  return s.replace(/strpos\(i\.normalized_name, q\)/, 'strpos(i.normalized_name, $4::text)');
})();
const PIN = `SET LOCAL work_mem = '4MB'; SET LOCAL hash_mem_multiplier = 2; SET LOCAL max_parallel_workers_per_gather = 0; SET LOCAL jit = off;
             SET LOCAL temp_file_limit = '256MB'; SET LOCAL plan_cache_mode = force_custom_plan; SET LOCAL statement_timeout = '10s'`;
const QUERIES = [{ k: 'selective', q: 'advertiser 01' }, { k: 'broad', q: 'synthetic' }, { k: 'rare', q: 'rare' }, { k: 'none', q: 'zzz-none' }];

test.before(async () => { const a = await connect(); try { await provisionReaderPrincipal(a, 'si_reader_alice', cfg.rolePassword); } finally { await a.end(); } });
const pct = (a, p) => { if (!a?.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(p / 100 * s.length) - 1)]; };
const fmt = a => a?.length ? `p50 ${pct(a, 50).toFixed(1)} / p95 ${pct(a, 95).toFixed(1)} ms` : 'n=0';

let n = 0;
async function publish(x, collector, k) {
  const mixed = k % 7 === 3, google = k % 20 === 11;
  const rows = Array.from({ length: 10 }, (_, i) => ({ network: google ? 'GOOGLE' : mixed && i % 2 ? 'TIKTOK' : 'META', nativeAdId: `r${k}o${i}`,
    advertiserName: k % 500 === 0 && i === 0 ? 'Rare Synthetic' : `Advertiser ${String((k * 10 + i) % 200).padStart(3, '0')} Synthetic`,
    countries: ['DE'], seenAt: '2026-01-01T00:00:00.000Z', sourceUrl: `https://example.test/r${k}o${i}`, destinationUrl: 'https://example.test/d',
    creativeUrl: 'https://example.test/c', title: `Synthetic ${k}` }));
  const networks = [...new Set(rows.map(r => r.network))].sort();
  const fx = fixtureSha256(rows), sha = requestSha256({ adapterId: SRC, evidenceKind: 'SYNTHETIC', networks, fixtureSha256: fx });
  const run = (await collector.query('SELECT * FROM si.si_begin_run_scoped($1,$2,$3,$4,$5::text[],$6)', [SRC, `ssb${++n}`, sha, 'SYNTHETIC', networks, fx])).rows[0];
  await collector.query('BEGIN');
  await collector.query('SELECT * FROM si.si_complete_run($1::uuid, $2::uuid, $3::jsonb)', [run.run_id, run.lease_token, JSON.stringify(rows)]);
  await collector.query('COMMIT');
  return run.run_id;
}
async function build(x, from, to) {
  const t0 = performance.now();
  for (let k = from; k < to; k++) {
    await publish(x, x.si_collector, k);
    if (k % 500 === 499) { await x.si_collector.end(); x.si_collector = await connect({ user: 'si_collector', database: x.db }); }   // R-37 (docs §14.7)
    if (k % 500 === 499 || k === to - 1) for (let i = 0; i < 20; i++) { const r = await x.si_monitor.query('SELECT * FROM si.si_verify_receipts(500)'); if (!r.rows.length || Number(r.rows[0].verified) === 0) break; }
  }
  await x.admin.query('BEGIN'); await x.admin.query('SET LOCAL session_replication_role = replica');               // the M4-P3.0 mixed states
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
async function readerSession(db) {
  const c = await connect({ user: 'si_reader_alice', database: db });
  await c.query('SET client_min_messages = debug1');
  c.paths = []; c.calls = 0;
  c.on('notice', m => { const k = /^SI_READ_PATH (summary|observations)$/.exec(m.message); if (k) c.paths.push(k[1]); });
  return c;
}
/** One library search page; a request the durability gate refused once and the library retried (R-26) is counted apart. */
async function timed(c, fn) {
  const c0 = c.calls, p0 = c.paths.length, t0 = performance.now();
  let value, refusal = null;
  try { value = await fn(); } catch (e) { if (e?.name !== 'IntelligenceFailed') throw e; refusal = e.code; }   // a typed refusal is a complete request
  return { ms: performance.now() - t0, retried: c.calls - c0 > 1, path: c.paths.slice(p0).at(-1) ?? null, value, refusal };
}
const counting = c => ({ query: (...a) => { if (String(a[0]).includes('si.si_search_advertisers(') || String(a[0]).includes('si.si_advertiser_history(')) c.calls++; return c.query(...a); } });
const docOf = page => page.hits.map(h => ({ ...h }));

async function measure(label, db, runs) {
  const out = { label, runs, search: {}, history: {}, paths: {}, docs: {}, retried: 0, errors: [] };
  const admin = await connect({ database: db });
  const alice = await readerSession(db), cc = counting(alice);
  try {
    out.readable = (await admin.query('SELECT cardinality(si.si_readable_runs($1, NULL, NULL)) AS n', [SRC])).rows[0].n;
    out.summaryRows = Number((await admin.query('SELECT count(*) AS n FROM si.run_advertiser_summaries WHERE source_id = $1', [SRC])).rows[0].n);
    out.observations = Number((await admin.query('SELECT count(*) AS n FROM si.observations WHERE source_id = $1', [SRC])).rows[0].n);
    // Eligibility alone (the C1 function), as the reader function calls it: once.
    out.eligibility = [];
    for (let i = 0; i < N; i++) { const t0 = performance.now(); await asOwner(admin, a => a.query('SELECT * FROM si.si_summary_coverage($1)', [SRC])); out.eligibility.push(performance.now() - t0); }
    const variants = [
      ['BEFORE', async () => asOwner(admin, a => a.query(FN18))],
      ['SUMMARY', async () => asOwner(admin, a => a.query(FN23))],
      ['FALLBACK', async () => admin.query(`INSERT INTO si.summary_events (source_id, kind, finding) VALUES ($1, 'DRIFT_DETECTED', 'MISSING')`, [SRC])],
    ];
    for (const [v, install] of variants) {
      await install();
      // One untimed request: installing a function writes catalog WAL, which the next request's durability gate waits to see
      // flushed (R-26 class, not the page); the measured requests start after it.
      await INTEL.searchAdvertisers(cc, { sources: [SRC], query: 'zzz-none', limit: 20 }).catch(() => {});
      for (const { k, q } of QUERIES) {
        const key = `${v}:${k}`; out.search[key] = []; out.paths[key] = new Set();
        for (let i = 0; i < N; i++) {
          try {
            const r = await timed(alice, () => INTEL.searchAdvertisers(cc, { sources: [SRC], query: q, limit: 20 }));
            if (r.retried) out.retried++; else out.search[key].push(r.ms);
            out.paths[key].add(r.path);
            if (i === 0) out.docs[key] = r.refusal ? `REFUSED:${r.refusal}` : JSON.stringify(docOf(r.value));
          } catch (e) { out.errors.push(`${key}:${e.code ?? e.message}`); }
        }
      }
    }
    await admin.query(`INSERT INTO si.summary_events (source_id, kind) VALUES ($1, 'DRIFT_CLEARED')`, [SRC]);
    // History is unchanged by 0023: the complete library request (every page, the advertiser's whole history) is timed.
    out.historyPages = {};
    for (const [k, name] of [['rare', 'Rare Synthetic'], ['frequent', 'Advertiser 010 Synthetic']]) {
      out.history[k] = [];
      for (let i = 0; i < N; i++) {
        try { const r = await timed(alice, () => INTEL.advertiserHistory(cc, SRC, name)); if (r.refusal) throw Object.assign(new Error(r.refusal), { code: r.refusal });
              out.history[k].push(r.ms); out.historyPages[k] = Math.ceil(r.value.observations.length / 100) || 1; }
        catch (e) { out.errors.push(`history:${k}:${e.code ?? e.message}`); }
      }
    }
    // Plans of the summary statement (the request's readable runs and fingerprint bound as parameters).
    const rr = (await admin.query('SELECT si.si_readable_runs($1, NULL, NULL) AS a', [SRC])).rows[0].a;
    const fp = (await admin.query('SELECT si.si_normalizer_fingerprint() AS f')).rows[0].f;
    out.plans = {};
    for (const { k, q } of QUERIES.slice(0, 2)) {
      await admin.query('BEGIN'); await admin.query(PIN);
      const qq = (await admin.query('SELECT si.si_normalize_advertiser($1) AS q', [q])).rows[0].q;
      const plan = (await admin.query(`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF) ${STMT}`, [rr, SRC, fp, qq, [], null, false, 20])).rows.map(r => r['QUERY PLAN']);
      await admin.query('COMMIT');
      out.plans[k] = { exec: plan.find(l => /Execution Time/.test(l))?.trim(), buffers: plan.find(l => /Buffers:/.test(l))?.trim(), temp: plan.filter(l => /temp/.test(l)).length,
                       nodes: plan.filter(l => /->|^\S/.test(l)).slice(0, 40).map(l => l.replace(/\s+\(actual rows=(\d+) loops=(\d+)\)/, ' [rows $1 x$2]').replace(/\s{2,}/g, ' ').trim()) };
    }
  } finally { await admin.end().catch(() => {}); await alice.end().catch(() => {}); }
  for (const [key, a] of Object.entries(out.search)) console.log(`# SSB ${label} ${runs} runs: search ${key.padEnd(18)} ${fmt(a)} path ${[...out.paths[key]].join('/')}${out.docs[key]?.startsWith('REFUSED') ? ` (${out.docs[key]})` : ''}`);
  console.log(`# SSB ${label} ${runs} runs (${out.readable} readable, ${out.observations} observations, ${out.summaryRows} summary rows): eligibility ${fmt(out.eligibility)}; history (complete, all pages) rare ${fmt(out.history.rare)}, frequent ${fmt(out.history.frequent)} (${out.historyPages.frequent} pages); R-26 retries ${out.retried}; errors ${JSON.stringify(out.errors)}`);
  for (const [k, p] of Object.entries(out.plans)) console.log(`# SSB ${label} ${runs} runs: plan (${k}) ${p.exec}; ${p.buffers}; temp nodes ${p.temp} | ${p.nodes.join(' | ')}`);
  return out;
}
function check(o) {
  assert.deepEqual(o.errors, [], `${o.label} ${o.runs}: no error`);
  for (const { k } of QUERIES) {
    assert.equal(o.docs[`SUMMARY:${k}`], o.docs[`BEFORE:${k}`], `${o.label} ${o.runs} ${k}: the summary page equals the 0018 page`);
    assert.equal(o.docs[`FALLBACK:${k}`], o.docs[`BEFORE:${k}`], `${o.label} ${o.runs} ${k}: the fallback page equals the 0018 page`);
    assert.deepEqual([...o.paths[`SUMMARY:${k}`]], ['summary']); assert.deepEqual([...o.paths[`FALLBACK:${k}`]], ['observations']);
    assert.ok(o.search[`SUMMARY:${k}`].length >= N / 2, `${o.label} ${o.runs} ${k}: enough single-attempt requests`);
  }
  // Relative, everywhere from 10,000 runs: the summary path is at least twice as fast as 0018 at p50 for every query.
  if (o.runs >= 10000) for (const { k } of QUERIES) {
    const [a, b] = [pct(o.search[`SUMMARY:${k}`], 50), pct(o.search[`BEFORE:${k}`], 50)];
    assert.ok(a * 2 <= b, `${o.label} ${o.runs} ${k}: summary p50 ${a.toFixed(1)} ms at least 2x faster than 0018 p50 ${b.toFixed(1)} ms`);
  }
  // Absolute, the M4-P3.0 reader targets: asserted for the fixed-cost requests (rare, none: the reader floor = intent, gate,
  // lock, readable runs, eligibility, guard, audit); reported as MET / NOT MET for the selective and broad pages.
  const target = TARGET[o.runs];
  if (target) for (const { k } of QUERIES) {
    const p95 = pct(o.search[`SUMMARY:${k}`], 95);
    console.log(`# SSB ${o.label} ${o.runs} runs: summary search ${k} p95 ${p95.toFixed(1)} ms vs reader target ${target} ms: ${p95 <= target ? 'MET' : 'NOT MET'}${['rare', 'none'].includes(k) ? ' (asserted)' : ' (reported)'}`);
    if (['rare', 'none'].includes(k)) assert.ok(p95 <= target, `${o.label} ${o.runs} ${k}: summary-backed search request p95 ${p95.toFixed(1)} ms <= ${target} ms`);
  }
}

test('SSB: complete search and history requests before and after 0023, cold and warm, and under concurrent publication and purge', { timeout: 6 * 3600 * 1000 }, async t => {
  const db = await freshDatabase(t, 'm4ssb');
  const ROLES = ['admin', 'si_rights_admin', 'si_collector', 'si_monitor', 'si_retention'];
  let x = await roles(t, db, ROLES);
  Object.defineProperty(x, 'db', { value: db, enumerable: false });
  const closeAll = async () => { for (const c of Object.values(x)) await c.end().catch(() => {}); };
  t.after(() => closeAll());
  await x.admin.query(`DO $$ DECLARE r record; BEGIN FOR r IN SELECT c.oid::regclass AS t FROM pg_class c WHERE c.relnamespace = 'si'::regnamespace AND c.relkind = 'r' LOOP
                         EXECUTE format('ALTER TABLE %s SET (autovacuum_enabled = off)', r.t); END LOOP; END $$`);   // COLD fixture: no statistics
  await createSources(x.admin, [SRC], ['META', 'TIKTOK', 'GOOGLE']); await recordRights(x.si_rights_admin, SRC, {});
  await grantReader(x.si_rights_admin, 'si_reader_alice', SRC, 'm4-p3.2 bench');
  let built = 0;
  const results = [];
  for (const runs of LAYOUTS) {
    await asOwner(x.admin, a => a.query(`UPDATE si.sources SET supported_networks = '{META,TIKTOK,GOOGLE}' WHERE source_id = $1`, [SRC]));
    const s = await build(x, built, runs); built = runs;
    await asOwner(x.admin, a => a.query(`UPDATE si.sources SET supported_networks = '{META,TIKTOK}' WHERE source_id = $1`, [SRC]));
    console.log(`# SSB layout ${runs} runs (built +${s} s)`);
    const cold = await measure('COLD', db, runs); check(cold); results.push(cold);
    const warmDb = db.replace(/_test$/, '_w_test');
    await closeAll();
    const m = await connect(); try { await m.query(`CREATE DATABASE ${warmDb} TEMPLATE ${db}`); } finally { await m.end(); }
    x = await roles(t, db, ROLES); Object.defineProperty(x, 'db', { value: db, enumerable: false });
    try {
      const w = await connect({ database: warmDb }); try { await w.query('VACUUM ANALYZE'); } finally { await w.end(); }
      const warm = await measure('WARM', warmDb, runs); check(warm); results.push(warm);
    } finally { await dropDatabase(warmDb); }
  }
  // Under load (largest layout, build database): a collector publishing and a purge loop removing expired runs while the
  // reader searches, with 0023 (summary path) and, for comparison, the 0018 text. Every 0023 request must take the summary
  // path (publication and purge keep coverage complete). The durability gate waits for the publisher's WAL to be flushed
  // on both variants (R-26 class); the comparison isolates it from the page.
  for (const variant of ['SUMMARY', 'BEFORE']) {
    await asOwner(x.admin, a => a.query(`UPDATE si.sources SET supported_networks = '{META,TIKTOK,GOOGLE}' WHERE source_id = $1`, [SRC]));
    await asOwner(x.admin, a => a.query(variant === 'SUMMARY' ? FN23 : FN18));
    const alice = await readerSession(db), cc = counting(alice), collector = await connect({ user: 'si_collector', database: db });
    await INTEL.searchAdvertisers(cc, { sources: [SRC], query: 'zzz-none', limit: 20 }).catch(() => {});
    let stop = false, published = 0, purged = 0;
    const pub = (async () => { while (!stop) { await publish(x, collector, built + published + (variant === 'BEFORE' ? 100000 : 0)); published++; } })();
    const pur = (async () => { while (!stop) { const r = (await x.si_retention.query('SELECT * FROM si.si_purge_due(2)')).rows[0]; if (r?.outcome === 'PURGED') purged += Number(r.runs_purged); await new Promise(z => setTimeout(z, 20)); } })();
    const load = { selective: [], rare: [] }, paths = new Set(), errors = [];
    try {
      for (let i = 0; i < N; i++) for (const [k, q] of [['selective', 'advertiser 01'], ['rare', 'rare']]) {
        try { const r = await timed(alice, () => INTEL.searchAdvertisers(cc, { sources: [SRC], query: q, limit: 20 })); if (r.refusal) errors.push(r.refusal); if (!r.retried) load[k].push(r.ms); paths.add(r.path); }
        catch (e) { errors.push(e.code ?? e.message); }
      }
    } finally { stop = true; await pub; await pur; await collector.end(); await alice.end(); }
    console.log(`# SSB LOAD ${variant} ${built} runs (+${published} published, ${purged} purged during the measurement): search selective ${fmt(load.selective)}, rare ${fmt(load.rare)}; paths ${[...paths].join('/')}; refusals ${JSON.stringify(errors)}`);
    // BUSY (SI_READ_BUSY: the source lock was not granted within lock_timeout = 2 s because a purge held it) is the
    // documented typed refusal of both variants under a concurrent purge; anything else fails.
    assert.deepEqual(errors.filter(e => e !== 'BUSY'), [], `${variant} under load: no refusal other than BUSY`);
    if (variant === 'SUMMARY') assert.deepEqual([...paths], ['summary']);
  }
  console.log(`# SSB summary ${JSON.stringify(results.map(r => ({ l: r.label, runs: r.runs, readable: r.readable,
    search: Object.fromEntries(Object.entries(r.search).map(([k, a]) => [k, [pct(a, 50), pct(a, 95)].map(v => +v.toFixed(1))])),
    history: Object.fromEntries(Object.entries(r.history).map(([k, a]) => [k, [pct(a, 50), pct(a, 95)].map(v => +v.toFixed(1))])),
    eligibility: [pct(r.eligibility, 50), pct(r.eligibility, 95)].map(v => +v.toFixed(1)) })))}`);
});

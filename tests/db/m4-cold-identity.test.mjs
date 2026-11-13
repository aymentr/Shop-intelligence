// B-002 M4-P2.2: cold-database query reliability (N1, migration 0016) and identity-conflict hardening (N2, N3) of the
// server-side reader functions. Real disposable PostgreSQL 16, synthetic sources only.
//
// Fixtures a product path cannot perform, labelled where used:
//   - COLD: autovacuum disabled on the si tables of the disposable clone and no ANALYZE, so the planner has no
//     statistics for the ingested evidence (the state of a source right after bulk ingestion, of a freshly migrated
//     database and of a pg_restore'd one). track_functions = 'all' on the clone counts si_evidence_readable calls.
//   - COLLISION: SHA-256 collisions cannot be constructed, so an instrumented COPY of the history function selects by
//     a deliberately weak key (the first character of the normalized name) instead of si_advertiser_key; everything
//     else, including the identity guard, is the production text.
//   - Instrumented or mutated COPIES of the 0016 functions and of the library in disposable databases / directories.
//
//   COLD-1  N1  a 5,000-observation history and a concentrated search on a database without statistics: every page
//               succeeds within a 2 s statement timeout and evaluates si_evidence_readable exactly once per run;
//               the bound is still refused after one page; results equal those computed with statistics.
//   COLD-2  N1  cold results equal the client-side oracle over INVALID, UNVERIFIABLE, pending and expired evidence.
//   COLD-3  N1b plan_cache_mode is pinned (force_custom_plan) inside both functions, whatever the reader's session says.
//   IDG-1   N2/N3 colliding spellings sorting before and after the legitimate ones: the page is refused (never merged,
//               never a partial history, never a corrupted page sequence) with a typed, content-free IDENTITY_CONFLICT;
//               filters that exclude the colliding rows return exactly the advertiser's own observations.
//   COLD-M / IDG-M  negative-control mutants, each killed for its intended reason.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { asOwner, cfg, connect, createSources, freshDatabase, recordRights, roles, settle } from './helpers.mjs';
import { provisionReaderPrincipal } from '../../dist/persistence/bootstrap.js';
import { fixtureSha256, requestSha256 } from '../../dist/persistence/request-hash.js';
import { grantReader, beginRead } from '../../dist/persistence/reader.js';
import * as INTEL from '../../dist/persistence/intelligence.js';

const DIST = fileURLToPath(new URL('../../dist/persistence/', import.meta.url));
const MIG16 = readFileSync(new URL('../../db/migrations/0016_cold_query_reliability.up.sql', import.meta.url), 'utf8');
const ROLES = ['admin', 'si_rights_admin', 'si_collector', 'si_monitor'];
const CONFLICT = 'SI_READ_IDENTITY_CONFLICT: the advertiser key selects another normalized name';
let n = 0;
test.before(async () => { const a = await connect(); try { await provisionReaderPrincipal(a, 'si_reader_alice', cfg.rolePassword); } finally { await a.end(); } });

function mutate(text, from, to) { assert.equal(text.split(from).length, 2, `exactly one anchor: ${from.slice(0, 70)}`); return text.replace(from, to); }
const fnText = (start, end) => { const s = MIG16.indexOf(start); return MIG16.slice(s, MIG16.indexOf(end, s) + end.length); };
const SEARCH_FN = fnText('CREATE OR REPLACE FUNCTION si.si_search_advertisers', 'END $search$;');
const HISTORY_FN = fnText('CREATE OR REPLACE FUNCTION si.si_advertiser_history', 'END $history$;');
const MIG15 = readFileSync(new URL('../../db/migrations/0015_intelligence_remediation.up.sql', import.meta.url), 'utf8');
/** The 0015 history function (readable runs joined inside the page statement), with the 0016 plan_cache_mode pin added,
 *  so that the mutant differs from 0016 only in the N1 change. */
const HISTORY_0015 = (() => { const s = MIG15.indexOf('CREATE OR REPLACE FUNCTION si.si_advertiser_history'); const e = 'END $history$;';
  return MIG15.slice(s, MIG15.indexOf(e, s) + e.length).replace("SET temp_file_limit = '256MB'\n", "SET temp_file_limit = '256MB'\nSET plan_cache_mode = force_custom_plan\n"); })();
const PIN = 'SET plan_cache_mode = force_custom_plan\n';

async function fresh(t, prefix = 'm4cold', { cold = false } = {}) {
  const db = await freshDatabase(t, prefix);
  const x = await roles(t, db, ROLES);
  const extra = [];
  t.after(async () => { for (const e of extra) await e.end().catch(() => {}); });
  if (cold) {                                                                // fixture: no statistics will be gathered
    await x.admin.query(`DO $$ DECLARE r record; BEGIN FOR r IN SELECT c.oid::regclass AS t FROM pg_class c
                           WHERE c.relnamespace = 'si'::regnamespace AND c.relkind = 'r' LOOP
                           EXECUTE format('ALTER TABLE %s SET (autovacuum_enabled = off)', r.t); END LOOP; END $$`);
  }
  await x.admin.query(`ALTER DATABASE ${db} SET track_functions = 'all'`);  // fixture: count si_evidence_readable calls
  Object.defineProperty(x, 'db', { value: db, enumerable: false });
  Object.defineProperty(x, 'connect', { enumerable: false, value: async user => { const k = await connect({ user, database: db }); extra.push(k); return k; } });
  return x;
}
const AD = (advertiser, id, o = {}) => ({ network: 'META', nativeAdId: id, advertiserName: advertiser, countries: ['DE'], seenAt: '2026-01-01T00:00:00.000Z',
  sourceUrl: `https://example.test/${id}`, destinationUrl: 'https://example.test/d', creativeUrl: 'https://example.test/c', title: `Synthetic ${id}`, ...o });
async function source(x, { networks = ['META', 'TIKTOK'] } = {}) {
  const name = `cold-${++n}`;
  await createSources(x.admin, [name], networks);
  await recordRights(x.si_rights_admin, name, {});
  await grantReader(x.si_rights_admin, 'si_reader_alice', name, 'm4-p2.2 cold and identity');
  return name;
}
async function collect(x, src, rows, { verify = true } = {}) {
  const networks = [...new Set(rows.map(r => r.network))].sort();
  const fx = fixtureSha256(rows), sha = requestSha256({ adapterId: src, evidenceKind: 'SYNTHETIC', networks, fixtureSha256: fx });
  const run = (await x.si_collector.query('SELECT * FROM si.si_begin_run_scoped($1,$2,$3,$4,$5::text[],$6)', [src, `cold${++n}`, sha, 'SYNTHETIC', networks, fx])).rows[0];
  await x.si_collector.query('BEGIN');
  try { await x.si_collector.query('SELECT * FROM si.si_complete_run($1::uuid, $2::uuid, $3::jsonb)', [run.run_id, run.lease_token, JSON.stringify(rows)]); await x.si_collector.query('COMMIT'); }
  catch (e) { await x.si_collector.query('ROLLBACK').catch(() => {}); throw e; }
  if (verify) for (let i = 0; i < 20; i++) { const r = await x.si_monitor.query('SELECT * FROM si.si_verify_receipts(500)'); if (!r.rows.length || Number(r.rows[0].verified) === 0) break; }
  return run.run_id;
}
async function replica(x, sql, params) {
  await x.admin.query('BEGIN');
  try { await x.admin.query('SET LOCAL session_replication_role = replica'); await x.admin.query(sql, params); await x.admin.query('COMMIT'); }
  catch (e) { await x.admin.query('ROLLBACK').catch(() => {}); throw e; }
}
const expire = (x, run) => replica(x, `UPDATE si.collection_runs SET retain_until = clock_timestamp() - interval '1 minute' WHERE run_id = $1`, [run]);
const invalid = (x, run) => replica(x, `INSERT INTO si.receipt_verifications (run_id, source_id, rights_version_id, verdict, reason, commit_xid, commit_ts, window_start, window_end, verified_at, verified_by)
    SELECT r.run_id, r.source_id, r.rights_version_id, 'INVALID', 'COMMITTED_AFTER_WINDOW', 3, r.finished_at, r.finished_at - interval '1 hour', r.finished_at, clock_timestamp(), 'fixture'
      FROM si.collection_runs r WHERE r.run_id = $1`, [run]);
async function libOutcome(promise, count = v => v?.observations?.length ?? v?.hits?.length ?? 0) {
  try { return `ok:${count(await promise)}`; } catch (e) {
    if (e?.name === 'IntelligenceFailed') return `INTEL:${e.code}${e.reasons?.length ? `:${e.reasons.join(',')}` : ''}`;
    if (e?.name === 'ReadFailed') return `READ:${e.code}`;
    return `OTHER:${e?.message}`;
  }
}
const us = d => (d ? d.toISOString().replace(/\.(\d{3})Z$/, '.$1000Z') : null);
const historyScope = (src, r) => INTEL.intelligenceScope('history', src, [r.q, r.n.join(','), us(r.from), us(r.to), r.after]);
async function retried(attempt) { let r; for (let i = 0; i < 3; i++) { r = await attempt(); if (!(r.status !== 'ok' && /^SI_READ_INTENT_NOT_DURABLE/.test(String(r.message)))) break; } return r; }
async function rawHistory(alice, src, name, limit, { networks = [], after = null } = {}) {
  let id;
  const r = await retried(async () => {
    id = await beginRead(alice, src, { cursor: historyScope(src, { q: name, n: networks, from: null, to: null, after }), limit });
    return settle(alice.query('SELECT si.si_advertiser_history($1, $2, $3, $4::text[], NULL, NULL, $5, $6) AS doc', [src, id, name, networks, after, limit]));
  });
  return { ...r, id };
}
/** si_evidence_readable calls recorded for the database so far (track_functions = 'all'; flushed explicitly). */
async function readableCalls(x, ...sessions) {
  for (const s of [x.admin, ...sessions]) await s.query('SELECT pg_stat_force_next_flush()');
  for (let i = 0; i < 40; i++) {                                             // flushed asynchronously: wait until stable
    const a = Number((await x.admin.query(`SELECT coalesce(sum(calls), 0) AS c FROM pg_stat_user_functions WHERE funcname = 'si_evidence_readable'`)).rows[0].c);
    await new Promise(r => setTimeout(r, 150));
    await x.admin.query('SELECT pg_stat_clear_snapshot()');
    const b = Number((await x.admin.query(`SELECT coalesce(sum(calls), 0) AS c FROM pg_stat_user_functions WHERE funcname = 'si_evidence_readable'`)).rows[0].c);
    if (a === b && i >= 6) return b;
  }
  throw new Error('function statistics did not settle');
}
const noStatistics = async x => Number((await x.admin.query(`SELECT count(*) AS c FROM pg_stats WHERE schemaname = 'si' AND tablename IN ('observations', 'collection_runs')`)).rows[0].c) === 0;
/** Counts server-side page requests through a client. */
function counting(client) {
  const c = { requests: 0, query: async (...args) => { const sql = typeof args[0] === 'string' ? args[0] : '';
    if (sql.includes('si.si_advertiser_history(') || sql.includes('si.si_search_advertisers(')) c.requests++; return client.query(...args); } };
  return c;
}
/** 10 runs of 500 observations of one advertiser (5,000), plus `extra` single-observation runs. */
async function concentrated(x, src, runs = 10) {
  for (let k = 0; k < runs; k++) await collect(x, src, Array.from({ length: 500 }, (_, i) => AD('Many Synthetic', `m${k}x${i}`)), { verify: k === runs - 1 });
}

// ------------------------------------------------------------------------------------------------
test('COLD-1 (N1): without statistics, history and search pages evaluate readability once per run and succeed; results equal the warm ones', async t => {
  const x = await fresh(t, 'm4cold1', { cold: true });
  const src = await source(x);
  await concentrated(x, src);
  const alice = await x.connect('si_reader_alice');
  await alice.query(`SET statement_timeout = '2s'`);                         // the fix may not rely on the 10 s ceiling
  assert.ok(await noStatistics(x), 'cold: no planner statistics for the evidence tables');
  const runs = 10;
  let c0 = await readableCalls(x, alice);
  const page = await rawHistory(alice, src, 'Many Synthetic', 100);
  let c1 = await readableCalls(x, alice);
  assert.equal(page.status, 'ok', `cold history page: ${page.message}`);
  assert.equal(page.value.rows[0].doc.summary.observations, 5000);
  console.log(`# COLD-1 cold history page: si_evidence_readable calls ${c1 - c0} (0015: 13,438 and a statement timeout)`);
  assert.equal(c1 - c0, runs, 'one readability evaluation per run of the source');
  const cc = counting(alice);
  c0 = await readableCalls(x, alice);
  const coldHistory = await INTEL.advertiserHistory(cc, src, 'Many Synthetic', { maxRecords: 5000 });
  c1 = await readableCalls(x, alice);
  console.log(`# COLD-1 cold library history: ${coldHistory.observations.length} observations, ${cc.requests} page requests, si_evidence_readable calls ${c1 - c0}`);
  assert.equal(coldHistory.observations.length, 5000);
  assert.ok(cc.requests >= 50 && cc.requests <= 50 + 2, 'fifty pages (plus at most two NOT_DURABLE retries, R-26; refused before evaluation)');
  assert.equal(c1 - c0, 50 * runs, 'every page: one evaluation per run');
  c0 = await readableCalls(x, alice);
  const coldSearch = await INTEL.searchAdvertisers(alice, { sources: [src], query: 'many', limit: 50 });
  c1 = await readableCalls(x, alice);
  assert.deepEqual([coldSearch.hits.length, coldSearch.hits[0].observations, c1 - c0], [1, 5000, runs]);
  // The bound is still refused after one page (not by a timeout): a second cold source with 5,001 observations.
  const big = await source(x);
  await concentrated(x, big); await collect(x, big, [AD('Many Synthetic', 'one-more')]);
  const cb = counting(alice);
  assert.equal(await libOutcome(INTEL.advertiserHistory(cb, big, 'Many Synthetic', { maxRecords: 5000 })), 'INTEL:SCAN_LIMIT');
  assert.ok(cb.requests <= 3, `refused after the first page (requests ${cb.requests}, NOT_DURABLE retries included)`);
  assert.ok(await noStatistics(x), 'still cold');
  // Warm: the same database with statistics gives identical results.
  await x.admin.query('ANALYZE');
  assert.ok(!(await noStatistics(x)));
  const warmHistory = await INTEL.advertiserHistory(alice, src, 'Many Synthetic', { maxRecords: 5000 });
  assert.deepEqual(warmHistory.observations, coldHistory.observations, 'warm equals cold');
  for (const k of ['firstObservedAt', 'lastObservedAt', 'distinctAds', 'runsWithEvidence', 'networks']) assert.deepEqual(warmHistory[k], coldHistory[k], k);
  const warmSearch = await INTEL.searchAdvertisers(alice, { sources: [src], query: 'many', limit: 50 });
  assert.deepEqual(warmSearch.hits, coldSearch.hits, 'warm search equals cold search');
});

test('COLD-2 (N1): cold results equal the client-side oracle over INVALID, UNVERIFIABLE, pending and expired evidence', async t => {
  const x = await fresh(t, 'm4cold2', { cold: true });
  const src = await source(x);
  await collect(x, src, [AD('Northwind Synthetic', 'n1'), AD('NORTHWIND  synthetic', 'n2', { network: 'TIKTOK' }), AD('Contoso Synthetic', 'c1')]);
  await collect(x, src, [AD('Northwind Synthetic', 'n1'), AD('Contoso Synthetic Labs', 'c2')]);
  const exp = await collect(x, src, [AD('Northwind Synthetic', 'x-expired')]); await expire(x, exp);
  const unv = await collect(x, src, [AD('Northwind Synthetic', 'x-unver')], { verify: false });
  await replica(x, 'UPDATE si.publication_receipts SET receipt_at = receipt_at WHERE run_id = $1', [unv]);  // identity disturbed
  await x.si_monitor.query('SELECT * FROM si.si_verify_receipts(500)');                                       // -> UNVERIFIABLE
  const inv = await collect(x, src, [AD('Northwind Synthetic', 'x-invalid')], { verify: false }); await invalid(x, inv);
  await collect(x, src, [AD('Northwind Synthetic', 'x-pending')], { verify: false });                        // never verified
  const alice = await x.connect('si_reader_alice');
  assert.ok(await noStatistics(x));
  for (const name of ['Northwind Synthetic', 'Contoso Synthetic', 'Nobody Synthetic']) {
    const server = await INTEL.advertiserHistory(alice, src, name, { pageSize: 1 });
    const oracle = await INTEL.advertiserHistoryClientScan(alice, src, name);
    assert.deepEqual(server.observations, oracle.observations, `${name}: observations`);
    for (const k of ['firstObservedAt', 'lastObservedAt', 'distinctAds', 'runsWithEvidence', 'networks']) assert.deepEqual(server[k], oracle[k], `${name}: ${k}`);
  }
  assert.deepEqual((await INTEL.advertiserHistory(alice, src, 'Northwind Synthetic')).observations.map(o => o.nativeAdId), ['n1', 'n2', 'n1'],
    'INVALID, UNVERIFIABLE, expired and pending evidence excluded on a cold database');
  const strip = h => ({ ...h, namesTruncated: undefined });
  const s = (await INTEL.searchAdvertisers(alice, { sources: [src], query: 'synthetic', limit: 50 })).hits.map(strip);
  const o = (await INTEL.searchAdvertisersClientScan(alice, { sources: [src], query: 'synthetic', limit: 50 })).hits.map(strip);
  assert.deepEqual(s, o, 'search equals the oracle');
});

const PCM = "current_setting('plan_cache_mode')";
const withPlanNotice = text => mutate(text, '  PERFORM si.si_claim_read_intent(', `  RAISE NOTICE 'PLANMODE %', ${PCM};\n  PERFORM si.si_claim_read_intent(`);
async function scnPlanMode(x, { search, history } = {}) {
  await asOwner(x.admin, a => a.query(withPlanNotice(search ?? SEARCH_FN)));
  await asOwner(x.admin, a => a.query(withPlanNotice(history ?? HISTORY_FN)));
  const src = await source(x); await collect(x, src, [AD('Northwind Synthetic', 'p1')]);
  const alice = await x.connect('si_reader_alice'), seen = [];
  alice.on('notice', m => { if (m.message.startsWith('PLANMODE ')) seen.push(m.message.slice(9)); });
  await alice.query('SET plan_cache_mode = force_generic_plan');            // the reader tries to force generic plans
  await INTEL.searchAdvertisers(alice, { sources: [src], query: 'north' });
  await INTEL.advertiserHistory(alice, src, 'Northwind Synthetic');
  return `value:${[...new Set(seen)].join(',')}`;
}
test('COLD-3 (N1b): plan_cache_mode is pinned to force_custom_plan inside both functions; the session cannot change it', async t => {
  const x = await fresh(t, 'm4cold3');
  const cfgOf = async f => (await x.admin.query(`SELECT proconfig FROM pg_proc WHERE oid = $1::regprocedure`, [f])).rows[0].proconfig;
  for (const f of ['si.si_search_advertisers(text, uuid, text, text[], timestamptz, timestamptz, text, boolean, int)', 'si.si_advertiser_history(text, uuid, text, text[], timestamptz, timestamptz, text, int)']) {
    assert.ok((await cfgOf(f)).includes('plan_cache_mode=force_custom_plan'), f);
  }
  assert.equal(await scnPlanMode(x), 'value:force_custom_plan', 'the reader\'s force_generic_plan is not in effect inside');
});

// ------------------------------------------------------------------------------------------------
/** Instrumented copy: selection by a deliberately weak key (first character of the normalized name). The identity
 *  guard and everything else are the production text, unless `guard` replaces the guard. */
const COLLIDING = mutate(HISTORY_FN, 'si.si_advertiser_key(o.advertiser_name) = nk', 'left(si.si_normalize_advertiser(o.advertiser_name), 1) = left(nn, 1)');
const PARTIAL_GUARD = mutate(COLLIDING, 'NOT EXISTS (SELECT 1 FROM unnest(a.names) AS u(nm) WHERE', 'NOT EXISTS (SELECT 1 FROM unnest(a.names[1:1]) AS u(nm) WHERE');
/** Legitimate spellings 'ACME' and 'Acme' (normalized 'acme'); the colliding 'Azure Synthetic' sorts AFTER both (C order). */
async function scnCollisionAfter(x, sql = COLLIDING) {
  await asOwner(x.admin, a => a.query(sql));
  const s = await source(x);
  await collect(x, s, [AD('ACME', 'a1'), AD('Acme', 'a2'), AD('Azure Synthetic', 'z1', { network: 'TIKTOK' }), AD('Bravo Synthetic', 'b1')]);
  return libOutcome(INTEL.advertiserHistory(await x.connect('si_reader_alice'), s, 'Acme'));
}
test('IDG-1 (N2/N3): colliding spellings before and after the legitimate ones are refused, typed and content-free; never merged or partial', async t => {
  const x = await fresh(t, 'm4idg1');
  await asOwner(x.admin, a => a.query(COLLIDING));
  const after = await source(x), before = await source(x);
  await collect(x, after, [AD('ACME', 'a1'), AD('Acme', 'a2'), AD('Azure Synthetic', 'z1', { network: 'TIKTOK' }), AD('Bravo Synthetic', 'b1')]);
  await collect(x, after, [AD('Acme', 'a1')]);
  await collect(x, before, [AD('AAA Synthetic', 'q1', { network: 'TIKTOK' }), AD('Acme', 'a1'), AD('ACME', 'a2')]);
  const alice = await x.connect('si_reader_alice');
  // The colliding name sorts after (names = ['ACME', 'Acme', 'Azure Synthetic']) and before (['AAA Synthetic', 'ACME', 'Acme']).
  for (const [s, label] of [[after, 'after'], [before, 'before']]) {
    for (const pageSize of [100, 1]) {
      let err = null;
      try { await INTEL.advertiserHistory(alice, s, 'Acme', { pageSize }); } catch (e) { err = e; }
      assert.ok(err instanceof INTEL.IntelligenceFailed, `${label}/${pageSize}: typed`);
      assert.deepEqual([err.code, err.sourceId, [...err.reasons], err.message], ['IDENTITY_CONFLICT', s, [], 'INTELLIGENCE_FAILED: IDENTITY_CONFLICT'], `${label}/${pageSize}`);
      const text = `${JSON.stringify(err)} ${String(err)} ${err.stack ?? ''} ${String(err.cause ?? '')}`.toLowerCase();
      for (const leak of ['azure', 'aaa', 'acme', 'normalized_name', 'si_read_identity_conflict']) assert.ok(!text.includes(leak), `${label}: nothing about the identities is exposed (${leak})`);
    }
  }
  // The actual database error and its audit: typed SQLSTATE 22000, exact message, nothing released, the intent on record.
  const raw = await rawHistory(alice, after, 'Acme', 100);
  assert.deepEqual([raw.status, raw.code, raw.message], ['db-error', '22000', CONFLICT]);
  const audit = (await x.admin.query(`SELECT i.state, (SELECT count(*)::int FROM si.reader_access_log l WHERE l.intent_id = i.intent_id) AS logged FROM si.read_intents i WHERE i.intent_id = $1`, [raw.id])).rows[0];
  assert.deepEqual(audit, { state: 'OPEN', logged: 0 });
  // A filter that excludes the colliding rows: exactly the advertiser's own observations, in order, across pages.
  const meta = await INTEL.advertiserHistory(alice, after, 'Acme', { networks: ['META'], pageSize: 1 });
  assert.deepEqual(meta.observations.map(o => o.nativeAdId), ['a1', 'a2', 'a1']);
  assert.deepEqual([meta.advertiser.normalizedName, [...meta.advertiser.names].sort(), meta.distinctAds], ['acme', ['ACME', 'Acme'], 2]);
  assert.equal(await libOutcome(INTEL.advertiserHistory(alice, after, 'Bravo Synthetic')), 'ok:1', 'an advertiser without a colliding name is unaffected');
  // Search computes identity from the full normalized name: separate advertisers, correct counts.
  const hits = (await INTEL.searchAdvertisers(alice, { sources: [after], query: 'a', limit: 50 })).hits.map(h => `${h.normalizedName}:${h.observations}`);
  assert.deepEqual(hits, ['acme:3', 'azure synthetic:1', 'bravo synthetic:1']);
});

// ------------------------------------------------------------------------------------------------
// Negative-control mutants: each baseline gives exactly its outcome, each mutant exactly the defect.
async function scnColdPage(x, sql) {                                         // one cold page of a 5,000-observation history
  if (sql) await asOwner(x.admin, a => a.query(sql));
  const src = await source(x); await concentrated(x, src);
  const alice = await x.connect('si_reader_alice'); await alice.query(`SET statement_timeout = '2s'`);
  if (!(await noStatistics(x))) return 'value:not cold';
  const c0 = await readableCalls(x, alice);
  const r = await rawHistory(alice, src, 'Many Synthetic', 100);
  const c1 = await readableCalls(x, alice);
  return r.status === 'ok' ? `ok:readable-calls=${c1 - c0}` : `SQLSTATE:${r.code}`;
}
async function mutatedLibrary(t, edits) {
  const dir = mkdtempSync(join(tmpdir(), 'si-cold-mutant-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  copyFileSync(join(DIST, 'reader.js'), join(dir, 'reader.js'));
  let text = readFileSync(join(DIST, 'intelligence.js'), 'utf8');
  for (const [from, to] of edits) text = mutate(text, from, to);
  writeFileSync(join(dir, 'intelligence.js'), text);
  return import(pathToFileURL(join(dir, 'intelligence.js')).href);
}
const DB_MUTANTS = [
  { name: 'readable runs joined inside the page statement (the 0015 shape)', baseline: 'ok:readable-calls=10', mutant: 'SQLSTATE:57014', cold: true,
    scenario: x => scnColdPage(x), copy: x => scnColdPage(x, HISTORY_0015) },
  { name: 'plan_cache_mode not pinned', baseline: 'value:force_custom_plan', mutant: 'value:force_generic_plan',
    scenario: x => scnPlanMode(x), copy: x => scnPlanMode(x, { search: mutate(SEARCH_FN, PIN, ''), history: mutate(HISTORY_FN, PIN, '') }) },
  { name: 'identity guard checks only the first spelling (collider sorts after)', baseline: 'INTEL:IDENTITY_CONFLICT', mutant: 'ok:3',
    scenario: x => scnCollisionAfter(x), copy: x => scnCollisionAfter(x, PARTIAL_GUARD) }
];
for (const m of DB_MUTANTS) {
  test(`COLD-M db (${m.name}): the baseline gives exactly its outcome, the mutant exactly the defect`, async t => {
    const base = await m.scenario(await fresh(t, 'm4cmb', { cold: m.cold }));
    const killed = await m.copy(await fresh(t, 'm4cmm', { cold: m.cold }));
    console.log(`# COLD-M db ${m.name}: baseline ${base}, mutant ${killed}`);
    assert.equal(base, m.baseline, `${m.name}: baseline outcome`);
    assert.equal(killed, m.mutant, `${m.name}: mutant outcome (killed for the intended reason)`);
  });
}
test('IDG-M lib (identity conflict not mapped): the baseline is the typed IDENTITY_CONFLICT, the mutant the untyped INTERNAL', async t => {
  const base = await scnCollisionAfter(await fresh(t, 'm4ilb'));
  const L = await mutatedLibrary(t, [["        if (sqlstate === '22000' && m === IDENTITY_CONFLICT_MESSAGE)\n            return new IntelligenceFailed('IDENTITY_CONFLICT', { sourceId });\n", '']]);
  const x = await fresh(t, 'm4ilm');
  await asOwner(x.admin, a => a.query(COLLIDING));
  const s = await source(x);
  await collect(x, s, [AD('ACME', 'a1'), AD('Acme', 'a2'), AD('Azure Synthetic', 'z1', { network: 'TIKTOK' })]);
  const killed = await libOutcome(L.advertiserHistory(await x.connect('si_reader_alice'), s, 'Acme'));
  console.log(`# IDG-M lib identity conflict not mapped: baseline ${base}, mutant ${killed}`);
  assert.equal(base, 'INTEL:IDENTITY_CONFLICT');
  assert.equal(killed, 'READ:INTERNAL');
});

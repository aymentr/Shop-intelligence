// B-002 M4-P2.1: remediation of M4-P2-ACCEPT-01 D1-D7 (migration 0015 and the library). Real disposable PostgreSQL 16,
// synthetic sources only. Fixtures a product path cannot perform are labelled where used (finished_at shift and an
// aged retention deadline as the test superuser under session_replication_role = replica; instrumented or mutated
// COPIES of the 0015 functions in disposable databases).
//
//   REM-1  D1  the response bound equals the audit bound: a page of exactly 262,144 bytes is released and audited as
//              262,144; one byte more is refused with SI_READ_RESULT_TOO_LARGE (never a CHECK violation); the library
//              reduces the page size and completes. Search pages above the bound likewise.
//   REM-2  D2  a history above the library bound is refused after ONE page (summary count), whatever the page size.
//   REM-3  D3  the resource settings pinned on the functions are the effective ones inside, whatever the reader's
//              session says; the reader cannot change temp_file_limit; temp-file and statement-time exhaustion are typed.
//   REM-4  D4/D5  names up to the documented maximum: ingestion, history, identity near the end, search pagination
//              across long names, cursor bounds (forged and oversized positions refused).
//   REM-5  D7  the documented between-page behaviour, asserted as it is (including what is NOT detected).
//   REM-M      negative-control mutants: each baseline gives exactly its outcome, each mutant exactly the defect.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { asOwner, cfg, connect, control, createSources, freshDatabase, lift, recordRights, roles, settle } from './helpers.mjs';
import { provisionReaderPrincipal } from '../../dist/persistence/bootstrap.js';
import { fixtureSha256, requestSha256 } from '../../dist/persistence/request-hash.js';
import { grantReader, revokeReader, beginRead } from '../../dist/persistence/reader.js';
import * as INTEL from '../../dist/persistence/intelligence.js';

const DIST = fileURLToPath(new URL('../../dist/persistence/', import.meta.url));
// M4-P2.2: the production text of the two reader functions is now 0016's (0015's with the readable runs selected first and a
// pinned plan_cache_mode); copies and mutants are built from it.
const MIG_FN = readFileSync(new URL('../../db/migrations/0016_cold_query_reliability.up.sql', import.meta.url), 'utf8');
const ROLES = ['admin', 'si_rights_admin', 'si_collector', 'si_retention', 'si_monitor'];
const AUDIT_LIMIT = 262144;
let n = 0;
test.before(async () => { const a = await connect(); try { await provisionReaderPrincipal(a, 'si_reader_alice', cfg.rolePassword); } finally { await a.end(); } });

async function fresh(t, prefix = 'm4rem') {
  const db = await freshDatabase(t, prefix);
  const x = await roles(t, db, ROLES);
  const extra = [];
  t.after(async () => { for (const e of extra) await e.end().catch(() => {}); });
  Object.defineProperty(x, 'db', { value: db, enumerable: false });
  Object.defineProperty(x, 'connect', { enumerable: false, value: async user => { const k = await connect({ user, database: db }); extra.push(k); return k; } });
  return x;
}
const AD = (advertiser, id, o = {}) => ({ network: 'META', nativeAdId: id, advertiserName: advertiser, countries: ['DE'], seenAt: '2026-01-01T00:00:00.000Z',
  sourceUrl: `https://example.test/${id}`, destinationUrl: 'https://example.test/d', creativeUrl: 'https://example.test/c', title: `Synthetic ${id}`, ...o });
async function source(x, { name = `rem-${++n}`, networks = ['META', 'TIKTOK'] } = {}) {
  await createSources(x.admin, [name], networks);
  await recordRights(x.si_rights_admin, name, {});
  await grantReader(x.si_rights_admin, 'si_reader_alice', name, 'm4-p2.1 remediation');
  return name;
}
async function collect(x, src, rows, { verify = true } = {}) {
  const networks = [...new Set(rows.map(r => r.network))].sort();
  const fx = fixtureSha256(rows), sha = requestSha256({ adapterId: src, evidenceKind: 'SYNTHETIC', networks, fixtureSha256: fx });
  const run = (await x.si_collector.query('SELECT * FROM si.si_begin_run_scoped($1,$2,$3,$4,$5::text[],$6)', [src, `rem${++n}`, sha, 'SYNTHETIC', networks, fx])).rows[0];
  await x.si_collector.query('BEGIN');
  try { await x.si_collector.query('SELECT * FROM si.si_complete_run($1::uuid, $2::uuid, $3::jsonb)', [run.run_id, run.lease_token, JSON.stringify(rows)]); await x.si_collector.query('COMMIT'); }
  catch (e) { await x.si_collector.query('ROLLBACK').catch(() => {}); throw e; }
  if (verify) await x.si_monitor.query('SELECT * FROM si.si_verify_receipts(500)');
  return run.run_id;
}
async function replica(x, sql, params) {
  await x.admin.query('BEGIN');
  try { await x.admin.query('SET LOCAL session_replication_role = replica'); await x.admin.query(sql, params); await x.admin.query('COMMIT'); }
  catch (e) { await x.admin.query('ROLLBACK').catch(() => {}); throw e; }
}
const at = (x, runId, iso) => replica(x, `UPDATE si.collection_runs SET started_at = $2::timestamptz - interval '1 second', finished_at = $2::timestamptz WHERE run_id = $1`, [runId, iso]);
const expire = (x, run) => replica(x, `UPDATE si.collection_runs SET retain_until = clock_timestamp() - interval '1 minute' WHERE run_id = $1`, [run]);
const DAY = 86400000;
const day = k => new Date(Date.UTC(2026, 9, 1) + k * DAY);
const reader = x => x.connect('si_reader_alice');
async function libOutcome(promise, count = v => v?.observations?.length ?? v?.hits?.length ?? 0) {
  try { return `ok:${count(await promise)}`; } catch (e) {
    if (e?.name === 'IntelligenceFailed') return `INTEL:${e.code}${e.reasons?.length ? `:${e.reasons.join(',')}` : ''}`;
    if (e?.name === 'ReadFailed') return `READ:${e.code}`;
    return `OTHER:${e?.message}`;
  }
}
const sqlOutcome = r => (r.status === 'ok' ? 'ok' : (String(r.message).match(/^SI_[A-Z_]+/)?.[0] ?? `SQLSTATE:${r.code}`));
/** Counts the server-side requests a client makes and runs `after(page)` after each successful page. */
/** Counts the audited page requests a client makes (`requests`) and runs `after(page)` after each released page.
 *  An attempt refused SI_READ_INTENT_NOT_DURABLE is counted apart (`notDurable`): the library repeats that same page
 *  with a fresh intent (its bounded retry), and the durability gate can refuse any single attempt fail-closed
 *  (M4-P2.2 CI-131: a WAL page boundary, R-35), so exact request counts exclude it. Every other failure counts. */
function counting(client, after = async () => {}) {
  const c = { requests: 0, notDurable: 0, pages: 0, query: async (...args) => {
    const sql = typeof args[0] === 'string' ? args[0] : '';
    const server = sql.includes('si.si_advertiser_history(') || sql.includes('si.si_search_advertisers(');
    if (server) c.requests++;
    let r;
    try { r = await client.query(...args); }
    catch (e) { if (server && /^SI_READ_INTENT_NOT_DURABLE:/.test(String(e?.message))) { c.requests--; c.notDurable++; } throw e; }
    if (server) { c.pages++; await after(c.pages); }
    return r;
  } };
  return c;
}
const us = d => (d ? d.toISOString().replace(/\.(\d{3})Z$/, '.$1000Z') : null);
const historyScope = (src, r) => INTEL.intelligenceScope('history', src, [r.q, r.n.join(','), us(r.from), us(r.to), r.after]);
const searchScope = (src, r) => INTEL.intelligenceScope('search', src, [r.q, r.n.join(','), us(r.from), us(r.to), r.after, String(r.incl)]);
async function retried(attempt) { let r; for (let i = 0; i < 3; i++) { r = await attempt(); if (!(r.status !== 'ok' && /^SI_READ_INTENT_NOT_DURABLE/.test(String(r.message)))) break; } return r; }
/** One raw history page as text: [outcome, bytes, intent id]. */
async function rawHistory(alice, src, name, limit, after = null) {
  let id;
  const r = await retried(async () => {
    id = await beginRead(alice, src, { cursor: historyScope(src, { q: name, n: [], from: null, to: null, after }), limit });
    return settle(alice.query('SELECT si.si_advertiser_history($1, $2, $3, $4::text[], NULL, NULL, $5, $6)::text AS doc', [src, id, name, [], after, limit]));
  });
  return { outcome: sqlOutcome(r), code: r.status === 'ok' ? null : r.code, bytes: r.status === 'ok' ? Buffer.byteLength(r.value.rows[0].doc, 'utf8') : null, id };
}
async function rawSearch(alice, src, query, limit, after = null, incl = false) {
  let id;
  const r = await retried(async () => {
    id = await beginRead(alice, src, { cursor: searchScope(src, { q: query, n: [], from: null, to: null, after, incl }), limit });
    return settle(alice.query('SELECT si.si_search_advertisers($1, $2, $3, $4::text[], NULL, NULL, $5, $6, $7)::text AS doc', [src, id, query, [], after, incl, limit]));
  });
  return { outcome: sqlOutcome(r), code: r.status === 'ok' ? null : r.code, bytes: r.status === 'ok' ? Buffer.byteLength(r.value.rows[0].doc, 'utf8') : null, id };
}
const intent = async (x, id) => (await x.admin.query(`SELECT i.state, i.bytes_returned, (SELECT count(*)::int FROM si.reader_access_log l WHERE l.intent_id = i.intent_id) AS logged
                                                       FROM si.read_intents i WHERE i.intent_id = $1`, [id])).rows[0];
let seed = 20261112;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
/** An incompressible 1,000-character CJK name (3,000 UTF-8 bytes). */
const cjk = (len = 1000, tail = '') => Array.from({ length: len - tail.length }, () => String.fromCodePoint(0x4e00 + Math.floor(rnd() * 20000))).join('') + tail;
/** A 1,000-character name whose spellings differ in case only: 990 control characters (6 JSON bytes each). */
const ctl = (k, variant) => `${variant}${String(k).padStart(2, '0')}${'\u0001'.repeat(1000 - variant.length - 2)}`;
const variants = word => Array.from({ length: 2 ** word.length }, (_, m) => [...word].map((ch, i) => (m >> i) & 1 ? ch.toUpperCase() : ch).join(''));

// ------------------------------------------------------------------------------------------------
test('REM-0: request counts exclude an attempt refused NOT_DURABLE (the library repeats that page), and only that', async t => {
  const x = await fresh(t);
  const s = await source(x);
  await collect(x, s, [AD('Northwind Synthetic', 'n0')]);
  const alice = await reader(x);
  let injected = 0;
  const refusing = { query: async (...args) => {                              // the first server call is refused like the gate does
    if (String(args[0]).includes('si.si_advertiser_history(') && injected++ === 0) {
      throw Object.assign(new Error('SI_READ_INTENT_NOT_DURABLE: the read intent is not yet durable; start a new read'), { code: '55000' });
    }
    return alice.query(...args);
  } };
  const c = counting(refusing);
  assert.equal(await libOutcome(INTEL.advertiserHistory(c, s, 'Northwind Synthetic')), 'ok:1');
  assert.deepEqual([c.requests, c.notDurable, c.pages], [1, 1, 1], 'one audited request; the refused attempt is counted apart');
  const other = { query: async (...args) => { if (String(args[0]).includes('si.si_advertiser_history(')) throw Object.assign(new Error('SI_READ_BUSY: x'), { code: '55P03' }); return alice.query(...args); } };
  const d = counting(other);
  assert.equal(await libOutcome(INTEL.advertiserHistory(d, s, 'Northwind Synthetic')), 'READ:BUSY');
  assert.deepEqual([d.requests, d.notDurable], [1, 0], 'any other refusal still counts');
});

test('REM-1 (D1): the real history function at the exact audit bound — 262,144 bytes released and audited, 262,145 refused typed', async t => {
  const x = await fresh(t);
  const alice = await reader(x);
  const NAME = 'Bulky Synthetic';
  const big = i => AD(NAME, `b${String(i).padStart(3, '0')}`, { title: 'T'.repeat(1000), sourceUrl: `https://example.test/${'u'.repeat(1700)}${String(i).padStart(3, '0')}` });
  const pad = extra => {                                                    // 0 <= extra <= 3,280: title, then URL, then ad id
    const e1 = Math.min(extra, 999), e2 = Math.min(extra - e1, 2026), e3 = extra - e1 - e2;
    assert.ok(e3 <= 252, `pad within range: ${extra}`);
    return AD(NAME, `pad${'i'.repeat(e3)}`, { title: 'P'.repeat(1 + e1), sourceUrl: `https://example.test/${'p'.repeat(e2)}` });
  };
  // Sources with names of equal length: every other field of the page is of fixed width (uuids, µs timestamps,
  // hashes, two-digit ordinals and counts), so the size is linear in the observations.
  const build = async (label, k, extra) => { const s = await source(x, { name: `rem-exact-${label}` }); await collect(x, s, Array.from({ length: k }, (_, i) => big(i))); await collect(x, s, [pad(extra)]); return s; };
  const p80 = await rawHistory(alice, await build('p', 80, 0), NAME, 100);
  const p81 = await rawHistory(alice, await build('q', 81, 0), NAME, 100);
  assert.deepEqual([p80.outcome, p81.outcome], ['ok', 'ok']);
  const per = p81.bytes - p80.bytes;                                        // one big observation and its separator
  const k = 80 + Math.floor((AUDIT_LIMIT - p80.bytes) / per), rest = (AUDIT_LIMIT - p80.bytes) % per;
  assert.ok(k + 1 <= 100 && rest + 1 <= 3280, `construction in range: k=${k} rest=${rest}`);
  const exactSrc = await build('x', k, rest), beyondSrc = await build('y', k, rest + 1);
  const exact = await rawHistory(alice, exactSrc, NAME, 100);
  const beyond = await rawHistory(alice, beyondSrc, NAME, 100);
  console.log(`# REM-1 page of ${k + 1} observations: exact ${exact.outcome} ${exact.bytes} bytes; one byte more ${beyond.outcome} (${beyond.code})`);
  assert.deepEqual([exact.outcome, exact.bytes], ['ok', AUDIT_LIMIT], 'exactly the audit bound is released');
  assert.deepEqual(await intent(x, exact.id), { state: 'CONSUMED', bytes_returned: AUDIT_LIMIT, logged: 1 }, 'and audited as exactly that size');
  assert.deepEqual([beyond.outcome, beyond.code], ['SI_READ_RESULT_TOO_LARGE', '54000'], 'one byte more: typed refusal, not a CHECK violation (23514)');
  assert.deepEqual(await intent(x, beyond.id), { state: 'OPEN', bytes_returned: null, logged: 0 }, 'a refused page releases nothing and stays on record');
  // The library: the refused size is halved (a new audited request), the history completes and equals the oracle count.
  const c = counting(alice);
  const h = await INTEL.advertiserHistory(c, beyondSrc, NAME);
  console.log(`# REM-1 library history of ${h.observations.length}: ${c.requests} requests (1 refused, page size 100 -> 50)`);
  assert.deepEqual([h.observations.length, c.requests], [k + 1, 3]);
  assert.equal(h.observations.at(-1).nativeAdId, `pad${'i'.repeat(Math.max(0, rest + 1 - 999 - 2026))}`);
});

test('REM-1b (D1): search pages above the bound are refused typed; the library reduces the page size and paginates completely', async t => {
  const x = await fresh(t);
  const s = await source(x);
  const names = Array.from({ length: 50 }, (_, i) => cjk(1000, `#${String(i).padStart(2, '0')}`));      // ~6.1 KB per hit
  await collect(x, s, names.map((nm, i) => AD(nm, `c${i}`)));
  const alice = await reader(x);
  const raw = await rawSearch(alice, s, '#', 50);
  assert.deepEqual([raw.outcome, raw.code], ['SI_READ_RESULT_TOO_LARGE', '54000']);
  assert.equal((await intent(x, raw.id)).state, 'OPEN');
  const c = counting(alice); const seen = []; let cursor = null, pages = 0;
  for (;;) { const p = await INTEL.searchAdvertisers(c, { sources: [s], query: '#', limit: 50, cursor }); seen.push(...p.hits.map(h => h.normalizedName)); pages++; if (!p.nextCursor) break; cursor = p.nextCursor; assert.ok(pages < 10); }
  console.log(`# REM-1b 50 hits of 1,000-character CJK names: ${pages} library pages, ${c.requests} audited requests`);
  assert.deepEqual(seen, names.map(nm => nm.toLowerCase()).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
  const audit = (await x.admin.query(`SELECT max(bytes_returned)::int AS m FROM si.read_intents WHERE state = 'CONSUMED'`)).rows[0].m;
  assert.ok(audit <= AUDIT_LIMIT && audit > AUDIT_LIMIT / 2, `released pages are near, never above, the bound: ${audit}`);
});

// ------------------------------------------------------------------------------------------------
test('REM-2 (D2): a history above the library bound is refused after one page', async t => {
  const x = await fresh(t);
  const s = await source(x);
  await collect(x, s, Array.from({ length: 12 }, (_, i) => AD('Many Synthetic', `m${i}`)));
  const alice = await reader(x);
  for (const pageSize of [1, 5, 100]) {
    const c = counting(alice);
    assert.equal(await libOutcome(INTEL.advertiserHistory(c, s, 'Many Synthetic', { pageSize, maxRecords: 11 })), 'INTEL:SCAN_LIMIT');
    assert.equal(c.requests, 1, `page size ${pageSize}: one audited request`);
  }
  // Exactly at the bound: complete; filters are part of the request the summary counts (no bypass through them).
  assert.equal(await libOutcome(INTEL.advertiserHistory(alice, s, 'Many Synthetic', { pageSize: 5, maxRecords: 12 })), 'ok:12');
  assert.equal(await libOutcome(INTEL.advertiserHistory(alice, s, 'Many Synthetic', { pageSize: 5, maxRecords: 11, networks: ['META'] })), 'INTEL:SCAN_LIMIT');
  assert.equal(await libOutcome(INTEL.advertiserHistory(alice, s, 'Many Synthetic', { pageSize: 5, maxRecords: 11, networks: ['TIKTOK'] })), 'ok:0');
  // Growth above the bound between pages: the summary differs from the first page's -> RESULT_CHANGED, never a longer result.
  const g = counting(alice, async p => { if (p === 1) await collect(x, s, [AD('Many Synthetic', 'late')]); });
  assert.equal(await libOutcome(INTEL.advertiserHistory(g, s, 'Many Synthetic', { pageSize: 5, maxRecords: 12 })), 'INTEL:RESULT_CHANGED');
});

// ------------------------------------------------------------------------------------------------
const fnText = (start, end) => { const s = MIG_FN.indexOf(start); return MIG_FN.slice(s, MIG_FN.indexOf(end, s) + end.length); };
const mutate = (text, from, to) => { assert.equal(text.split(from).length, 2, `exactly one anchor: ${from.slice(0, 70)}`); return text.replace(from, to); };
const SEARCH_FN = fnText('CREATE OR REPLACE FUNCTION si.si_search_advertisers', 'END $search$;');
const HISTORY_FN = fnText('CREATE OR REPLACE FUNCTION si.si_advertiser_history', 'END $history$;');
const SETTINGS = "concat_ws(' / ', current_setting('work_mem'), current_setting('hash_mem_multiplier'), current_setting('max_parallel_workers_per_gather'), current_setting('jit'), current_setting('temp_file_limit'), current_setting('statement_timeout'))";
const PINNED = '4MB / 2 / 0 / off / 256MB';

test('REM-3 (D3): pinned resource settings are effective inside the definer functions and cannot be relaxed by the reader', async t => {
  const x = await fresh(t);
  const s = await source(x);
  await collect(x, s, [AD('Northwind Synthetic', 'r1')]);
  const cfgOf = async f => (await x.admin.query(`SELECT proconfig FROM pg_proc WHERE oid = $1::regprocedure`, [f])).rows[0].proconfig;
  const want = ['search_path=pg_catalog, pg_temp', 'lock_timeout=2s', ...'work_mem=4MB|hash_mem_multiplier=2|max_parallel_workers_per_gather=0|jit=off|temp_file_limit=256MB|plan_cache_mode=force_custom_plan'.split('|')];
  assert.deepEqual(await cfgOf('si.si_search_advertisers(text, uuid, text, text[], timestamptz, timestamptz, text, boolean, int)'), want);
  assert.deepEqual(await cfgOf('si.si_advertiser_history(text, uuid, text, text[], timestamptz, timestamptz, text, int)'), want);
  const alice = await reader(x);
  await assert.rejects(alice.query(`SET temp_file_limit = -1`), e => e.code === '42501', 'the reader cannot change temp_file_limit');
  await assert.rejects(alice.query(`ALTER ROLE si_reader_alice SET temp_file_limit = -1`), e => e.code === '42501');
  // Effective values inside: an instrumented copy (the production text plus one NOTICE) under a relaxed session.
  const notices = []; alice.on('notice', m => notices.push(m.message));
  await asOwner(x.admin, a => a.query(mutate(SEARCH_FN, '  PERFORM si.si_claim_read_intent(', `  RAISE NOTICE 'SETTINGS %', ${SETTINGS};\n  PERFORM si.si_claim_read_intent(`)));
  await asOwner(x.admin, a => a.query(mutate(HISTORY_FN, '  PERFORM si.si_claim_read_intent(', `  RAISE NOTICE 'SETTINGS %', ${SETTINGS};\n  PERFORM si.si_claim_read_intent(`)));
  for (const q of ["SET work_mem = '1GB'", 'SET hash_mem_multiplier = 1000', 'SET max_parallel_workers_per_gather = 8', 'SET jit = on', "SET statement_timeout = '9s'"]) await alice.query(q);
  assert.equal((await alice.query(`SELECT ${SETTINGS} AS v`)).rows[0].v, '1GB / 1000 / 8 / on / -1 / 9s', 'the session really is relaxed');
  await INTEL.searchAdvertisers(alice, { sources: [s], query: 'north' });
  await INTEL.advertiserHistory(alice, s, 'Northwind Synthetic');
  const seen = [...new Set(notices.filter(m => m.startsWith('SETTINGS ')))];
  console.log(`# REM-3 inside the functions: ${seen.join('; ')}`);
  assert.deepEqual(seen, [`SETTINGS ${PINNED} / 9s`], 'pinned values inside; statement_timeout is the session\'s (at most 10 s, checked)');
  await assert.rejects(alice.query(`SET statement_timeout = '11s'`).then(() => INTEL.searchAdvertisers(alice, { sources: [s], query: 'north' })),
    e => e.name === 'ReadFailed' && e.code === 'UNSAFE_SESSION', 'a statement_timeout above 10 s is refused by the session check');
});

test('REM-3b (D3): temporary-file and statement-time exhaustion are typed RESOURCE_LIMIT, nothing is released', async t => {
  const x = await fresh(t);
  const s = await source(x);
  for (let k = 0; k < 8; k++) await collect(x, s, Array.from({ length: 500 }, (_, i) => AD('Heavy Synthetic', `h${k}-${i}`, { title: 'T'.repeat(400) })));
  const alice = await reader(x);
  // Instrumented copies with LOWERED bounds (the production values cannot be exhausted by a small fixture).
  await asOwner(x.admin, a => a.query(HISTORY_FN.replace(/SET work_mem = '[^']+'/, "SET work_mem = '64kB'").replace(/SET temp_file_limit = '[^']+'/, "SET temp_file_limit = '1MB'")));
  const before = (await x.admin.query(`SELECT count(*)::int AS n FROM si.reader_access_log`)).rows[0].n;
  assert.equal(await libOutcome(INTEL.advertiserHistory(alice, s, 'Heavy Synthetic')), 'INTEL:RESOURCE_LIMIT');
  const raw = await rawHistory(alice, s, 'Heavy Synthetic', 10);
  assert.deepEqual([raw.outcome, raw.code], ['SI_READ_RESOURCE_LIMIT', '54000']);
  assert.equal((await intent(x, raw.id)).state, 'OPEN');
  await asOwner(x.admin, a => a.query(mutate(SEARCH_FN, '  PERFORM si.si_claim_read_intent(', "  PERFORM pg_sleep(0.5);\n  PERFORM si.si_claim_read_intent(")));
  await alice.query(`SET statement_timeout = '200ms'`);
  assert.equal(await libOutcome(INTEL.searchAdvertisers(alice, { sources: [s], query: 'heavy' })), 'INTEL:RESOURCE_LIMIT');
  await alice.query('RESET statement_timeout');
  assert.equal((await x.admin.query(`SELECT count(*)::int AS n FROM si.reader_access_log`)).rows[0].n, before, 'nothing released');
});

// ------------------------------------------------------------------------------------------------
test('REM-4 (D4/D5): names up to the documented maximum — ingestion, history, identity, pagination and cursor bounds', async t => {
  const x = await fresh(t);
  const s = await source(x);
  const L = {
    long304: 'L'.repeat(290) + ' Synthetic Ltd',
    cjkA: cjk(1000, 'A'), cjkB: null,                                       // differ only in the last character
    fdfaZ: 'ﷺ'.repeat(999) + 'z',                                       // 17,983 characters, sorts before fdfa: a long position
    fdfa: 'ﷺ'.repeat(1000),                                            // normalizes to 18,000 characters
    astral: '\u{1F600}'.repeat(999) + 'x',                                  // 1,000 code points, 1,999 UTF-16 units
    ascii1000: 'a'.repeat(999) + 'b'
  };
  L.cjkB = L.cjkA.slice(0, -1) + 'B';
  // Ingestion of an incompressible 1,000-character CJK name: refused by the 0014 index (54000), accepted by 0015.
  await collect(x, s, [AD(L.long304, 'l1'), AD(L.cjkA, 'ca1'), AD(L.cjkA, 'ca2'), AD(L.cjkB, 'cb1'), AD(L.fdfa, 'f1'), AD(L.fdfaZ, 'f2'), AD(L.astral, 'e1'), AD(L.ascii1000, 'a1')]);
  const alice = await reader(x);
  const hist = async name => (await INTEL.advertiserHistory(alice, s, name)).observations.map(o => o.nativeAdId).join(',');
  assert.equal(await hist(L.long304), 'l1');
  assert.equal(await hist(L.cjkA), 'ca1,ca2', 'identity is the full name: the near-end difference is a different advertiser');
  assert.equal(await hist(L.cjkB), 'cb1');
  assert.equal(await hist(L.fdfa), 'f1');
  assert.equal(await hist(L.astral), 'e1', '1,000 code points are accepted although JavaScript counts 1,999 units');
  assert.equal(await hist(L.ascii1000), 'a1');
  assert.equal(await libOutcome(INTEL.advertiserHistory(alice, s, L.ascii1000 + 'c')), 'INTEL:BAD_ARGUMENT', 'above the documented maximum');
  assert.equal((await rawHistory(alice, s, 'a'.repeat(1001), 5)).outcome, 'SI_READ_BAD_ARGUMENT');
  // Search pagination with page size 1 across every long name (positions up to 18,000 characters).
  const seen = []; let cursor = null, longest = 0;
  const all = { sources: [s], limit: 1 };
  for (const query of ['a', 'b', 'x', 'صلى']) {
    cursor = null;
    for (let i = 0; i < 20; i++) {
      const p = await INTEL.searchAdvertisers(alice, { ...all, query, cursor });
      seen.push(...p.hits.map(h => `${query}:${[...h.normalizedName].length}`));
      if (!p.nextCursor) break;
      longest = Math.max(longest, p.nextCursor.length); cursor = p.nextCursor;
    }
  }
  console.log(`# REM-4 search pages (query:normalized length): ${seen.join(' ')}; longest cursor ${longest} characters`);
  assert.ok(seen.includes('صلى:17983') && seen.includes('صلى:18000'), 'the 18,000-character normalized name is reachable after a 17,983-character position');
  assert.ok(longest > 4096, 'cursors above the former 4,096-character limit are produced and accepted');
  // Forged and oversized positions are refused.
  const p1 = await INTEL.searchAdvertisers(alice, { sources: [s], query: 'a', limit: 1 });
  const dec = JSON.parse(Buffer.from(p1.nextCursor, 'base64url').toString('utf8'));
  const enc = o => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
  const bad = async c => libOutcome(INTEL.searchAdvertisers(alice, { sources: [s], query: 'a', limit: 1, cursor: c }));
  assert.equal(await bad(enc({ ...dec, a: [dec.a[0], 'rem-other'] })), 'INTEL:BAD_CURSOR', 'a position in a source not requested');
  assert.equal(await bad(enc({ ...dec, a: ['x'.repeat(18001), dec.a[1]] })), 'INTEL:BAD_CURSOR', 'a position longer than any normalized name');
  assert.equal(await bad('A'.repeat(200000)), 'INTEL:BAD_CURSOR', 'an oversized cursor');
  assert.equal((await rawSearch(alice, s, 'a', 1, 'x'.repeat(18001))).outcome, 'SI_READ_BAD_CURSOR', 'the server bounds the position too');
  assert.equal((await rawSearch(alice, s, 'a', 1, 'x'.repeat(18000))).outcome, 'ok');
});

test('REM-4b (D5/D1): the largest history page of one observation fits; the worst-case summary is bounded and flagged', async t => {
  const x = await fresh(t);
  const s = await source(x);
  // 64 spellings of one normalized name, each 1,000 characters of which 994 control characters (~5,970 JSON bytes):
  // unbounded, 50 spellings alone would be ~298 KB, above the audit bound for every page size.
  const sp = variants('abcdef').map(v => ctl(7, v));
  for (let k = 0; k < sp.length; k += 16) await collect(x, s, sp.slice(k, k + 16).map((nm, i) => AD(nm, `w${k + i}`, { title: '\u0001'.repeat(1000), sourceUrl: `https://example.test/${'"'.repeat(2000)}` })));
  const alice = await reader(x);
  const one = await rawHistory(alice, s, sp[0], 1);
  console.log(`# REM-4b worst-case page of one observation: ${one.outcome} ${one.bytes} bytes`);
  assert.equal(one.outcome, 'ok');
  assert.ok(one.bytes <= AUDIT_LIMIT);
  const c = counting(alice);
  const h = await INTEL.advertiserHistory(c, s, sp[0]);
  assert.equal(h.observations.length, 64);
  assert.equal(h.advertiser.namesTruncated, true);
  assert.ok(h.advertiser.names.length < 50 && h.advertiser.names.length >= 10, `spellings kept within 64 KiB: ${h.advertiser.names.length}`);
  assert.deepEqual(h.advertiser.names, [...sp].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).slice(0, h.advertiser.names.length), 'the first spellings in code point order');
  console.log(`# REM-4b library: ${c.requests} audited requests for 64 observations (page size reduced from 100)`);
});

// ------------------------------------------------------------------------------------------------
test('REM-5 (D7): between pages — what is detected and what is not (documented behaviour, asserted as it is)', async t => {
  const x = await fresh(t);
  const s = await source(x);
  for (let i = 0; i < 3; i++) await collect(x, s, [AD('Swap Synthetic', `g${i}`)]);
  const alice = await reader(x);
  // 1. Every page is authorized on its own: revoked between pages -> NOT_AUTHORIZED.
  let once = false;
  const revoked = counting(alice, async () => { if (!once) { once = true; await revokeReader(x.si_rights_admin, 'si_reader_alice', s, 'between pages'); } });
  assert.equal(await libOutcome(INTEL.advertiserHistory(revoked, s, 'Swap Synthetic', { pageSize: 1 })), 'READ:NOT_AUTHORIZED');
  await grantReader(x.si_rights_admin, 'si_reader_alice', s, 'again');
  // 2. NOT detected: revoked and restored between pages (the grant is not an input of the state token).
  once = false;
  const restored = counting(alice, async () => { if (!once) { once = true; await revokeReader(x.si_rights_admin, 'si_reader_alice', s, 'r'); await grantReader(x.si_rights_admin, 'si_reader_alice', s, 'g'); } });
  assert.equal(await libOutcome(INTEL.advertiserHistory(restored, s, 'Swap Synthetic', { pageSize: 1 })), 'ok:3');
  // 3. Detected: an availability change and change back between pages (state token).
  once = false;
  const suspended = counting(alice, async () => { if (!once) { once = true; await control(x.si_rights_admin, s, 'SUSPEND'); await lift(x.si_rights_admin, s); } });
  assert.equal(await libOutcome(INTEL.advertiserHistory(suspended, s, 'Swap Synthetic', { pageSize: 1 })), 'INTEL:AVAILABILITY_CHANGED');
  // 4. NOT detected: an add-and-remove swap that leaves the summary identical. Two runs at the same instant; after page
  //    1 one expires and the other's verification completes. Each page is correct when computed; the result mixes them.
  const s2 = await source(x);
  const w1 = await collect(x, s2, [AD('Swap Synthetic', 'w1')]);
  const w2 = await collect(x, s2, [AD('Swap Synthetic', 'w2')]);
  const w3 = await collect(x, s2, [AD('Swap Synthetic', 'w3')], { verify: false });
  await at(x, w1, day(1).toISOString());                                             // w1 first; w2 at exactly w3's instant
  await replica(x, 'UPDATE si.collection_runs SET finished_at = (SELECT finished_at FROM si.collection_runs WHERE run_id = $2) WHERE run_id = $1', [w2, w3]);
  once = false;
  const swapped = counting(alice, async () => { if (!once) { once = true; await expire(x, w2); await x.si_monitor.query('SELECT * FROM si.si_verify_receipts(500)'); } });
  const h = await INTEL.advertiserHistory(swapped, s2, 'Swap Synthetic', { pageSize: 1 });
  assert.deepEqual(h.observations.map(o => o.nativeAdId), ['w1', 'w3'], 'undetected: the result is no single state (w2 was replaced by w3)');
  // 5. Detected: any change of the summary (here: a new observation) -> RESULT_CHANGED.
  once = false;
  const grown = counting(alice, async () => { if (!once) { once = true; await collect(x, s2, [AD('Swap Synthetic', 'w4')]); } });
  assert.equal(await libOutcome(INTEL.advertiserHistory(grown, s2, 'Swap Synthetic', { pageSize: 1 })), 'INTEL:RESULT_CHANGED');
  // 6. Search keyset continuation: a name added before the position is not returned on later pages (no snapshot).
  const s3 = await source(x);
  await collect(x, s3, [AD('Bravo Synthetic', 'b'), AD('Delta Synthetic', 'd')]);
  const p1 = await INTEL.searchAdvertisers(alice, { sources: [s3], query: 'synthetic', limit: 1 });
  await collect(x, s3, [AD('Alpha Synthetic', 'a'), AD('Charlie Synthetic', 'c')]);
  const p2 = await INTEL.searchAdvertisers(alice, { sources: [s3], query: 'synthetic', limit: 5, cursor: p1.nextCursor });
  assert.deepEqual([...p1.hits, ...p2.hits].map(h => h.normalizedName), ['bravo synthetic', 'charlie synthetic', 'delta synthetic'], 'alpha (before the position) is not seen');
});

// ------------------------------------------------------------------------------------------------
// Negative controls (M4-P2-ACCEPT-01 D6 survivors and the new invariants).
async function scnSearchPeriodEnd(x) { const s = await source(x); const r = await collect(x, s, [AD('Northwind Synthetic', 'edge')]); await at(x, r, day(14).toISOString());
  return libOutcome(INTEL.searchAdvertisers(await reader(x), { sources: [s], query: 'north', period: { from: day(10), to: day(14) } })); }
async function scnHistoryNetwork(x) { const s = await source(x); await collect(x, s, [AD('Northwind Synthetic', 'm'), AD('Northwind Synthetic', 't', { network: 'TIKTOK' })]);
  return libOutcome(INTEL.advertiserHistory(await reader(x), s, 'Northwind Synthetic', { networks: ['META'] })); }
// The intent is taken in a safe session; the call is made with synchronous_commit off (its completion row would not be durable).
async function scnSearchSyncCommit(x) {
  const s = await source(x); await collect(x, s, [AD('Northwind Synthetic', 'sc')]);
  const alice = await reader(x), r = { q: 'north', n: [], from: null, to: null, after: null, incl: false };
  return sqlOutcome(await retried(async () => {
    const id = await beginRead(alice, s, { cursor: searchScope(s, r), limit: 5 });
    await alice.query('SET synchronous_commit = off');
    try { return await settle(alice.query('SELECT si.si_search_advertisers($1, $2, $3, $4::text[], NULL, NULL, NULL, false, 5) AS doc', [s, id, r.q, r.n])); }
    finally { await alice.query('RESET synchronous_commit'); }
  })); }
async function scnResponseBound(x) {                                         // a page above the audit bound, raw
  const s = await source(x); await collect(x, s, Array.from({ length: 50 }, (_, i) => AD(cjk(1000, `#${String(i).padStart(2, '0')}`), `rb${i}`)));
  const r = await rawSearch(await reader(x), s, '#', 50); return r.code === '23514' ? 'SQLSTATE:23514' : r.outcome; }
/** A digest collision cannot be constructed; it is simulated in an instrumented copy whose selector also takes another
 *  name. The identity guard must refuse the page instead of merging the two advertisers. */
const COLLIDING = mutate(HISTORY_FN, 'si.si_advertiser_key(o.advertiser_name) = nk', "(si.si_advertiser_key(o.advertiser_name) = nk OR o.advertiser_name = 'Acme Synthetic Labs')");
async function scnIdentityGuard(x, sql = COLLIDING) {
  await asOwner(x.admin, a => a.query(sql));
  const s = await source(x); await collect(x, s, [AD('Acme Synthetic', 'a'), AD('Acme Synthetic Labs', 'b')]);
  return libOutcome(INTEL.advertiserHistory(await reader(x), s, 'Acme Synthetic')); }
/** The source lock: a SUSPEND issued while a search page is being computed must wait for it (instrumented pause). Without the
 *  lock the SUSPEND commits mid-page and the page, checked AVAILABLE, silently releases nothing (ok:0): the FD21 defect. */
async function scnSearchLock(x, mutantSql) {
  // 0016: the pause is before the readable-run statement (after the lock and the availability check).
  const pause = "  PERFORM pg_sleep(coalesce(nullif(current_setting('si.test_pause', true), ''), '0')::float);\n    SELECT coalesce(array_agg(r.run_id), ";
  await asOwner(x.admin, a => a.query(mutate(mutantSql ?? SEARCH_FN, '    SELECT coalesce(array_agg(r.run_id), ', pause)));
  const s = await source(x); await collect(x, s, [AD('Northwind Synthetic', 'lk')]);
  const alice = await reader(x); await alice.query(`SET si.test_pause = '1.5'`);
  // Barrier: the reader's backend is inside the instrumented pause, i.e. past the lock and the availability check.
  const search = INTEL.searchAdvertisers(alice, { sources: [s], query: 'north' }).then(p => `search:ok:${p.hits.length}`, e => `search:${e.code}`);
  const paused = async () => (await x.admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = 'si_reader_alice'
                                                     AND datname = current_database() AND wait_event = 'PgSleep'`)).rows[0].n === 1;
  for (let i = 0; !(await paused()); i++) { if (i > 100) return 'value:the read never reached its pause'; await new Promise(r => setTimeout(r, 50)); }
  const t0 = performance.now();
  await control(x.si_rights_admin, s, 'SUSPEND');
  const waited = performance.now() - t0;                                      // the pause is 1.5 s
  return `value:${await search},suspend-${waited > 500 ? 'waited' : 'immediate'}`;
}
const DB_MUTANTS = [
  { name: 'search period end inclusive', scenario: scnSearchPeriodEnd, baseline: 'ok:0', mutant: 'ok:1',
    sql: mutate(SEARCH_FN, 'AND (p_from IS NULL OR (r.finished_at >= p_from AND r.finished_at < p_to))', 'AND (p_from IS NULL OR (r.finished_at >= p_from AND r.finished_at <= p_to))') },
  { name: 'history network filter omitted', scenario: scnHistoryNetwork, baseline: 'ok:1', mutant: 'ok:2',
    sql: mutate(HISTORY_FN, 'AND (cardinality(p_networks) = 0 OR o.network = ANY (p_networks))', 'AND true') },
  { name: 'search synchronous_commit protection omitted', scenario: scnSearchSyncCommit, baseline: 'SI_READ_UNSAFE_SESSION', mutant: 'ok',
    sql: mutate(SEARCH_FN, "CASE WHEN current_setting('synchronous_commit') = 'off' THEN 'synchronous_commit' END", 'NULL') },
  { name: 'search source lock omitted', scenario: x => scnSearchLock(x), baseline: 'value:search:ok:1,suspend-waited', mutant: 'value:search:ok:0,suspend-immediate',
    lock: true, sql: mutate(SEARCH_FN, 'PERFORM 1 FROM si.sources x WHERE x.source_id = p_source_id FOR SHARE;', 'PERFORM 1 FROM si.sources x WHERE x.source_id = p_source_id;') },
  { name: 'response bound above the audit bound (0014 value)', scenario: scnResponseBound, baseline: 'SI_READ_RESULT_TOO_LARGE', mutant: 'SQLSTATE:23514',
    sql: mutate(SEARCH_FN, 'max_bytes constant int := 262144;', 'max_bytes constant int := 1048576;') },
  { name: 'history identity guard omitted (simulated key collision)', scenario: x => scnIdentityGuard(x), baseline: 'INTEL:IDENTITY_CONFLICT', mutant: 'ok:2',
    copy: scnIdentityGuard, sql: mutate(COLLIDING, 'IF same_identity IS NOT TRUE THEN', 'IF false THEN') }
];
for (const m of DB_MUTANTS) {
  test(`REM-M db (${m.name}): the baseline gives exactly its outcome, the mutant exactly the defect`, async t => {
    const base = await m.scenario(await fresh(t, 'm4rb'));
    const x = await fresh(t, 'm4rm');
    let killed;
    if (m.lock) killed = await scnSearchLock(x, m.sql);
    else if (m.copy) killed = await m.copy(x, m.sql);
    else { await asOwner(x.admin, a => a.query(m.sql)); killed = await m.scenario(x); }
    console.log(`# REM-M db ${m.name}: baseline ${base}, mutant ${killed}`);
    assert.equal(base, m.baseline, `${m.name}: baseline outcome`);
    assert.equal(killed, m.mutant, `${m.name}: mutant outcome (killed for the intended reason)`);
  });
}

async function mutatedLibrary(t, edits) {
  const dir = mkdtempSync(join(tmpdir(), 'si-rem-mutant-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  copyFileSync(join(DIST, 'reader.js'), join(dir, 'reader.js'));
  let text = readFileSync(join(DIST, 'intelligence.js'), 'utf8');
  for (const [from, to] of edits) text = mutate(text, from, to);
  writeFileSync(join(dir, 'intelligence.js'), text);
  return import(pathToFileURL(join(dir, 'intelligence.js')).href);
}
async function lscnEarlyLimit(L, x) {                                        // 12 observations, bound 11, page size 2
  const s = await source(x); await collect(x, s, Array.from({ length: 12 }, (_, i) => AD('Many Synthetic', `e${i}`)));
  const c = counting(await reader(x));
  return `${await libOutcome(L.advertiserHistory(c, s, 'Many Synthetic', { pageSize: 2, maxRecords: 11 }))}/requests:${c.requests}`; }
async function lscnShrink(L, x) {                                            // a default-size page above the bound
  const s = await source(x); await collect(x, s, Array.from({ length: 60 }, (_, i) => AD('Long Synthetic', `z${i}`, { title: cjk(1000), sourceUrl: `https://example.test/${'q'.repeat(2000)}` })));
  return libOutcome(L.advertiserHistory(await reader(x), s, 'Long Synthetic')); }
async function lscnBoundary(L, x) {                                          // source A's page is reduced; B's hits sort after A's unreturned ones
  const a = await source(x), b = await source(x);
  const sp = variants('wxyz').slice(0, 10);                                  // 10 spellings per name (~66 KB per hit)
  for (let k = 1; k <= 5; k++) await collect(x, a, sp.map((v, i) => AD(`n${k}q ${v}${'\u0001'.repeat(990)}`, `a${k}-${i}`)));
  await collect(x, b, [AD('z1q Synthetic', 'z1'), AD('z2q Synthetic', 'z2')]);
  const alice = await reader(x), out = []; let cursor = null;
  for (let i = 0; i < 10; i++) { const p = await L.searchAdvertisers(alice, { sources: [a, b], query: 'q', limit: 5, cursor }); out.push(...p.hits.map(h => h.normalizedName.slice(0, 2))); if (!p.nextCursor) break; cursor = p.nextCursor; }
  return `value:${out.join(',')}`; }
const LIB_MUTANTS = [
  { name: 'history bound checked per observation only (D2)', scenario: lscnEarlyLimit, baseline: 'INTEL:SCAN_LIMIT/requests:1', mutant: 'INTEL:SCAN_LIMIT/requests:6',
    edits: [["            if (Number(d.summary.observations) > max)\n                throw new IntelligenceFailed('SCAN_LIMIT', { sourceId });\n", '']] },
  { name: 'no page-size reduction on RESULT_TOO_LARGE (D1)', scenario: lscnShrink, baseline: 'ok:60', mutant: 'INTEL:RESULT_TOO_LARGE',
    edits: [["if (!(e instanceof IntelligenceFailed && e.code === 'RESULT_TOO_LARGE' && n > 1))", 'if (true)']] },
  { name: 'search merge ignores a reduced source page', scenario: lscnBoundary, baseline: 'value:n1,n2,n3,n4,n5,z1,z2', mutant: 'value:n1,n2,z1,z2',
    edits: [['const hits = all.filter(h => !boundary || order(h, boundary) <= 0).slice(0, limit);', 'const hits = all.slice(0, limit);']] }
];
for (const m of LIB_MUTANTS) {
  test(`REM-M lib (${m.name}): the baseline gives exactly the correct outcome, the mutant exactly the defect`, async t => {
    const base = await m.scenario(INTEL, await fresh(t, 'm4rlb'));
    const L = await mutatedLibrary(t, m.edits);
    const killed = await m.scenario(L, await fresh(t, 'm4rlm'));
    console.log(`# REM-M lib ${m.name}: baseline ${base}, mutant ${killed}`);
    assert.equal(base, m.baseline, `${m.name}: baseline outcome`);
    assert.equal(killed, m.mutant, `${m.name}: mutant outcome (killed for the intended reason)`);
  });
}

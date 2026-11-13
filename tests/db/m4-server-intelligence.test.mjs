// B-002 M4-P2: server-side audited advertiser search and history (migration 0014). Real disposable PostgreSQL 16,
// synthetic sources only. The M4-P1 client-side scan is kept in the library as the reference oracle
// (advertiserHistoryClientScan / searchAdvertisersClientScan): SRV-1 requires the server results to equal it.
//
// Fixtures a product path cannot perform (labelled where used): finished_at time shift, a planted INVALID verdict, a
// disturbed receipt identity, an aged retention deadline (all as the test superuser under session_replication_role =
// replica), and instrumented or mutated COPIES of the 0014 functions in disposable databases (lowered bounds; mutants).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { asOwner, cfg, connect, control, createSources, freshDatabase, lift, recordRights, rejects, roles, settle } from './helpers.mjs';
import { provisionReaderPrincipal } from '../../dist/persistence/bootstrap.js';
import { fixtureSha256, requestSha256 } from '../../dist/persistence/request-hash.js';
import { grantReader, revokeReader, ReadFailed, beginRead } from '../../dist/persistence/reader.js';
import * as INTEL from '../../dist/persistence/intelligence.js';

const DIST = fileURLToPath(new URL('../../dist/persistence/', import.meta.url));
const MIG14 = readFileSync(new URL('../../db/migrations/0014_server_side_intelligence.up.sql', import.meta.url), 'utf8');
// The production text of the two reader functions is 0015's (M4-P2.1); si_availability_state is still 0014's.
// M4-P2.2: the production text of the two reader functions is now 0016's (0015's with the readable runs selected first and a
// pinned plan_cache_mode); copies and mutants are built from it.
const MIG_FN = readFileSync(new URL('../../db/migrations/0016_cold_query_reliability.up.sql', import.meta.url), 'utf8');
const ROLES = ['admin', 'si_rights_admin', 'si_collector', 'si_retention', 'si_monitor'];
let n = 0;
test.before(async () => {
  const a = await connect();
  try { for (const p of ['si_reader_alice', 'si_reader_bob']) await provisionReaderPrincipal(a, p, cfg.rolePassword); } finally { await a.end(); }
});
async function fresh(t, prefix = 'm4srv') {
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
async function source(x, { grant = true, networks = ['META', 'TIKTOK'] } = {}) {
  const src = `srv-${++n}`;
  await createSources(x.admin, [src], networks);
  await recordRights(x.si_rights_admin, src, {});
  if (grant) await grantReader(x.si_rights_admin, 'si_reader_alice', src, 'm4-p2 server-side intelligence');
  return src;
}
async function collect(x, src, rows, { verify = true } = {}) {
  const networks = rows.length ? [...new Set(rows.map(r => r.network))].sort() : ['META'];
  const fx = fixtureSha256(rows), sha = requestSha256({ adapterId: src, evidenceKind: 'SYNTHETIC', networks, fixtureSha256: fx });
  const run = (await x.si_collector.query('SELECT * FROM si.si_begin_run_scoped($1,$2,$3,$4,$5::text[],$6)', [src, `srv${++n}`, sha, 'SYNTHETIC', networks, fx])).rows[0];
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
const invalid = (x, run) => replica(x, `INSERT INTO si.receipt_verifications (run_id, source_id, rights_version_id, verdict, reason, commit_xid, commit_ts, window_start, window_end, verified_at, verified_by)
    SELECT r.run_id, r.source_id, r.rights_version_id, 'INVALID', 'COMMITTED_AFTER_WINDOW', 3, r.finished_at, r.finished_at - interval '1 hour', r.finished_at, clock_timestamp(), 'fixture'
      FROM si.collection_runs r WHERE r.run_id = $1`, [run]);
const expire = (x, run) => replica(x, `UPDATE si.collection_runs SET retain_until = clock_timestamp() - interval '1 minute' WHERE run_id = $1`, [run]);
const DAY = 86400000;
const day = k => new Date(Date.UTC(2026, 9, 1) + k * DAY);
const period = (a, b) => ({ from: day(a), to: day(b) });
const reader = x => x.connect('si_reader_alice');
const retire = (x, src, sqlTime) => x.si_rights_admin.query(`UPDATE si.sources SET retired_at = ${sqlTime} WHERE source_id = $1`, [src]);
async function libOutcome(promise, count = v => v?.observations?.length ?? v?.hits?.length ?? 0) {
  try { return `ok:${count(await promise)}`; } catch (e) {
    if (e?.name === 'IntelligenceFailed') return `INTEL:${e.code}${e.reasons?.length ? `:${e.reasons.join(',')}` : ''}`;
    if (e?.name === 'ReadFailed') return `READ:${e.code}`;
    return `OTHER:${e?.message}`;
  }
}
const sqlOutcome = r => (r.status === 'ok' ? 'ok' : (String(r.message).match(/^SI_[A-Z_]+/)?.[0] ?? `SQLSTATE:${r.code}`));
/** Runs `after(page, released)` right after every server-side page (or evidence page): a deterministic interleaving point. */
function interleaved(client, after) {
  let page = 0;
  return { query: async (...args) => {
    const r = await client.query(...args);
    const sql = typeof args[0] === 'string' ? args[0] : '';
    if (sql.includes('si.si_advertiser_history(')) await after(++page, r.rows[0].doc.observations.length);
    else if (sql.includes('si.si_search_advertisers(')) await after(++page, r.rows[0].doc.hits.length);
    return r;
  } };
}
const SEARCH_SQL = 'SELECT si.si_search_advertisers($1, $2, $3, $4::text[], $5, $6, $7, $8, $9) AS doc';
const HISTORY_SQL = 'SELECT si.si_advertiser_history($1, $2, $3, $4::text[], $5, $6, $7, $8) AS doc';
const us = d => (d ? d.toISOString().replace(/\.(\d{3})Z$/, '.$1000Z') : null);
const searchScope = (src, r) => INTEL.intelligenceScope('search', src, [r.q, r.n.join(','), us(r.from), us(r.to), r.after, String(r.incl)]);
const historyScope = (src, r) => INTEL.intelligenceScope('history', src, [r.q, r.n.join(','), us(r.from), us(r.to), r.after]);
/** A raw call with the library's bounded fresh-intent retry on INTENT_NOT_DURABLE only (nothing else is retried). */
async function retried(attempt) { let r; for (let i = 0; i < 3; i++) { r = await attempt(); if (!(r.status !== 'ok' && /^SI_READ_INTENT_NOT_DURABLE/.test(String(r.message)))) break; } return r; }

/** A rich synthetic dataset over two sources. */
async function dataset(x) {
  const a = await source(x), b = await source(x);
  const runs = {};
  runs.a1 = await collect(x, a, [AD('Northwind Synthetic', 'a1'), AD('NORTHWIND  synthetic', 'a2', { network: 'TIKTOK' }), AD('Contoso Synthetic', 'a3'),
                                 AD('Contoso Synthetic Labs', 'a4'), AD('Fabrikam Ltd', 'a5', { seenAt: '2026-02-01T00:00:00.000Z' })]);
  runs.a2 = await collect(x, a, [AD('Northwind Synthetic', 'a1'), AD('Contoso Synthetic', 'a6', { network: 'TIKTOK' }), AD('Ålesund Ægir', 'a7')]);
  runs.a3 = await collect(x, a, [AD('Northwind Synthetic', 'a8')]);
  runs.aExpired = await collect(x, a, [AD('Northwind Synthetic', 'x-expired')]);
  await expire(x, runs.aExpired);
  runs.b1 = await collect(x, b, [AD('Northwind Synthetic', 'b1'), AD('Shared Synthetic', 'b2'), AD('Contoso Synthetic', 'b3', { network: 'TIKTOK' })]);
  // Verification states, in an order no later verification can disturb:
  runs.aUnver = await collect(x, a, [AD('Northwind Synthetic', 'x-unver')], { verify: false });
  await replica(x, 'UPDATE si.publication_receipts SET receipt_at = receipt_at WHERE run_id = $1', [runs.aUnver]);   // fixture: identity disturbed
  await x.si_monitor.query('SELECT * FROM si.si_verify_receipts(500)');                                            // -> UNVERIFIABLE
  runs.aInvalid = await collect(x, a, [AD('Northwind Synthetic', 'x-invalid')], { verify: false });
  await invalid(x, runs.aInvalid);                                                                                  // fixture: INVALID verdict
  runs.aPending = await collect(x, a, [AD('Northwind Synthetic', 'x-pending')], { verify: false });                // never verified
  const shift = [[runs.a1, 1], [runs.a2, 3], [runs.a3, 6], [runs.aInvalid, 2], [runs.aUnver, 2], [runs.aExpired, 4], [runs.aPending, 5], [runs.b1, 2]];
  for (const [r, k] of shift) await at(x, r, new Date(day(k).getTime() + 3600000 * k).toISOString());
  return { a, b, runs };
}
const strip = h => ({ ...h, namesTruncated: undefined });
async function allSearch(fn, client, q) {
  const out = []; let cursor = null, pages = 0;
  for (;;) { const p = await fn(client, { ...q, cursor }); out.push(...p.hits.map(strip)); pages++; if (!p.nextCursor) break; cursor = p.nextCursor; assert.ok(pages < 50); }
  return out;
}

// ------------------------------------------------------------------------------------------------
test('SRV-1: server-side search and history equal the M4-P1 client-side oracle on a rich synthetic dataset', async t => {
  const x = await fresh(t);
  const { a, b } = await dataset(x);
  const alice = await reader(x);
  let compared = 0;
  for (const query of ['synthetic', 'north', 'contoso', 'labs', 'none-at-all', '  NORTHWIND ', 'ålesund']) {
    for (const p of [undefined, period(0, 10), period(2, 5)]) {
      for (const limit of [1, 2, 50]) {
        for (const networks of [undefined, ['META'], ['TIKTOK']]) {
          const q = { sources: [b, a], query, period: p, limit, ...(networks ? { networks } : {}) };
          const server = await allSearch(INTEL.searchAdvertisers, alice, q);
          const oracle = (await allSearch(INTEL.searchAdvertisersClientScan, alice, q)).sort((h, k) =>
            Buffer.compare(Buffer.from(h.normalizedName), Buffer.from(k.normalizedName)) || Buffer.compare(Buffer.from(h.sourceId), Buffer.from(k.sourceId)));
          assert.deepEqual(server, oracle, `search ${JSON.stringify({ query, p: !!p, limit, networks })}`);
          compared++;
        }
      }
    }
  }
  for (const [src, name] of [[a, 'Northwind Synthetic'], [a, 'northwind synthetic'], [a, 'Contoso Synthetic'], [a, 'Fabrikam Ltd'], [a, 'Nobody'], [b, 'Shared Synthetic'], [a, 'ÅLESUND ÆGIR']]) {
    for (const p of [undefined, period(0, 10), period(2, 5)]) {
      for (const pageSize of [1, 3, 100]) {
        const server = await INTEL.advertiserHistory(alice, src, name, { period: p, pageSize });
        const oracle = await INTEL.advertiserHistoryClientScan(alice, src, name, { period: p });
        for (const k of ['observations', 'firstObservedAt', 'lastObservedAt', 'sourceReportedFirstSeen', 'sourceReportedLastSeen', 'distinctAds', 'runsWithEvidence', 'networks', 'endOfActivity']) {
          assert.deepEqual(server[k], oracle[k], `history ${src} ${name} ${!!p} ${pageSize}: ${k}`);
        }
        assert.deepEqual([server.advertiser.normalizedName, [...server.advertiser.names].sort()], [oracle.advertiser.normalizedName, [...oracle.advertiser.names].sort()]);
        compared++;
      }
    }
  }
  const h = await INTEL.advertiserHistory(alice, a, 'Northwind Synthetic');
  assert.deepEqual(h.observations.map(o => o.nativeAdId), ['a1', 'a2', 'a1', 'a8'], 'INVALID, UNVERIFIABLE, expired and pending evidence are excluded');
  console.log(`# SRV-1 server equals the client-side oracle on ${compared} search and history requests`);
});

test('SRV-2: the audited scope binds the complete request; scopes cannot be substituted; malformed positions and oversized requests are refused', async t => {
  const x = await fresh(t);
  const src = await source(x), other = await source(x);
  await collect(x, src, [AD('Northwind Synthetic', 'n1'), AD('Contoso Synthetic', 'c1')]);
  const alice = await reader(x);
  const base = { q: 'north', n: ['META'], from: day(-400 + 40), to: day(0), after: null, incl: false, limit: 5 };
  base.from = new Date(Date.now() - 100 * DAY); base.to = new Date(Date.now() + DAY);
  const call = (id, r, s = src) => settle(alice.query(SEARCH_SQL, [s, id, r.q, r.n, r.from, r.to, r.after, r.incl, r.limit]));
  const variants = { query: { q: 'contoso' }, networks: { n: [] }, from: { from: new Date(base.from.getTime() + 1) }, to: { to: new Date(base.to.getTime() - 1) },
                     after: { after: 'a' }, inclusive: { incl: true }, limit: { limit: 6 } };
  const outcomes = {};
  for (const [k, v] of Object.entries(variants)) {
    const r = await retried(async () => call(await beginRead(alice, src, { cursor: searchScope(src, base), limit: base.limit }), { ...base, ...v }));
    outcomes[k] = sqlOutcome(r);
  }
  outcomes.otherSource = sqlOutcome(await retried(async () => call(await beginRead(alice, src, { cursor: searchScope(src, base), limit: 5 }), base, other)));
  const ok = await retried(async () => call(await beginRead(alice, src, { cursor: searchScope(src, base), limit: 5 }), base));
  console.log(`# SRV-2 search intent for request A, called with a changed field: ${JSON.stringify(outcomes)}; the exact request: ${sqlOutcome(ok)}`);
  assert.deepEqual(Object.values(outcomes), Array(8).fill('SI_READ_INTENT_INVALID'));
  assert.equal(sqlOutcome(ok), 'ok');
  // History: the same for name, networks, period and position; and scopes of other kinds never work.
  const hb = { q: 'Northwind Synthetic', n: [], from: null, to: null, after: null, limit: 10 };
  const hcall = (id, r) => settle(alice.query(HISTORY_SQL, [src, id, r.q, r.n, r.from, r.to, r.after, r.limit]));
  for (const v of [{ q: 'Contoso Synthetic' }, { q: 'northwind synthetic' }, { n: ['META'] }, { from: day(0), to: day(10) }, { after: '2026-10-01T00:00:00.000000Z|00000000-0000-4000-8000-000000000000|0' }, { limit: 11 }]) {
    const r = await retried(async () => hcall(await beginRead(alice, src, { cursor: historyScope(src, hb), limit: 10 }), { ...hb, ...v }));
    assert.equal(sqlOutcome(r), 'SI_READ_INTENT_INVALID', JSON.stringify(v));
  }
  const kinds = {
    'search intent -> history': async () => hcall(await beginRead(alice, src, { cursor: searchScope(src, { ...base, q: hb.q, n: [], from: null, to: null }), limit: 10 }), hb),
    'history intent -> search': async () => call(await beginRead(alice, src, { cursor: historyScope(src, { ...hb, q: 'north', n: ['META'], from: base.from, to: base.to }), limit: 5 }), base),
    'evidence intent -> search': async () => call(await beginRead(alice, src, { limit: 5 }), base),
    'availability intent -> history': async () => hcall(await beginRead(alice, src, { cursor: INTEL.availabilityCursor(src), limit: 1 }), { ...hb, limit: 1 }),
    'search scope -> evidence read': async () => { const c = searchScope(src, base); return settle(alice.query('SELECT * FROM si.si_read_evidence($1, $2, $3, 5)', [src, await beginRead(alice, src, { cursor: c, limit: 5 }), c])); },
    'search scope -> availability': async () => settle(alice.query('SELECT * FROM si.si_read_source_availability($1, $2)', [src, await beginRead(alice, src, { cursor: searchScope(src, { ...base, limit: 1 }), limit: 1 })]))
  };
  const kres = {};
  for (const [k, f] of Object.entries(kinds)) kres[k] = sqlOutcome(await retried(f));
  console.log(`# SRV-2 scope substitution across functions: ${JSON.stringify(kres)}`);
  for (const [k, v] of Object.entries(kres)) assert.ok(['SI_READ_INTENT_INVALID', 'SI_READ_BAD_CURSOR'].includes(v), `${k}: ${v}`);
  // Malformed positions, oversized and non-canonical requests: refused before anything is decided (fixed codes).
  const id = await beginRead(alice, src, { cursor: searchScope(src, base), limit: 5 });
  const bad = [
    [HISTORY_SQL, [src, id, 'Northwind Synthetic', [], null, null, 'not-a-position', 10], 'SI_READ_BAD_CURSOR'],
    [HISTORY_SQL, [src, id, 'Northwind Synthetic', [], null, null, '2026-10-01T00:00:00.000000Z|00000000-0000-4000-8000-000000000000|500', 10], 'SI_READ_BAD_CURSOR'],
    [SEARCH_SQL, [src, id, 'north', [], null, null, '', false, 5], 'SI_READ_BAD_CURSOR'],
    [SEARCH_SQL, [src, id, 'north', [], null, null, null, false, 51], 'SI_READ_BAD_ARGUMENT'],
    [HISTORY_SQL, [src, id, 'Northwind Synthetic', [], null, null, null, 101], 'SI_READ_BAD_ARGUMENT'],
    [SEARCH_SQL, [src, id, 'x'.repeat(301), [], null, null, null, false, 5], 'SI_READ_BAD_ARGUMENT'],
    [SEARCH_SQL, [src, id, '   ', [], null, null, null, false, 5], 'SI_READ_BAD_ARGUMENT'],
    [SEARCH_SQL, [src, id, 'north', ['TIKTOK', 'META'], null, null, null, false, 5], 'SI_READ_BAD_ARGUMENT'],
    [SEARCH_SQL, [src, id, 'north', ['META', 'META'], null, null, null, false, 5], 'SI_READ_BAD_ARGUMENT'],
    [SEARCH_SQL, [src, id, 'north', ['MYSPACE'], null, null, null, false, 5], 'SI_READ_BAD_ARGUMENT'],
    [SEARCH_SQL, [src, id, 'north', [], day(0), day(400), null, false, 5], 'SI_READ_BAD_ARGUMENT'],
    [SEARCH_SQL, [src, id, 'north', [], day(0), null, null, false, 5], 'SI_READ_BAD_ARGUMENT'],
    [SEARCH_SQL, [src, id, 'north', [], null, null, null, null, 5], 'SI_READ_BAD_ARGUMENT']
  ];
  for (const [sql, params, code] of bad) assert.equal(sqlOutcome(await settle(alice.query(sql, params))), code, JSON.stringify(params.slice(2)));
  assert.equal((await alice.query(SEARCH_SQL, [src, id, base.q, base.n, base.from, base.to, null, false, 5])).rows[0].doc.hits.length, 1,
    'refused malformed requests did not consume the intent');
  // Library: forged and foreign cursors, oversized queries.
  const q = { sources: [src], query: 'synthetic', limit: 1 };
  const p1 = await INTEL.searchAdvertisers(alice, q);
  assert.ok(p1.nextCursor);
  await assert.rejects(INTEL.searchAdvertisers(alice, { ...q, query: 'north', cursor: p1.nextCursor }), e => e.code === 'BAD_CURSOR', 'bound to the query');
  await assert.rejects(INTEL.searchAdvertisers(alice, { ...q, cursor: 'garbage' }), e => e.code === 'BAD_CURSOR');
  const forged = JSON.parse(Buffer.from(p1.nextCursor, 'base64url').toString()); forged.t[src] = '0'.repeat(32);
  await assert.rejects(INTEL.searchAdvertisers(alice, { ...q, cursor: Buffer.from(JSON.stringify(forged)).toString('base64url') }),
    e => e.code === 'AVAILABILITY_CHANGED', 'a forged state token fails closed');
  await assert.rejects(INTEL.searchAdvertisers(alice, { ...q, query: 'x'.repeat(301) }), e => e.code === 'BAD_ARGUMENT');
  await revokeReader(x.si_rights_admin, 'si_reader_alice', src, 'revoked');
  await assert.rejects(INTEL.searchAdvertisers(alice, { ...q, cursor: p1.nextCursor }), e => e instanceof ReadFailed && e.code === 'NOT_AUTHORIZED', 'a cursor is not a capability');
});

test('SRV-3: unauthorized sources, cross-source isolation, other roles and helpers', async t => {
  const x = await fresh(t);
  const granted = await source(x), ungranted = await source(x, { grant: false }), suspendedUngranted = await source(x, { grant: false });
  await collect(x, granted, [AD('Shared Synthetic', 'g1')]); await collect(x, ungranted, [AD('Shared Synthetic', 'u1')]);
  await control(x.si_rights_admin, suspendedUngranted, 'SUSPEND');
  const alice = await reader(x), bob = await x.connect('si_reader_bob');
  const outcomes = {};
  for (const [label, c, s] of [['unknown', alice, 'srv-no-such'], ['ungranted', alice, ungranted], ['ungranted+suspended', alice, suspendedUngranted], ['other reader', bob, granted]]) {
    outcomes[label] = [await libOutcome(INTEL.searchAdvertisers(c, { sources: [s], query: 'shared' })), await libOutcome(INTEL.advertiserHistory(c, s, 'Shared Synthetic')),
                       sqlOutcome(await settle(c.query(SEARCH_SQL, [s, '00000000-0000-4000-8000-000000000000', 'shared', [], null, null, null, false, 5])))];
  }
  console.log(`# SRV-3 ${JSON.stringify(outcomes)}`);
  for (const v of Object.values(outcomes)) assert.deepEqual(v, ['READ:NOT_AUTHORIZED', 'READ:NOT_AUTHORIZED', 'SI_READ_INTENT_INVALID']);
  await assert.rejects(INTEL.searchAdvertisers(alice, { sources: [granted, ungranted], query: 'shared' }), e => e.code === 'NOT_AUTHORIZED', 'no partial result');
  const both = await INTEL.searchAdvertisers(alice, { sources: [granted], query: 'shared' });
  assert.deepEqual(both.hits.map(h => [h.sourceId, h.observations]), [[granted, 1]]);
  for (const role of ['si_collector', 'si_monitor', 'si_retention', 'si_rights_admin']) {
    await rejects(assert, x[role].query(SEARCH_SQL, [granted, '00000000-0000-4000-8000-000000000000', 'shared', [], null, null, null, false, 5]), { code: '42501' });
    await rejects(assert, x[role].query(HISTORY_SQL, [granted, '00000000-0000-4000-8000-000000000000', 'shared', [], null, null, null, 5]), { code: '42501' });
  }
  for (const sql of [`SELECT si.si_normalize_advertiser('x')`, `SELECT si.si_intelligence_scope('search', 'x', ARRAY['a'])`, `SELECT * FROM si.si_availability_state('x', 'y')`,
                     `SELECT si.si_intelligence_iso(now())`, `SELECT si.si_intelligence_check_args('{}', NULL, NULL)`, 'SELECT count(*) FROM si.observations']) {
    await rejects(assert, alice.query(sql), { code: '42501' });
  }
});

test('SRV-4: availability is evaluated inside every page: typed reasons for granted readers; the token equals the FD21 availability token', async t => {
  const x = await fresh(t);
  const alice = await reader(x);
  const cases = [];
  const mk = async (label, reasons, make) => { const s = await source(x); await collect(x, s, [AD('Northwind Synthetic', `${label}1`)]); await make(s); cases.push([label, s, reasons]); };
  await mk('suspended', ['SUSPENDED'], s => control(x.si_rights_admin, s, 'SUSPEND'));
  await mk('terminated', ['TERMINATED'], s => control(x.si_rights_admin, s, 'TERMINATE_RETENTION'));
  await mk('retired', ['RETIRED'], s => retire(x, s, "clock_timestamp() + interval '30 seconds'"));
  await mk('rights', ['RIGHTS_RESTRICTED'], s => recordRights(x.si_rights_admin, s, { evaluation: 'DENIED', change_reason: 'withdrawn' }));
  await mk('retention', ['RETENTION_RESTRICTED'], s => recordRights(x.si_rights_admin, s, { retain: 'DENIED', retention_days: null, change_reason: 'withdrawn' }));
  for (const [label, s, reasons] of cases) {
    const want = `INTEL:SOURCE_UNAVAILABLE:${reasons.join(',')}`;
    assert.equal(await libOutcome(INTEL.searchAdvertisers(alice, { sources: [s], query: 'north' })), want, `${label}: search`);
    assert.equal(await libOutcome(INTEL.advertiserHistory(alice, s, 'Northwind Synthetic')), want, `${label}: history`);
  }
  const live = await source(x); await collect(x, live, [AD('Northwind Synthetic', 'tok')]);
  const tok = (await INTEL.sourceAvailability(alice, live)).stateToken;
  const page = await INTEL.searchSourcePage(alice, live, { query: 'north', networks: [], period: undefined, after: null, afterInclusive: false, limit: 5 });
  assert.equal(page.stateToken, tok, 'the server page token is the FD21 availability token of the same reader and state');
  const none = await INTEL.advertiserHistory(alice, live, 'Nobody Synthetic');
  assert.deepEqual([none.observations.length, none.availability.state, none.firstObservedAt], [0, 'AVAILABLE', null], 'no matching evidence: explicit AVAILABLE, empty');
});

test('SRV-5: between pages — source unavailable, a record expiring, no match, results changing, availability changing', async t => {
  const x = await fresh(t);
  const alice = await reader(x);
  const three = async () => { const s = await source(x); for (let i = 0; i < 3; i++) await collect(x, s, [AD('Northwind Synthetic', `r${n}-${i}`)]); return s; };
  const hist = (s, step) => libOutcome(INTEL.advertiserHistory(interleaved(alice, step), s, 'Northwind Synthetic', { pageSize: 1 }));
  const r = {};
  let s = await three(); r.unavailable = await hist(s, async p => { if (p === 1) await control(x.si_rights_admin, s, 'SUSPEND'); });
  s = await three(); r.suspendLift = await hist(s, async p => { if (p === 1) { await control(x.si_rights_admin, s, 'SUSPEND'); await lift(x.si_rights_admin, s); } });
  s = await three(); r.newVersion = await hist(s, async p => { if (p === 1) await recordRights(x.si_rights_admin, s, { change_reason: 'renewed' }); });
  s = await three(); r.rotation = await hist(s, async p => { if (p === 1) await asOwner(x.admin, a => a.query('SELECT si.si_rotate_availability_state_key()')); });
  s = await three(); r.retireAba = await hist(s, async p => { if (p === 1) { await retire(x, s, "clock_timestamp() + interval '30 seconds'"); await retire(x, s, 'NULL'); } });
  s = await three(); const runs = (await x.admin.query('SELECT run_id FROM si.collection_runs WHERE source_id = $1 ORDER BY finished_at', [s])).rows;
  r.recordExpired = await hist(s, async p => { if (p === 1) await expire(x, runs[2].run_id); });
  s = await three(); r.newCollection = await hist(s, async p => { if (p === 1) await collect(x, s, [AD('Northwind Synthetic', 'late')]); });
  s = await three(); const ra = await x.connect('si_rights_admin');
  r.rolledBackControl = await hist(s, async p => { if (p === 1) { await ra.query('BEGIN'); await control(ra, s, 'SUSPEND'); await ra.query('ROLLBACK'); } });
  s = await three(); r.noMatch = await libOutcome(INTEL.advertiserHistory(alice, s, 'Nobody Synthetic', { pageSize: 1 }));
  console.log(`# SRV-5 ${JSON.stringify(r)}`);
  assert.deepEqual(r, {
    unavailable: 'INTEL:SOURCE_UNAVAILABLE:SUSPENDED', suspendLift: 'INTEL:AVAILABILITY_CHANGED', newVersion: 'INTEL:AVAILABILITY_CHANGED',
    rotation: 'INTEL:AVAILABILITY_CHANGED', retireAba: 'INTEL:AVAILABILITY_CHANGED', recordExpired: 'INTEL:RESULT_CHANGED',
    newCollection: 'INTEL:RESULT_CHANGED', rolledBackControl: 'ok:3', noMatch: 'ok:0' });
  // Search: a change of availability between pages fails; new evidence between pages never duplicates or skips names already passed.
  const s1 = await source(x);
  await collect(x, s1, ['Alpha', 'Bravo', 'Charlie', 'Delta'].map((nm, i) => AD(`${nm} Synthetic`, `s${i}`)));
  const q = { sources: [s1], query: 'synthetic', limit: 2 };
  const p1 = await INTEL.searchAdvertisers(alice, q);
  await collect(x, s1, [AD('Aardvark Synthetic', 'early'), AD('Echo Synthetic', 'late')]);
  const p2 = await INTEL.searchAdvertisers(alice, { ...q, cursor: p1.nextCursor });
  const p3 = p2.nextCursor ? await INTEL.searchAdvertisers(alice, { ...q, cursor: p2.nextCursor }) : { hits: [] };
  const names = [...p1.hits, ...p2.hits, ...p3.hits].map(h => h.normalizedName);
  assert.deepEqual(names, ['alpha synthetic', 'bravo synthetic', 'charlie synthetic', 'delta synthetic', 'echo synthetic'],
    'keyset: no duplicate, no skip of later names; a name sorting before the position (aardvark) appears only in a new search');
  await control(x.si_rights_admin, s1, 'SUSPEND'); await lift(x.si_rights_admin, s1);
  await assert.rejects(INTEL.searchAdvertisers(alice, { ...q, cursor: p1.nextCursor }), e => e.code === 'AVAILABILITY_CHANGED');
});

test('SRV-6: request audit — one committed, consumed intent per page; repeated, in-transaction and concurrent reads', async t => {
  const x = await fresh(t);
  const src = await source(x);
  for (let i = 0; i < 3; i++) await collect(x, src, [AD('Northwind Synthetic', `q${i}`), AD('Contoso Synthetic', `c${i}`)]);
  const alice = await reader(x);
  const count = async () => (await x.admin.query(`SELECT count(*) FILTER (WHERE state = 'CONSUMED')::int AS c, count(*)::int AS n FROM si.read_intents`)).rows[0];
  const h = await INTEL.advertiserHistory(alice, src, 'Northwind Synthetic', { pageSize: 2 });
  assert.equal(h.observations.length, 3);
  assert.equal((await count()).c, 2, 'two history pages, two consumed requests');
  const logs = (await x.admin.query(`SELECT rows_returned FROM si.reader_access_log WHERE source_id = $1 ORDER BY rows_returned DESC`, [src])).rows.map(r => r.rows_returned);
  assert.deepEqual(logs, [2, 1], 'each completion row names exactly the observations released by its page');
  const r = { q: 'north', n: [], from: null, to: null, after: null, incl: false, limit: 5 };
  let id, res;
  for (let i = 0; i < 3; i++) { id = await beginRead(alice, src, { cursor: searchScope(src, r), limit: 5 }); res = await settle(alice.query(SEARCH_SQL, [src, id, r.q, r.n, r.from, r.to, r.after, r.incl, r.limit])); if (res.status === 'ok') break; }
  assert.equal(res.status, 'ok');
  assert.equal(sqlOutcome(await settle(alice.query(SEARCH_SQL, [src, id, r.q, r.n, r.from, r.to, r.after, r.incl, r.limit]))), 'SI_READ_INTENT_USED', 'an intent releases once');
  await alice.query('BEGIN');
  const inTx = await libOutcome(INTEL.searchAdvertisers(alice, { sources: [src], query: 'north' }));
  await alice.query('ROLLBACK');
  assert.equal(inTx, 'READ:INTENT_UNCOMMITTED', 'inside a caller transaction nothing is released');
  const id2 = await beginRead(alice, src, { cursor: searchScope(src, r), limit: 5 });
  const racers = await Promise.all(Array.from({ length: 6 }, () => x.connect('si_reader_alice')));
  const out = await Promise.all(racers.map(c => settle(c.query(SEARCH_SQL, [src, id2, r.q, r.n, r.from, r.to, r.after, r.incl, r.limit]))));
  assert.ok(out.filter(o => o.status === 'ok').length <= 1, 'racing readers on one intent release at most once');
  // A rights writer holding the source lock: the page waits (bounded by lock_timeout) and never reads a half-applied change.
  const ra = await x.connect('si_rights_admin');
  await ra.query('BEGIN'); await control(ra, src, 'SUSPEND');
  const waiting = libOutcome(INTEL.advertiserHistory(alice, src, 'Northwind Synthetic'));
  await new Promise(z => setTimeout(z, 300)); await ra.query('COMMIT');
  assert.equal(await waiting, 'INTEL:SOURCE_UNAVAILABLE:SUSPENDED', 'the page waited for the control and then saw it');
});

test('SRV-7: bounds — candidate cap, response cap and spelling cap fail closed with fixed codes (instrumented copies, lowered limits)', async t => {
  const x = await fresh(t);
  const src = await source(x);
  await collect(x, src, Array.from({ length: 12 }, (_, i) => AD(`Northwind Synthetic${' '.repeat(i % 2)}${i > 5 ? '' : ''}`, `b${i}`, { advertiserName: `NorthWind ${String.fromCharCode(65 + i)}`.replace(/ [A-L]$/, m => m) })));
  const alice = await reader(x);
  const fn = (name, end) => { const s = MIG_FN.indexOf(`CREATE OR REPLACE FUNCTION si.${name}`); return MIG_FN.slice(s, MIG_FN.indexOf(end, s) + end.length); };
  const SEARCH_FN = fn('si_search_advertisers', 'END $search$;'), HISTORY_FN = fn('si_advertiser_history', 'END $history$;');
  await asOwner(x.admin, a => a.query(SEARCH_FN.replace('max_candidates constant int := 200000;', 'max_candidates constant int := 3;')));
  assert.equal(await libOutcome(INTEL.searchAdvertisers(alice, { sources: [src], query: 'northwind' })), 'INTEL:SCAN_LIMIT');
  await asOwner(x.admin, a => a.query(SEARCH_FN.replace('max_bytes constant int := 262144;', 'max_bytes constant int := 300;')));
  assert.equal(await libOutcome(INTEL.searchAdvertisers(alice, { sources: [src], query: 'northwind' })), 'INTEL:RESULT_TOO_LARGE');
  await asOwner(x.admin, a => a.query(HISTORY_FN.replace('max_candidates constant int := 200000;', 'max_candidates constant int := 3;')));
  await collect(x, src, Array.from({ length: 4 }, (_, i) => AD('Same Synthetic', `s${i}`)));
  assert.equal(await libOutcome(INTEL.advertiserHistory(alice, src, 'Same Synthetic')), 'INTEL:SCAN_LIMIT');
  await asOwner(x.admin, a => a.query(SEARCH_FN));                            // the production function again
  // Spelling cap: 12 distinct spellings of one normalized name -> 10 names and the truncation flag.
  const s2 = await source(x);
  await collect(x, s2, Array.from({ length: 12 }, (_, i) => AD(`Acme${' '.repeat(i + 1)}Synthetic`.replace(/^Acme/, i % 2 ? 'ACME' : 'Acme').replace(/(\s+)/, s => s), `sp${i}`,
    { advertiserName: `${['Acme', 'ACME', 'acme', 'AcMe', 'aCME', 'ACme', 'AcmE', 'aCme', 'acMe', 'acmE', 'ACMe', 'AcME'][i]} Synthetic` })));
  const hit = (await INTEL.searchAdvertisers(alice, { sources: [s2], query: 'acme' })).hits[0];
  assert.deepEqual([hit.normalizedName, hit.names.length, hit.namesTruncated, hit.observations], ['acme synthetic', 10, true, 12]);
});

// ------------------------------------------------------------------------------------------------
// Negative-control mutants of the new invariants. Each scenario returns its EXACT outcome; baseline and mutant must
// each equal the expected one (an unrelated refusal, an unexpected success, or a persisting NOT_DURABLE fails).
function fnText(start, end, mig = MIG_FN) { const s = mig.indexOf(start); return mig.slice(s, mig.indexOf(end, s) + end.length).replace(/^CREATE FUNCTION/, 'CREATE OR REPLACE FUNCTION'); }
function mutate(text, from, to) { assert.equal(text.split(from).length, 2, `exactly one anchor: ${from.slice(0, 70)}`); return text.replace(from, to); }
const SEARCH_FN = fnText('CREATE OR REPLACE FUNCTION si.si_search_advertisers', 'END $search$;');
const HISTORY_FN = fnText('CREATE OR REPLACE FUNCTION si.si_advertiser_history', 'END $history$;');
const STATE_FN = fnText('CREATE FUNCTION si.si_availability_state', 'END $availability_state$;', MIG14);
const GRANT = 'IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM si.reader_grants g';
async function revokedBetween(x, src, kind) {                                 // the intent is taken while granted, the call made after the revocation
  const alice = await reader(x);
  const r = { q: 'Northwind Synthetic', n: [], from: null, to: null, after: null, incl: false, limit: 5 };
  return sqlOutcome(await retried(async () => {
    const id = await beginRead(alice, src, { cursor: kind === 'search' ? searchScope(src, r) : historyScope(src, r), limit: 5 });
    await revokeReader(x.si_rights_admin, 'si_reader_alice', src, 'between intent and call');
    const out = await settle(kind === 'search' ? alice.query(SEARCH_SQL, [src, id, r.q, r.n, r.from, r.to, r.after, r.incl, r.limit])
                                               : alice.query(HISTORY_SQL, [src, id, r.q, r.n, r.from, r.to, r.after, r.limit]));
    await grantReader(x.si_rights_admin, 'si_reader_alice', src, 'again');
    return out;
  }));
}
async function scnSearchGrant(x) { const s = await source(x); await collect(x, s, [AD('Northwind Synthetic', 'g')]); return revokedBetween(x, s, 'search'); }
async function scnHistoryGrant(x) { const s = await source(x); await collect(x, s, [AD('Northwind Synthetic', 'g')]); return revokedBetween(x, s, 'history'); }
async function scnSearchSuspended(x) { const s = await source(x); await collect(x, s, [AD('Northwind Synthetic', 'u')]); await control(x.si_rights_admin, s, 'SUSPEND');
  return libOutcome(INTEL.searchAdvertisers(await reader(x), { sources: [s], query: 'north' })); }
async function scnHistorySuspended(x) { const s = await source(x); await collect(x, s, [AD('Northwind Synthetic', 'u')]); await control(x.si_rights_admin, s, 'SUSPEND');
  return libOutcome(INTEL.advertiserHistory(await reader(x), s, 'Northwind Synthetic')); }
async function scnReadable(x) { const s = await source(x); await collect(x, s, [AD('Northwind Synthetic', 'ok')]); const bad = await collect(x, s, [AD('Northwind Synthetic', 'bad')], { verify: false });
  await invalid(x, bad); return libOutcome(INTEL.advertiserHistory(await reader(x), s, 'Northwind Synthetic')); }
async function scnSearchScopeQuery(x) {                                      // an intent for query A releases query B
  const s = await source(x); await collect(x, s, [AD('Northwind Synthetic', 'q'), AD('Contoso Synthetic', 'c')]);
  const alice = await reader(x), a = { q: 'contoso', n: [], from: null, to: null, after: null, incl: false, limit: 5 };
  return sqlOutcome(await retried(async () => settle(alice.query(SEARCH_SQL, [s, await beginRead(alice, s, { cursor: searchScope(s, a), limit: 5 }), 'north', [], null, null, null, false, 5])))); }
async function scnHistoryScopePeriod(x) {                                    // an intent for one period releases another
  const s = await source(x); await collect(x, s, [AD('Northwind Synthetic', 'p')]);
  const alice = await reader(x), a = { q: 'Northwind Synthetic', n: [], from: day(0), to: day(10), after: null, limit: 5 };
  return sqlOutcome(await retried(async () => settle(alice.query(HISTORY_SQL, [s, await beginRead(alice, s, { cursor: historyScope(s, a), limit: 5 }), a.q, [], day(1), day(10), null, 5])))); }
async function scnHistoryClaim(x) {                                          // an evidence-page intent releases history
  const s = await source(x); await collect(x, s, [AD('Northwind Synthetic', 'e')]);
  const alice = await reader(x);
  return sqlOutcome(await retried(async () => settle(alice.query(HISTORY_SQL, [s, await beginRead(alice, s, { limit: 5 }), 'Northwind Synthetic', [], null, null, null, 5])))); }
async function scnPeriodEnd(x) { const s = await source(x); const r = await collect(x, s, [AD('Northwind Synthetic', 'edge')]); await at(x, r, day(14).toISOString());
  return libOutcome(INTEL.advertiserHistory(await reader(x), s, 'Northwind Synthetic', { period: period(10, 14) })); }
async function scnIdentity(x) { const s = await source(x); await collect(x, s, [AD('Acme Synthetic', 'a'), AD('Acme Synthetic Labs', 'b')]);
  return libOutcome(INTEL.advertiserHistory(await reader(x), s, 'Acme Synthetic')); }
async function scnDistinct(x) { const s = await source(x); await collect(x, s, [AD('Northwind Synthetic', 'd1')]); await collect(x, s, [AD('Northwind Synthetic', 'd1')]);
  return `value:${(await INTEL.searchAdvertisers(await reader(x), { sources: [s], query: 'north' })).hits[0].distinctAds}`; }
async function scnStateRowVersion(x) {                                       // retire into the margin and back between pages: the state token must change
  const s = await source(x); for (let i = 0; i < 3; i++) await collect(x, s, [AD('Northwind Synthetic', `rv${n}-${i}`)]);
  return libOutcome(INTEL.advertiserHistory(interleaved(await reader(x), async p => { if (p === 1) { await retire(x, s, "clock_timestamp() + interval '30 seconds'"); await retire(x, s, 'NULL'); } }),
    s, 'Northwind Synthetic', { pageSize: 1 })); }
const DB_MUTANTS = [
  { name: 'search grant check omitted', scenario: scnSearchGrant, baseline: 'SI_READ_NOT_AUTHORIZED', mutant: 'ok', sql: mutate(SEARCH_FN, GRANT, 'IF NOT FOUND OR false AND NOT EXISTS (SELECT 1 FROM si.reader_grants g') },
  { name: 'history grant check omitted', scenario: scnHistoryGrant, baseline: 'SI_READ_NOT_AUTHORIZED', mutant: 'ok', sql: mutate(HISTORY_FN, GRANT, 'IF NOT FOUND OR false AND NOT EXISTS (SELECT 1 FROM si.reader_grants g') },
  { name: 'search availability check omitted', scenario: scnSearchSuspended, baseline: 'INTEL:SOURCE_UNAVAILABLE:SUSPENDED', mutant: 'ok:0',
    sql: mutate(SEARCH_FN, '    IF st.available IS NOT TRUE THEN', '    IF false THEN') },
  { name: 'history availability check omitted', scenario: scnHistorySuspended, baseline: 'INTEL:SOURCE_UNAVAILABLE:SUSPENDED', mutant: 'ok:0',
    sql: mutate(HISTORY_FN, '    IF st.available IS NOT TRUE THEN', '    IF false THEN') },
  { name: 'history readable-evidence predicate omitted', scenario: scnReadable, baseline: 'ok:1', mutant: 'ok:2',
    sql: mutate(HISTORY_FN, '       AND si.si_evidence_readable(r.run_id);', '       AND true;') },             // 0016: the readable-run statement
  { name: 'search scope does not bind the query', scenario: scnSearchScopeQuery, baseline: 'SI_READ_INTENT_INVALID', mutant: 'ok',
    sql: mutate(SEARCH_FN, "cur := si.si_intelligence_scope('search', p_source_id, ARRAY[p_query,", "cur := si.si_intelligence_scope('search', p_source_id, ARRAY['contoso',") },
  { name: 'history scope does not bind the period', scenario: scnHistoryScopePeriod, baseline: 'SI_READ_INTENT_INVALID', mutant: 'ok',
    sql: mutate(HISTORY_FN, "           si.si_intelligence_iso(p_from), si.si_intelligence_iso(p_to), p_after]);", "           si.si_intelligence_iso(timestamptz '2026-10-01T00:00:00Z'), si.si_intelligence_iso(p_to), p_after]);") },
  { name: 'history intent claim omitted', scenario: scnHistoryClaim, baseline: 'SI_READ_INTENT_INVALID', mutant: 'ok',
    sql: mutate(HISTORY_FN, '  PERFORM si.si_claim_read_intent(who, p_source_id, p_intent_id, cur, p_limit);', '') },
  { name: 'history period end inclusive', scenario: scnPeriodEnd, baseline: 'ok:0', mutant: 'ok:1',
    sql: mutate(HISTORY_FN, 'AND (p_from IS NULL OR (r.finished_at >= p_from AND r.finished_at < p_to))', 'AND (p_from IS NULL OR (r.finished_at >= p_from AND r.finished_at <= p_to))') },
  { name: 'history identity by substring', scenario: scnIdentity, baseline: 'ok:1', mutant: 'ok:2',
    sql: mutate(mutate(HISTORY_FN, 'si.si_advertiser_key(o.advertiser_name) = nk', 'strpos(si.si_normalize_advertiser(o.advertiser_name), nn) > 0'),
                'IF same_identity IS NOT TRUE THEN', 'IF false THEN') },          // 0015: selector and identity guard both removed
  { name: 'search distinct ads counted as observations', scenario: scnDistinct, baseline: 'value:1', mutant: 'value:2',
    sql: mutate(SEARCH_FN, 'count(DISTINCT (c.network, c.native_ad_id))::int AS distinct_ads', 'count(*)::int AS distinct_ads') },
  { name: 'server state token ignores the source row version', scenario: scnStateRowVersion, baseline: 'INTEL:AVAILABILITY_CHANGED', mutant: 'ok:3',
    sql: mutate(STATE_FN, "p_who, p_source_id, cs.row_version,", 'p_who, p_source_id,') }
];
for (const m of DB_MUTANTS) {
  test(`SRV-M db (${m.name}): the baseline gives exactly its outcome, the mutant exactly the defect`, async t => {
    const base = await m.scenario(await fresh(t, 'm4sb'));
    const x = await fresh(t, 'm4sm');
    await asOwner(x.admin, a => a.query(m.sql));
    const killed = await m.scenario(x);
    console.log(`# SRV-M db ${m.name}: baseline ${base}, mutant ${killed}`);
    assert.equal(base, m.baseline, `${m.name}: baseline outcome`);
    assert.equal(killed, m.mutant, `${m.name}: mutant outcome (killed for the intended reason)`);
  });
}

async function mutatedLibrary(t, edits) {
  const dir = mkdtempSync(join(tmpdir(), 'si-srv-mutant-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  copyFileSync(join(DIST, 'reader.js'), join(dir, 'reader.js'));
  let text = readFileSync(join(DIST, 'intelligence.js'), 'utf8');
  for (const [from, to] of edits) text = mutate(text, from, to);
  writeFileSync(join(dir, 'intelligence.js'), text);
  return import(pathToFileURL(join(dir, 'intelligence.js')).href);
}
async function lscnHistoryToken(L, x) {                                      // suspend + lift between history pages
  const s = await source(x); for (let i = 0; i < 3; i++) await collect(x, s, [AD('Northwind Synthetic', `ht${n}-${i}`)]);
  return libOutcome(L.advertiserHistory(interleaved(await reader(x), async p => { if (p === 1) { await control(x.si_rights_admin, s, 'SUSPEND'); await lift(x.si_rights_admin, s); } }),
    s, 'Northwind Synthetic', { pageSize: 1 })); }
async function lscnHistoryResult(L, x) {                                     // a new collection between history pages
  const s = await source(x); for (let i = 0; i < 2; i++) await collect(x, s, [AD('Northwind Synthetic', `hr${n}-${i}`)]);
  return libOutcome(L.advertiserHistory(interleaved(await reader(x), async p => { if (p === 1) await collect(x, s, [AD('Northwind Synthetic', 'late')]); }),
    s, 'Northwind Synthetic', { pageSize: 1 })); }
async function lscnInclusive(L, x) {                                         // the same name in two sources across a page boundary
  const a = await source(x), b = await source(x);
  await collect(x, a, [AD('Shared Synthetic', 'a')]); await collect(x, b, [AD('Shared Synthetic', 'b')]);
  const alice = await reader(x), q = { sources: [a, b], query: 'shared', limit: 1 };
  const out = []; let cursor = null;
  for (let i = 0; i < 4; i++) { const p = await L.searchAdvertisers(alice, { ...q, cursor }); out.push(...p.hits.map(h => h.sourceId === a ? 'A' : 'B')); if (!p.nextCursor) break; cursor = p.nextCursor; }
  return `value:${out.join('')}`; }
async function lscnSearchToken(L, x) {                                       // suspend + lift between search pages
  const s = await source(x); await collect(x, s, [AD('Alpha Synthetic', 'a'), AD('Bravo Synthetic', 'b')]);
  const alice = await reader(x), q = { sources: [s], query: 'synthetic', limit: 1 };
  const p1 = await L.searchAdvertisers(alice, q);
  await control(x.si_rights_admin, s, 'SUSPEND'); await lift(x.si_rights_admin, s);
  return libOutcome(L.searchAdvertisers(alice, { ...q, cursor: p1.nextCursor })); }
const LIB_MUTANTS = [
  { name: 'history token comparison between pages omitted', scenario: lscnHistoryToken, baseline: 'INTEL:AVAILABILITY_CHANGED', mutant: 'ok:3',
    edits: [["            if (d.state_token !== first.state_token)\n                throw new IntelligenceFailed('AVAILABILITY_CHANGED', { sourceId });\n", '']] },
  { name: 'history result-change checks omitted', scenario: lscnHistoryResult, baseline: 'INTEL:RESULT_CHANGED', mutant: 'ok:3',
    edits: [["            if (JSON.stringify(d.summary) !== JSON.stringify(first.summary) || d.normalized_name !== first.normalized_name) {\n                throw new IntelligenceFailed('RESULT_CHANGED', { sourceId });\n            }\n", ''],
            ["    if (Number(s.observations) !== observations.length)\n        throw new IntelligenceFailed('RESULT_CHANGED', { sourceId });\n", '']] },
  { name: 'search page position not inclusive for later sources', scenario: lscnInclusive, baseline: 'value:AB', mutant: 'value:A',
    edits: [['afterInclusive = cur ? cpCompare(sourceId, cur.a[1]) > 0 : false;', 'afterInclusive = false;']] },
  { name: 'search cursor state-token check omitted', scenario: lscnSearchToken, baseline: 'INTEL:AVAILABILITY_CHANGED', mutant: 'ok:1',
    edits: [["        if (cur && cur.t[sourceId] !== page.stateToken)\n            throw new IntelligenceFailed('AVAILABILITY_CHANGED', { sourceId });\n", '']] }
];
for (const m of LIB_MUTANTS) {
  test(`SRV-M lib (${m.name}): the baseline gives exactly the correct outcome, the mutant exactly the defect`, async t => {
    const base = await m.scenario(INTEL, await fresh(t, 'm4slb'));
    const L = await mutatedLibrary(t, m.edits);
    const killed = await m.scenario(L, await fresh(t, 'm4slm'));
    console.log(`# SRV-M lib ${m.name}: baseline ${base}, mutant ${killed}`);
    assert.equal(base, m.baseline, `${m.name}: baseline outcome`);
    assert.equal(killed, m.mutant, `${m.name}: mutant outcome (killed for the intended reason)`);
  });
}

// B-002 M4-P1: synthetic advertiser intelligence (history, search, freshness) over the verified read boundary.
// Real disposable PostgreSQL 16, synthetic sources only. Every value comes from si_read_evidence pages, the
// content-free si_read_source_status (migration 0011) or si_read_source_availability (migration 0012, M4-P1.1 D1);
// no test reads evidence tables as a reader. M4-P1.1: INT-20..INT-22 (explicit availability) and exact-outcome
// mutant baselines (D3).
//
// Fixtures a product path cannot perform (labelled where used): the test superuser sets runs' finished_at to
// absolute, millisecond-precision historical times under session_replication_role = replica ("time shift": the
// only way to build multi-day history in a test), plants an INVALID verdict, disturbs a receipt identity, or ages
// a retention deadline; mutated copies of the status function (database) or of the library (temporary copy).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
const MIG11 = readFileSync(new URL('../../db/migrations/0011_reader_status.up.sql', import.meta.url), 'utf8');
const MIG12 = readFileSync(new URL('../../db/migrations/0012_reader_availability.up.sql', import.meta.url), 'utf8');
const ROLES = ['admin', 'si_rights_admin', 'si_collector', 'si_retention', 'si_monitor'];
let n = 0;

test.before(async () => {
  const a = await connect();
  try { for (const p of ['si_reader_alice', 'si_reader_bob']) await provisionReaderPrincipal(a, p, cfg.rolePassword); } finally { await a.end(); }
});
async function fresh(t, prefix = 'm4int') {
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
  const src = `m4-${++n}`;
  await createSources(x.admin, [src], networks);
  await recordRights(x.si_rights_admin, src, {});
  if (grant) await grantReader(x.si_rights_admin, 'si_reader_alice', src, 'm4 synthetic intelligence');
  return src;
}
async function collect(x, src, rows, { verify = true } = {}) {
  const networks = rows.length ? [...new Set(rows.map(r => r.network))].sort() : ['META'];      // an EMPTY scoped run still names its scope
  const fx = fixtureSha256(rows), sha = requestSha256({ adapterId: src, evidenceKind: 'SYNTHETIC', networks, fixtureSha256: fx });
  const run = (await x.si_collector.query('SELECT * FROM si.si_begin_run_scoped($1,$2,$3,$4,$5::text[],$6)', [src, `m4k${++n}`, sha, 'SYNTHETIC', networks, fx])).rows[0];
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
/** Fixture (time shift): set a finished run's started/finished time to an absolute, millisecond-precision instant. */
const at = (x, runId, iso) => replica(x, `UPDATE si.collection_runs SET started_at = $2::timestamptz - interval '1 second', finished_at = $2::timestamptz WHERE run_id = $1`, [runId, iso]);
const DAY = 86400000;
const day = k => new Date(Date.UTC(2026, 9, 1) + k * DAY);                    // 2026-10-01 + k days, midnight UTC
const period = (a, b) => ({ from: day(a), to: day(b) });
const reader = x => x.connect('si_reader_alice');
const NOT_AUTH = e => e instanceof ReadFailed && e.code === 'NOT_AUTHORIZED';
/** Exactly SOURCE_UNAVAILABLE for this source with exactly these reasons (never a generic refusal). */
const UNAVAILABLE = (src, reasons) => e => e instanceof INTEL.IntelligenceFailed && e.code === 'SOURCE_UNAVAILABLE' && e.sourceId === src &&
  JSON.stringify(e.reasons) === JSON.stringify(reasons);
const CHANGED = src => e => e instanceof INTEL.IntelligenceFailed && e.code === 'AVAILABILITY_CHANGED' && e.sourceId === src;
/**
 * The exact outcome of a library call, as one string (works for mutated library copies too, by class name):
 *   ok:<n>  |  INTEL:<code>[:<reason,...>]  |  READ:<code>  |  OTHER:<message>
 */
async function libOutcome(promise, count = v => v?.observations?.length ?? v?.hits?.length ?? v?.records?.length ?? 0) {
  try { return `ok:${count(await promise)}`; } catch (e) {
    if (e?.name === 'IntelligenceFailed') return `INTEL:${e.code}${e.reasons?.length ? `:${e.reasons.join(',')}` : ''}`;
    if (e?.name === 'ReadFailed') return `READ:${e.code}`;
    return `OTHER:${e?.message}`;
  }
}
/** The exact outcome of a raw SQL call (settled): ok:<rows> | SI_<CODE> | SQLSTATE:<code>. */
const sqlOutcome = r => (r.status === 'ok' ? `ok:${r.value.rows.length}` : (String(r.message).match(/^SI_[A-Z_]+/)?.[0] ?? `SQLSTATE:${r.code}`));
/** A client that runs `after(n)` right after every evidence page of n rows: a deterministic interleaving point. */
function interleaved(client, after) {
  return { query: async (...args) => {
    const r = await client.query(...args);
    if (typeof args[0] === 'string' && args[0].includes('si.si_read_evidence(')) await after(r.rows.length);
    return r;
  } };
}
const retire = (x, src, sqlTime) => x.si_rights_admin.query(`UPDATE si.sources SET retired_at = ${sqlTime} WHERE source_id = $1`, [src]);

// ------------------------------------------------------------------------------------------------
test('INT-1/INT-18: authorized advertiser history with provenance; first/last observed; distinct ads; runs; end of activity UNKNOWN', async t => {
  const x = await fresh(t);
  const src = await source(x);
  const r1 = await collect(x, src, [AD('Northwind Synthetic', 'nw1'), AD('Northwind Synthetic', 'nw2', { network: 'TIKTOK' }), AD('Contoso Synthetic', 'co1')]);
  const r2 = await collect(x, src, [AD('NORTHWIND Synthetic', 'nw1'), AD('Contoso Synthetic', 'co2')]);
  await at(x, r1, day(2).toISOString()); await at(x, r2, new Date(day(5).getTime() + 3600000).toISOString());
  const h = await INTEL.advertiserHistory(await reader(x), src, 'northwind SYNTHETIC');
  assert.equal(h.advertiser.normalizedName, 'northwind synthetic');
  assert.deepEqual(h.advertiser.names, ['NORTHWIND Synthetic', 'Northwind Synthetic'], 'exact source spellings are kept');
  assert.deepEqual([h.observations.length, h.distinctAds, h.runsWithEvidence], [3, 2, 2]);
  assert.deepEqual([h.firstObservedAt, h.lastObservedAt], [day(2).toISOString(), new Date(day(5).getTime() + 3600000).toISOString()]);
  assert.deepEqual(h.networks, ['META', 'TIKTOK']);
  assert.equal(h.endOfActivity, 'UNKNOWN');
  assert.ok(h.notes.some(s => /does not show that an advertisement stopped/.test(s)));
  // Provenance: every observation names its source, run and ordinal, verified commit time and content hash, as stored.
  const truth = (await x.admin.query(`SELECT o.run_id, o.ordinal, o.content_sha256, o.native_ad_id, r.finished_at FROM si.observations o
                                      JOIN si.collection_runs r USING (run_id) WHERE r.source_id = $1 AND o.advertiser_name ILIKE 'northwind%' ORDER BY r.finished_at, o.run_id, o.ordinal`, [src])).rows;
  assert.deepEqual(h.observations.map(o => [o.sourceId, o.runId, o.ordinal, o.contentSha256, o.nativeAdId, o.collectedAt, o.verification]),
                   truth.map(r => [src, r.run_id, r.ordinal, r.content_sha256, r.native_ad_id, r.finished_at.toISOString(), 'VALID']));
});

test('INT-2/INT-4: unauthorized source and revoked grant are refused by the database (history, search, status)', async t => {
  const x = await fresh(t);
  const src = await source(x, { grant: false });
  await collect(x, src, [AD('Northwind Synthetic', 'u1')]);
  const alice = await reader(x);
  await assert.rejects(INTEL.advertiserHistory(alice, src, 'northwind'), NOT_AUTH);
  await assert.rejects(INTEL.searchAdvertisers(alice, { sources: [src], query: 'north' }), NOT_AUTH);
  await assert.rejects(INTEL.freshness(alice, src, period(0, 30)), NOT_AUTH);
  await grantReader(x.si_rights_admin, 'si_reader_alice', src, 'granted');
  assert.equal((await INTEL.advertiserHistory(alice, src, 'northwind synthetic')).observations.length, 1);
  await revokeReader(x.si_rights_admin, 'si_reader_alice', src, 'revoked');
  await assert.rejects(INTEL.advertiserHistory(alice, src, 'northwind synthetic'), NOT_AUTH);
  await assert.rejects(INTEL.freshness(alice, src, period(0, 30)), NOT_AUTH);
  for (const role of ['si_collector', 'si_monitor', 'si_retention', 'si_rights_admin']) {
    await rejects(assert, x[role].query(`SELECT * FROM si.si_read_source_status($1, gen_random_uuid(), now(), now() + interval '1 day')`, [src]), { code: '42501' });
  }
});

test('INT-3: cross-source isolation — explicit sources only, each authorized separately, never merged', async t => {
  const x = await fresh(t);
  const a = await source(x), b = await source(x), c = await source(x, { grant: false });
  await collect(x, a, [AD('Shared Synthetic', 'a1')]); await collect(x, b, [AD('Shared Synthetic', 'b1'), AD('Shared Synthetic', 'b2')]);
  await collect(x, c, [AD('Shared Synthetic', 'c1')]);
  const alice = await reader(x);
  const onlyA = await INTEL.searchAdvertisers(alice, { sources: [a], query: 'shared' });
  assert.deepEqual(onlyA.hits.map(h => [h.sourceId, h.observations]), [[a, 1]]);
  const both = await INTEL.searchAdvertisers(alice, { sources: [b, a], query: 'shared' });
  assert.deepEqual(both.hits.map(h => [h.sourceId, h.observations, h.distinctAds]), [[a, 1, 1], [b, 2, 2]], 'one hit per source, not one merged identity');
  await assert.rejects(INTEL.searchAdvertisers(alice, { sources: [a, c], query: 'shared' }), NOT_AUTH, 'one unauthorized source fails the whole request (no partial result)');
});

test('INT-5/INT-6: suspension and termination block reads immediately: history, search and status fail typed, never empty', async t => {
  const x = await fresh(t);
  const s = await source(x), term = await source(x);
  await collect(x, s, [AD('Northwind Synthetic', 's1')]); await collect(x, term, [AD('Northwind Synthetic', 't1')]);
  const alice = await reader(x);
  assert.equal((await INTEL.advertiserHistory(alice, s, 'northwind synthetic')).observations.length, 1);
  await control(x.si_rights_admin, s, 'SUSPEND');
  await control(x.si_rights_admin, term, 'TERMINATE_RETENTION');
  for (const [src, why] of [[s, ['SUSPENDED']], [term, ['TERMINATED']]]) {
    await assert.rejects(INTEL.advertiserHistory(alice, src, 'northwind synthetic'), UNAVAILABLE(src, why), `${src}: history is not an empty result`);
    await assert.rejects(INTEL.searchAdvertisers(alice, { sources: [src], query: 'north' }), UNAVAILABLE(src, why), `${src}: search is not an empty result`);
    await assert.rejects(INTEL.freshness(alice, src, period(-400, -40)), UNAVAILABLE(src, why));
  }
  await lift(x.si_rights_admin, s);
  const h = await INTEL.advertiserHistory(alice, s, 'northwind synthetic');
  assert.deepEqual([h.observations.length, h.availability.state], [1, 'AVAILABLE'], 'LIFT restores');
});

test('INT-7/INT-8/INT-9: retention expiry, INVALID and UNVERIFIABLE receipts are excluded and counted', async t => {
  const x = await fresh(t);
  const src = await source(x);
  const ok = await collect(x, src, [AD('Northwind Synthetic', 'ok')]);
  const expired = await collect(x, src, [AD('Northwind Synthetic', 'ex')]);
  const unver = await collect(x, src, [AD('Northwind Synthetic', 'un')], { verify: false });
  const inval = await collect(x, src, [AD('Northwind Synthetic', 'in')], { verify: false });
  await replica(x, 'UPDATE si.publication_receipts SET receipt_at = receipt_at WHERE run_id = $1', [unver]);       // fixture: identity disturbed
  await x.si_monitor.query('SELECT * FROM si.si_verify_receipts(1)');      // verifies the oldest pending run only (unver)
  await replica(x, `INSERT INTO si.receipt_verifications (run_id, source_id, rights_version_id, verdict, reason, commit_xid, commit_ts, window_start, window_end, verified_at, verified_by)
    SELECT r.run_id, r.source_id, r.rights_version_id, 'INVALID', 'COMMITTED_AFTER_WINDOW', 3, r.finished_at, r.finished_at - interval '1 hour', r.finished_at, clock_timestamp(), 'fixture'
      FROM si.collection_runs r WHERE r.run_id = $1`, [inval]);                                                    // fixture: INVALID verdict
  await replica(x, `UPDATE si.collection_runs SET retain_until = clock_timestamp() - interval '1 minute' WHERE run_id = $1`, [expired]);
  const pending = await collect(x, src, [AD('Northwind Synthetic', 'pe')], { verify: false });
  for (const [r, k] of [[ok, 1], [expired, 2], [unver, 3], [inval, 4], [pending, 5]]) await at(x, r, day(k).toISOString());
  const alice = await reader(x);
  const h = await INTEL.advertiserHistory(alice, src, 'Northwind Synthetic');
  assert.deepEqual(h.observations.map(o => o.nativeAdId), ['ok'], 'only VALID, retained, authorized evidence is visible');
  const s = await INTEL.sourceStatus(alice, src, period(0, 10));
  assert.deepEqual([s.runsWithEvidence, s.runsVerifiedValid, s.runsVerifiedInvalid, s.runsVerifiedUnverifiable, s.runsVerificationPending, s.runsReadable],
                   [5, 2, 1, 1, 1, 1], 'ok and expired are VALID; only ok is readable');
  assert.equal(s.latestVerifiedEvidenceAt, day(1).toISOString(), 'latest VERIFIED readable evidence, not the latest collection');
  assert.equal(s.latestSuccessfulCollectionAt, day(5).toISOString());
  const f = INTEL.freshnessFromStatus(s);
  assert.deepEqual(f.verificationCompleteness, { state: 'KNOWN', value: { valid: 2, invalid: 1, unverifiable: 1, pending: 1, runsWithEvidence: 5, ratio: 0.4 } });
});

test('INT-10/INT-15: empty history and UNKNOWN states', async t => {
  const x = await fresh(t);
  const none = await source(x), emptyRuns = await source(x);
  await collect(x, emptyRuns, []);                                           // a successful collection with no ads (EMPTY)
  const alice = await reader(x);
  const h = await INTEL.advertiserHistory(alice, none, 'Nobody Synthetic');
  assert.deepEqual([h.observations.length, h.firstObservedAt, h.lastObservedAt, h.distinctAds, h.runsWithEvidence, h.endOfActivity], [0, null, null, 0, 0, 'UNKNOWN']);
  const p = { from: new Date(Date.now() - 2 * DAY), to: new Date(Date.now() + DAY) };
  const f0 = await INTEL.freshness(alice, none, p);
  assert.deepEqual([f0.collectionFreshness, f0.evidenceFreshness, f0.verificationCompleteness, f0.collectionReliability],
    [{ state: 'UNKNOWN', reason: 'NO_SUCCESSFUL_COLLECTION' }, { state: 'UNKNOWN', reason: 'NO_VERIFIED_READABLE_EVIDENCE' },
     { state: 'UNKNOWN', reason: 'NO_RUNS_WITH_EVIDENCE_IN_PERIOD' }, { state: 'UNKNOWN', reason: 'NO_COLLECTION_ATTEMPTS_IN_PERIOD' }]);
  assert.equal(f0.collectionCoverage.state, 'KNOWN', 'zero collection days is a measurement, not unknown');
  assert.equal(f0.collectionCoverage.value.daysWithCollection, 0);
  const f1 = await INTEL.freshness(alice, emptyRuns, p);
  assert.equal(f1.collectionFreshness.state, 'KNOWN', 'an EMPTY run is a successful collection');
  assert.deepEqual(f1.evidenceFreshness, { state: 'UNKNOWN', reason: 'NO_VERIFIED_READABLE_EVIDENCE' }, 'collection freshness is not evidence freshness');
});

test('INT-11: duplicates — identical copies in a batch are counted once; the same ad in two runs is one distinct ad, two observations', async t => {
  const x = await fresh(t);
  const src = await source(x);
  const r1 = await collect(x, src, [AD('Northwind Synthetic', 'd1'), AD('Northwind Synthetic', 'd1')]);
  const run = (await x.admin.query('SELECT received_count, published_count, duplicate_count FROM si.collection_runs WHERE run_id = $1', [r1])).rows[0];
  assert.deepEqual(run, { received_count: 2, published_count: 1, duplicate_count: 1 });
  await collect(x, src, [AD('Northwind Synthetic', 'd1')]);
  const h = await INTEL.advertiserHistory(await reader(x), src, 'Northwind Synthetic');
  assert.deepEqual([h.observations.length, h.distinctAds, h.runsWithEvidence], [2, 1, 2]);
});

test('INT-12: stable, deterministic pagination; cursors are bound to the query and are never capabilities', async t => {
  const x = await fresh(t);
  const src = await source(x);
  await collect(x, src, ['Echo', 'alpha', 'Delta', 'bravo', 'Charlie'].map((nm, i) => AD(`${nm} Synthetic`, `p${i}`)));
  const alice = await reader(x);
  const q = { sources: [src], query: 'synthetic', limit: 2 };
  const pages = []; let cursor = null;
  for (;;) { const p = await INTEL.searchAdvertisers(alice, { ...q, cursor }); pages.push(...p.hits.map(h => h.normalizedName)); if (!p.nextCursor) break; cursor = p.nextCursor; }
  const all = (await INTEL.searchAdvertisers(alice, { ...q, limit: 50 })).hits.map(h => h.normalizedName);
  assert.deepEqual(pages, ['alpha synthetic', 'bravo synthetic', 'charlie synthetic', 'delta synthetic', 'echo synthetic']);
  assert.deepEqual(pages, all, 'pages concatenate to the full ordered result');
  const first = await INTEL.searchAdvertisers(alice, q);
  const again = await INTEL.searchAdvertisers(alice, q);
  assert.deepEqual([first.hits, first.nextCursor], [again.hits, again.nextCursor], 'repeatable (availability times differ by design)');
  await assert.rejects(INTEL.searchAdvertisers(alice, { ...q, query: 'alpha', cursor: first.nextCursor }), e => e.code === 'BAD_CURSOR', 'bound to the query');
  await assert.rejects(INTEL.searchAdvertisers(alice, { ...q, cursor: 'garbage' }), e => e.code === 'BAD_CURSOR');
  await revokeReader(x.si_rights_admin, 'si_reader_alice', src, 'revoked');
  await assert.rejects(INTEL.searchAdvertisers(alice, { ...q, cursor: first.nextCursor }), NOT_AUTH, 'a cursor is not a capability');
  // The evidence scan itself is independent of the page size.
  await grantReader(x.si_rights_admin, 'si_reader_alice', src, 'again');
  const s1 = await INTEL.scanEvidence(alice, src, { pageSize: 1 }), s100 = await INTEL.scanEvidence(alice, src, { pageSize: 100 });
  assert.deepEqual(s1.records.map(r => `${r.runId}/${r.ordinal}`), s100.records.map(r => `${r.runId}/${r.ordinal}`));
  assert.equal(s1.pages, 6);
});

test('INT-13/INT-14: date boundaries [from, to) and freshness calculations', async t => {
  const x = await fresh(t);
  const src = await source(x);
  const atFrom = await collect(x, src, [AD('Northwind Synthetic', 'b-from')]);
  const inside = await collect(x, src, [AD('Northwind Synthetic', 'b-in')]);
  const atTo = await collect(x, src, [AD('Northwind Synthetic', 'b-to')]);
  const before = await collect(x, src, [AD('Northwind Synthetic', 'b-before')]);
  const failed = (await x.si_collector.query('SELECT * FROM si.si_begin_run_scoped($1,$2,$3,$4,$5::text[],$6)',
    [src, `m4f${++n}`, requestSha256({ adapterId: src, evidenceKind: 'SYNTHETIC', networks: ['META'], fixtureSha256: fixtureSha256([AD('X', 'f')]) }), 'SYNTHETIC', ['META'], fixtureSha256([AD('X', 'f')])])).rows[0];
  await x.si_collector.query(`SELECT * FROM si.si_fail_run($1::uuid, $2::uuid, 'SOURCE_ERROR')`, [failed.run_id, failed.lease_token]);
  await at(x, before, new Date(day(10).getTime() - 1).toISOString());       // 1 ms before from
  await at(x, atFrom, day(10).toISOString());                               // exactly from: included
  await at(x, inside, new Date(day(12).getTime() + 5 * 3600000).toISOString());
  await at(x, atTo, day(14).toISOString());                                 // exactly to: excluded
  const p = period(10, 14);
  const alice = await reader(x);
  const h = await INTEL.advertiserHistory(alice, src, 'Northwind Synthetic', { period: p });
  assert.deepEqual(h.observations.map(o => o.nativeAdId), ['b-from', 'b-in']);
  const s = await INTEL.sourceStatus(alice, src, p);
  assert.deepEqual([s.daysInPeriod, s.daysWithCollection, s.daysWithVerifiedEvidence, s.runsCompleted, s.runsWithEvidence],
                   [4, 2, 2, 2, 2], 'days 10..13; collections on day 10 and 12');
  const f = INTEL.freshnessFromStatus(s);
  assert.deepEqual(f.collectionCoverage.value, { daysWithCollection: 2, daysInPeriod: 4, ratio: 0.5 });
  assert.equal(f.collectionFreshness.value.latestSuccessfulCollectionAt, day(14).toISOString(), 'latest collection overall (not limited to the period)');
  assert.equal(f.collectionFreshness.value.ageSeconds, Math.floor((Date.parse(s.asOf) - day(14).getTime()) / 1000), 'age measured against the database clock');
  assert.equal(f.evidenceFreshness.value.latestVerifiedObservationAt, day(14).toISOString());
  const p2 = { from: new Date(Date.now() - DAY), to: new Date(Date.now() + DAY) };
  const s2 = await INTEL.sourceStatus(alice, src, p2);
  assert.equal(s2.runsFailed, 1, 'the failed attempt is counted for reliability');
  assert.deepEqual(INTEL.freshnessFromStatus(s2).collectionReliability, { state: 'KNOWN', value: { completed: 0, failed: 1, successRatio: 0 } });
  await assert.rejects(INTEL.sourceStatus(alice, src, { from: day(1), to: day(1) }), e => e.code === 'BAD_ARGUMENT');
  await assert.rejects(INTEL.sourceStatus(alice, src, { from: day(0), to: day(400) }), e => e.code === 'BAD_ARGUMENT');
});

test('INT-16: concurrent collection during a scan — no duplicate or missing record; the next scan includes the new run', async t => {
  const x = await fresh(t);
  const src = await source(x);
  for (let i = 0; i < 3; i++) await collect(x, src, [AD('Northwind Synthetic', `c${i}a`), AD('Northwind Synthetic', `c${i}b`)]);
  const alice = await reader(x);
  let injected = false;
  const scan = await INTEL.scanEvidence(alice, src, { pageSize: 2, onPage: async () => {
    if (!injected) { injected = true; await collect(x, src, [AD('Northwind Synthetic', 'late')]); }
  } });
  const keys = scan.records.map(r => `${r.runId}/${r.ordinal}`);
  assert.equal(new Set(keys).size, keys.length, 'no duplicates');
  const ids = scan.records.map(r => r.nativeAdId);
  for (const id of ['c0a', 'c0b', 'c1a', 'c1b', 'c2a', 'c2b']) assert.ok(ids.includes(id), `${id} present`);
  const again = await INTEL.scanEvidence(alice, src);
  assert.ok(again.records.some(r => r.nativeAdId === 'late'), 'the new run is visible to the next request');
});

// INT-19 (the status function's durability gate) uses the wal_writer_delay fixture and runs in the isolated
// durability step: tests/crash/m4-status-durability.test.mjs.

test('INT-17: request audit — one committed intent per page and per status; caller rollback; scopes cannot be swapped', async t => {
  const x = await fresh(t);
  const src = await source(x);
  await collect(x, src, [AD('Northwind Synthetic', 'q1'), AD('Northwind Synthetic', 'q2'), AD('Northwind Synthetic', 'q3')]);
  const alice = await reader(x);
  const count = async () => (await x.admin.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE state = 'CONSUMED')::int AS c,
                                                         count(*) FILTER (WHERE pg_xact_status(created_xid) = 'committed')::int AS k FROM si.read_intents`)).rows[0];
  const h = await INTEL.advertiserHistory(alice, src, 'Northwind Synthetic', { pageSize: 2, period: period(-300, 60), withStatus: true });
  assert.equal(h.observations.length, 3);
  const audit = await count();
  assert.equal(audit.c, 6, '2 availability checks (before and after) + 3 evidence pages (2 + 1 + empty) + 1 status: each its own consumed request');
  assert.equal(audit.k, audit.n, 'every request record is committed');
  // An unconsumed extra intent can only come from the bounded fresh-intent retry on INTENT_NOT_DURABLE (unrelated
  // unflushed WAL, e.g. catalog pruning in a freshly cloned database): at most two retries per request.
  assert.ok(audit.n >= 6 && audit.n <= 18, `intents: ${audit.n}`);
  const digest = c => createHash('sha256').update(c, 'utf8').digest('hex');
  const scoped = async c => (await x.admin.query(`SELECT count(*)::int AS n FROM si.read_intents WHERE cursor_sha256 = $1 AND read_limit = 1
                                                    AND state = 'CONSUMED' AND rows_returned = 1 AND bytes_returned > 0`, [digest(c)])).rows[0].n;
  assert.equal(await scoped(INTEL.statusCursor(src, period(-300, 60))), 1, 'one status request, its period in the audited scope');
  assert.equal(await scoped(INTEL.availabilityCursor(src)), 2, 'two availability requests');
  // Inside a caller transaction nothing is released at all.
  await alice.query('BEGIN');
  const err = await INTEL.advertiserHistory(alice, src, 'Northwind Synthetic').catch(e => e);
  await alice.query('ROLLBACK');
  assert.ok(err instanceof ReadFailed && err.code === 'INTENT_UNCOMMITTED');
  // A status intent cannot release evidence, an evidence intent cannot release status, and the period is bound.
  const p = period(0, 10);
  const statusIntent = await beginRead(alice, src, { cursor: INTEL.statusCursor(src, p), limit: 1 });
  await rejects(assert, alice.query('SELECT * FROM si.si_read_evidence($1, $2, $3, 1)', [src, statusIntent, INTEL.statusCursor(src, p)]), { code: '22023', message: /^SI_READ_BAD_CURSOR/ });
  const pageIntent = await beginRead(alice, src, { limit: 1 });
  await rejects(assert, alice.query('SELECT * FROM si.si_read_source_status($1, $2, $3, $4)', [src, pageIntent, p.from, p.to]), { code: '42501', message: /^SI_READ_INTENT_INVALID/ });
  await rejects(assert, alice.query('SELECT * FROM si.si_read_source_status($1, $2, $3, $4)', [src, statusIntent, p.from, day(11)]), { code: '42501', message: /^SI_READ_INTENT_INVALID/ }, 'another period');
  const availIntent = await beginRead(alice, src, { cursor: INTEL.availabilityCursor(src), limit: 1 });
  await rejects(assert, alice.query('SELECT * FROM si.si_read_evidence($1, $2, $3, 1)', [src, availIntent, INTEL.availabilityCursor(src)]), { code: '22023', message: /^SI_READ_BAD_CURSOR/ });
  await rejects(assert, alice.query('SELECT * FROM si.si_read_source_status($1, $2, $3, $4)', [src, availIntent, p.from, p.to]), { code: '42501', message: /^SI_READ_INTENT_INVALID/ });
  await rejects(assert, alice.query('SELECT * FROM si.si_read_source_availability($1, $2)', [src, pageIntent]), { code: '42501', message: /^SI_READ_INTENT_INVALID/ });
  await rejects(assert, alice.query('SELECT * FROM si.si_read_source_availability($1, $2)', [src, statusIntent]), { code: '42501', message: /^SI_READ_INTENT_INVALID/ });
  // A successful raw call, with the same bounded fresh-intent retry the library uses on INTENT_NOT_DURABLE
  // (unrelated unflushed WAL, e.g. catalog pruning, can make a first call fail closed).
  let used = statusIntent, ok = null;
  for (let i = 0; i < 3 && !ok; i++) {
    const r = await settle(alice.query('SELECT * FROM si.si_read_source_status($1, $2, $3, $4)', [src, used, p.from, p.to]));
    if (r.status === 'ok') ok = r.value; else { assert.match(r.message, /^SI_READ_INTENT_NOT_DURABLE/); used = await beginRead(alice, src, { cursor: INTEL.statusCursor(src, p), limit: 1 }); }
  }
  assert.equal(ok?.rows.length, 1);
  await rejects(assert, alice.query('SELECT * FROM si.si_read_source_status($1, $2, $3, $4)', [src, used, p.from, p.to]), { code: '55000', message: /^SI_READ_INTENT_USED/ });
});

// ------------------------------------------------------------------------------------------------
// M4-P1.1 D1: explicit source availability (migration 0012). An unavailable source is a typed failure with fixed
// reasons; an available source with no matching evidence is an explicit AVAILABLE empty result; authorization
// failures stay NOT_AUTHORIZED and reveal nothing about availability.
test('INT-20: every unavailability reason is explicit and distinct from an available source with no matching evidence', async t => {
  const x = await fresh(t);
  const alice = await reader(x);
  const empty = await source(x);                                             // available, no evidence at all
  await collect(x, empty, [AD('Contoso Synthetic', 'e1')]);                  // available, evidence of another advertiser
  const h = await INTEL.advertiserHistory(alice, empty, 'Northwind Synthetic');
  assert.deepEqual([h.observations.length, h.availability.state, h.availability.sourceId], [0, 'AVAILABLE', empty], 'explicit: available, nothing matches');
  assert.ok(Date.parse(h.availability.checkedFrom) <= Date.parse(h.availability.asOf));
  const sr = await INTEL.searchAdvertisers(alice, { sources: [empty], query: 'northwind' });
  assert.deepEqual([sr.hits.length, sr.sources.map(a => [a.sourceId, a.state])], [0, [[empty, 'AVAILABLE']]]);
  assert.deepEqual(await INTEL.sourceAvailability(alice, empty).then(a => [a.available, a.reasons]), [true, []]);

  const cases = [];
  const mk = async (label, reasons, make) => { const src = await source(x); await collect(x, src, [AD('Northwind Synthetic', `${label}1`)]); await make(src); cases.push([label, src, reasons]); };
  await mk('suspended', ['SUSPENDED'], src => control(x.si_rights_admin, src, 'SUSPEND'));
  await mk('terminated', ['TERMINATED'], src => control(x.si_rights_admin, src, 'TERMINATE_RETENTION'));
  await mk('retired', ['RETIRED'], src => retire(x, src, "clock_timestamp() + interval '30 seconds'"));       // retiring within the margin
  await mk('rightsdenied', ['RIGHTS_RESTRICTED'], src => recordRights(x.si_rights_admin, src, { evaluation: 'DENIED', change_reason: 'evaluation withdrawn' }));
  await mk('rightsexpiring', ['RIGHTS_RESTRICTED'], src => recordRights(x.si_rights_admin, src, { expires_at_sql: "clock_timestamp() + interval '30 seconds'", change_reason: 'expiring' }));
  await mk('retentiondenied', ['RETENTION_RESTRICTED'], src => recordRights(x.si_rights_admin, src, { retain: 'DENIED', retention_days: null, change_reason: 'retention withdrawn' }));
  await mk('suspretired', ['RETIRED', 'SUSPENDED'], async src => { await control(x.si_rights_admin, src, 'SUSPEND'); await retire(x, src, "clock_timestamp() + interval '30 seconds'"); });
  for (const [label, src, reasons] of cases) {
    const a = await INTEL.sourceAvailability(alice, src);
    assert.deepEqual([a.available, a.reasons], [false, reasons], `${label}: availability`);
    await assert.rejects(INTEL.advertiserHistory(alice, src, 'Northwind Synthetic'), UNAVAILABLE(src, reasons), `${label}: history`);
    await assert.rejects(INTEL.searchAdvertisers(alice, { sources: [empty, src], query: 'north' }), UNAVAILABLE(src, reasons), `${label}: search (no partial result)`);
    await assert.rejects(INTEL.scanEvidence(alice, src), UNAVAILABLE(src, reasons), `${label}: scan`);
    await assert.rejects(INTEL.freshness(alice, src, period(0, 30)), UNAVAILABLE(src, reasons), `${label}: freshness`);
  }
  // Not authorized is never "unavailable" and never empty, and reveals nothing: an unknown source, an ungranted
  // available source, an ungranted suspended source and a revoked one all fail identically.
  const ungranted = await source(x, { grant: false }), ungrantedSuspended = await source(x, { grant: false });
  await control(x.si_rights_admin, ungrantedSuspended, 'SUSPEND');
  const revoked = cases[0][1];
  await revokeReader(x.si_rights_admin, 'si_reader_alice', revoked, 'revoked while suspended');
  for (const src of ['m4-no-such-source', ungranted, ungrantedSuspended, revoked]) {
    const outcomes = [await libOutcome(INTEL.advertiserHistory(alice, src, 'Northwind Synthetic')),
                      await libOutcome(INTEL.searchAdvertisers(alice, { sources: [src], query: 'north' })),
                      await libOutcome(INTEL.sourceAvailability(alice, src)),
                      await libOutcome(INTEL.freshness(alice, src, period(0, 30)))];
    assert.deepEqual(outcomes, Array(4).fill('READ:NOT_AUTHORIZED'), `${src}: identical refusal`);
    const raw = await settle(alice.query('SELECT * FROM si.si_read_source_availability($1, gen_random_uuid())', [src]));
    assert.deepEqual([raw.code, sqlOutcome(raw)], ['42501', 'SI_READ_INTENT_INVALID'], `${src}: no intent, no answer`);
  }
  // Only the dedicated reader may ask at all.
  for (const role of ['si_collector', 'si_monitor', 'si_retention', 'si_rights_admin']) {
    await rejects(assert, x[role].query('SELECT * FROM si.si_read_source_availability($1, gen_random_uuid())', [empty]), { code: '42501' });
  }
  // Recovery: LIFT restores availability.
  await grantReader(x.si_rights_admin, 'si_reader_alice', revoked, 'granted again');
  await lift(x.si_rights_admin, revoked);
  assert.equal((await INTEL.advertiserHistory(alice, revoked, 'Northwind Synthetic')).observations.length, 1);
});

test('INT-21: availability changes during a multi-page scan never produce a misleading successful result', async t => {
  const x = await fresh(t);
  const alice = await reader(x);
  const three = async () => { const src = await source(x); await collect(x, src, [1, 2, 3].map(i => AD('Northwind Synthetic', `m${n}-${i}`))); return src; };
  const scan = (src, after) => INTEL.advertiserHistory(interleaved(alice, after), src, 'Northwind Synthetic', { pageSize: 1 });
  const once = fn => { let done = false; return async k => { if (!done && (await fn(k)) !== false) done = true; }; };
  // Suspended after the first page and still suspended: SOURCE_UNAVAILABLE (pages after it were empty).
  const a = await three();
  await assert.rejects(scan(a, once(k => k === 1 && control(x.si_rights_admin, a, 'SUSPEND'))), UNAVAILABLE(a, ['SUSPENDED']));
  // Suspended after the first page, lifted right after the (therefore empty) second page: the scan would otherwise
  // end early with 1 of 3 records and report success. It fails AVAILABILITY_CHANGED.
  const b = await three();
  let step = 0;
  await assert.rejects(scan(b, async k => {
    if (step === 0 && k === 1) { step = 1; await control(x.si_rights_admin, b, 'SUSPEND'); }
    else if (step === 1 && k === 0) { step = 2; await lift(x.si_rights_admin, b); }
  }), CHANGED(b));
  assert.equal(step, 2, 'the interleaving happened as described');
  // The same with a retirement moved into the margin and back (retired_at A -> B -> A: only the row version shows it).
  const c = await three();
  step = 0;
  await assert.rejects(scan(c, async k => {
    if (step === 0 && k === 1) { step = 1; await retire(x, c, "clock_timestamp() + interval '30 seconds'"); }
    else if (step === 1 && k === 0) { step = 2; await retire(x, c, 'NULL'); }
  }), CHANGED(c));
  assert.equal(step, 2);
  // Terminated mid-scan; rights withdrawn mid-scan; retention withdrawn mid-scan: typed, never truncated success.
  const d = await three(), e = await three(), f = await three();
  await assert.rejects(scan(d, once(k => k === 1 && control(x.si_rights_admin, d, 'TERMINATE_RETENTION'))), UNAVAILABLE(d, ['TERMINATED']));
  await assert.rejects(scan(e, once(k => k === 1 && recordRights(x.si_rights_admin, e, { evaluation: 'DENIED', change_reason: 'withdrawn' }))), UNAVAILABLE(e, ['RIGHTS_RESTRICTED']));
  await assert.rejects(scan(f, once(k => k === 1 && recordRights(x.si_rights_admin, f, { retain: 'DENIED', retention_days: null, change_reason: 'withdrawn' }))), UNAVAILABLE(f, ['RETENTION_RESTRICTED']));
  // Grant revoked mid-scan: NOT_AUTHORIZED (the next page is refused), never an empty or partial result.
  const g = await three();
  await assert.rejects(scan(g, once(k => k === 1 && revokeReader(x.si_rights_admin, 'si_reader_alice', g, 'revoked mid-scan'))), NOT_AUTH);
  // A source that stays available: concurrent collection does not change availability (INT-16 still holds).
  const ok = await three();
  const h = await scan(ok, once(async k => { if (k !== 1) return false; await collect(x, ok, [AD('Northwind Synthetic', 'late')]); }));
  assert.ok(h.observations.length >= 3 && h.availability.state === 'AVAILABLE');
  // Search over two sources, one suspended mid-way through its own scan: the whole search fails, typed.
  const s1 = await three(), s2 = await three();
  await assert.rejects(INTEL.searchAdvertisers(interleaved(alice, once(k => k === 1 && control(x.si_rights_admin, s2, 'SUSPEND'))),
    { sources: [s1, s2], query: 'north' }, { pageSize: 1 }), UNAVAILABLE(s2, ['SUSPENDED']));
});

test('INT-22: the availability answer is content-free, audited, and its token changes exactly with availability-relevant state', async t => {
  const x = await fresh(t);
  const alice = await reader(x);
  const src = await source(x);
  await collect(x, src, [AD('Northwind Synthetic', 'k1')]);
  const a1 = await INTEL.sourceAvailability(alice, src);
  assert.deepEqual(Object.keys(a1).sort(), ['asOf', 'available', 'reasons', 'sourceId', 'stateToken']);
  assert.match(a1.stateToken, /^[0-9a-f]{32}$/);
  await collect(x, src, [AD('Northwind Synthetic', 'k2')]);                  // evidence changes; availability does not
  await x.si_monitor.query('SELECT * FROM si.si_verify_receipts(10)');
  assert.equal((await INTEL.sourceAvailability(alice, src)).stateToken, a1.stateToken, 'collection and verification do not change the token');
  await control(x.si_rights_admin, src, 'SUSPEND'); await lift(x.si_rights_admin, src);
  const a2 = await INTEL.sourceAvailability(alice, src);
  assert.deepEqual([a2.available, a2.stateToken !== a1.stateToken], [true, true], 'a suspension and its lift change the token');
  await recordRights(x.si_rights_admin, src, { change_reason: 'renewed' });
  const a3 = await INTEL.sourceAvailability(alice, src);
  assert.deepEqual([a3.available, a3.stateToken !== a2.stateToken], [true, true], 'a new rights version changes the token');
  const raw = (await x.admin.query(`SELECT count(*)::int AS n FROM si.reader_access_log WHERE source_id = $1 AND rows_returned = 1`, [src])).rows[0].n;
  assert.equal(raw, 4, 'every answer (four) has a completion record');
});

// ------------------------------------------------------------------------------------------------
// Negative-control mutants. Database: copies of the 0011 status / 0012 availability functions; library: a mutated
// temporary copy. M4-P1.1 (D3): every scenario returns its EXACT outcome (libOutcome / sqlOutcome / a value), and
// both the baseline and the mutant must produce exactly the expected one. An unrelated refusal, an unexpected
// success, or a durability refusal that outlasts the bounded retry fails the test; nothing generic counts as clean.
function fnText(mig, start, end) { const s = mig.indexOf(start); return mig.slice(s, mig.indexOf(end, s) + end.length).replace(/^CREATE FUNCTION/, 'CREATE OR REPLACE FUNCTION'); }
function mutate(text, from, to) { assert.equal(text.split(from).length, 2, `exactly one anchor: ${from.slice(0, 60)}`); return text.replace(from, to); }
const STATUS_FN = fnText(MIG11, 'CREATE FUNCTION si.si_read_source_status', 'END $read_source_status$;');
const AVAIL_FN = fnText(MIG12, 'CREATE FUNCTION si.si_read_source_availability', 'END $read_source_availability$;');
/** A raw call made the way the library makes it: a fail-closed INTENT_NOT_DURABLE (unrelated unflushed WAL) is retried
 *  with a fresh intent, at most 3 attempts; `attempt` sets up and returns the settled result of one attempt. Nothing
 *  else is retried, and a third NOT_DURABLE is returned as the outcome (so it fails the exact assertion). */
async function withFreshIntentRetry(attempt) {
  let r;
  for (let i = 0; i < 3; i++) { r = await attempt(); if (!(r.status !== 'ok' && /^SI_READ_INTENT_NOT_DURABLE/.test(String(r.message)))) break; }
  return r;
}
/** Revoke between taking the intent and the call (si_begin_read also checks the grant). */
async function revokedBetween(x, src, cursor, call) {
  const alice = await reader(x);
  return sqlOutcome(await withFreshIntentRetry(async () => {
    const id = await beginRead(alice, src, { cursor, limit: 1 });
    await revokeReader(x.si_rights_admin, 'si_reader_alice', src, 'revoked between intent and call');
    const out = await settle(call(alice, id));
    await grantReader(x.si_rights_admin, 'si_reader_alice', src, 'granted again for the next attempt');
    return out;
  }));
}
async function scnStatusGrant(x) {                                           // mutant: a principal whose grant was revoked gets status
  const src = await source(x), p = period(0, 10);
  return revokedBetween(x, src, INTEL.statusCursor(src, p), (c, id) => c.query('SELECT * FROM si.si_read_source_status($1, $2, $3, $4)', [src, id, p.from, p.to]));
}
async function scnStatusSuspended(x) {                                       // mutant: status of a suspended source is served
  const src = await source(x); await control(x.si_rights_admin, src, 'SUSPEND');
  return libOutcome(INTEL.sourceStatus(await reader(x), src, period(0, 10)), () => 1);
}
async function scnStatusLatestVerified(x) {                                  // mutant: latest "verified" evidence names an INVALID run
  const src = await source(x);
  const ok = await collect(x, src, [AD('N S', 'v1')]); const bad = await collect(x, src, [AD('N S', 'v2')], { verify: false });
  await replica(x, `INSERT INTO si.receipt_verifications (run_id, source_id, rights_version_id, verdict, reason, commit_xid, commit_ts, window_start, window_end, verified_at, verified_by)
    SELECT r.run_id, r.source_id, r.rights_version_id, 'INVALID', 'COMMITTED_AFTER_WINDOW', 3, r.finished_at, r.finished_at - interval '1 hour', r.finished_at, clock_timestamp(), 'fixture'
      FROM si.collection_runs r WHERE r.run_id = $1`, [bad]);
  await at(x, ok, day(1).toISOString()); await at(x, bad, day(2).toISOString());
  return `value:${(await INTEL.sourceStatus(await reader(x), src, period(0, 10))).latestVerifiedEvidenceAt}`;
}
async function scnStatusIntent(x) {                                          // mutant: an evidence-page intent (another scope) releases status
  const src = await source(x);
  const alice = await reader(x);
  return sqlOutcome(await withFreshIntentRetry(async () =>
    settle(alice.query('SELECT * FROM si.si_read_source_status($1, $2, $3, $4)', [src, await beginRead(alice, src, { limit: 1 }), day(0), day(10)]))));
}
async function scnAvailGrant(x) {                                            // mutant: a revoked principal learns availability
  const src = await source(x);
  return revokedBetween(x, src, INTEL.availabilityCursor(src), (c, id) => c.query('SELECT * FROM si.si_read_source_availability($1, $2)', [src, id]));
}
async function scnAvailIntent(x) {                                           // mutant: a status intent (another scope) releases availability
  const src = await source(x), p = period(0, 10);
  const alice = await reader(x);
  return sqlOutcome(await withFreshIntentRetry(async () =>
    settle(alice.query('SELECT * FROM si.si_read_source_availability($1, $2)', [src, await beginRead(alice, src, { cursor: INTEL.statusCursor(src, p), limit: 1 })]))));
}
async function scnAvailReason(x) {                                           // mutant: a suspension is reported without its reason
  const src = await source(x); await control(x.si_rights_admin, src, 'SUSPEND');
  return libOutcome(INTEL.advertiserHistory(await reader(x), src, 'Northwind Synthetic'));
}
async function scnAvailRowVersion(x, L = INTEL) {                            // mutant: retirement moved into the margin and back mid-scan goes unnoticed
  const src = await source(x); await collect(x, src, [1, 2, 3].map(i => AD('Northwind Synthetic', `rv${n}-${i}`)));
  let step = 0;
  return libOutcome(L.advertiserHistory(interleaved(await reader(x), async k => {
    if (step === 0 && k === 1) { step = 1; await retire(x, src, "clock_timestamp() + interval '30 seconds'"); }
    else if (step === 1 && k === 0) { step = 2; await retire(x, src, 'NULL'); }
  }), src, 'Northwind Synthetic', { pageSize: 1 }));
}
const DB_MUTANTS = [
  { name: 'status grant check omitted', scenario: scnStatusGrant, baseline: 'SI_READ_NOT_AUTHORIZED', mutant: 'ok:1',
    sql: mutate(STATUS_FN, 'IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM si.reader_grants g', 'IF NOT FOUND OR false AND NOT EXISTS (SELECT 1 FROM si.reader_grants g') },
  { name: 'status availability check omitted', scenario: scnStatusSuspended, baseline: 'INTEL:SOURCE_UNAVAILABLE:SUSPENDED', mutant: 'ok:1',
    sql: mutate(STATUS_FN, '    IF available IS NOT TRUE THEN', '    IF false THEN') },
  { name: 'latest verified evidence not restricted to readable runs', scenario: scnStatusLatestVerified,
    baseline: `value:${day(1).toISOString()}`, mutant: `value:${day(2).toISOString()}`,
    sql: mutate(STATUS_FN, "           max(finished_at) FILTER (WHERE readable),", "           max(finished_at) FILTER (WHERE status = 'COMPLETED' AND published_count > 0),") },
  { name: 'status intent claim omitted', scenario: scnStatusIntent, baseline: 'SI_READ_INTENT_INVALID', mutant: 'ok:1',
    sql: mutate(STATUS_FN, '  PERFORM si.si_claim_read_intent(who, p_source_id, p_intent_id, cur, 1);', '') },
  { name: 'availability grant check omitted', scenario: scnAvailGrant, baseline: 'SI_READ_NOT_AUTHORIZED', mutant: 'ok:1',
    sql: mutate(AVAIL_FN, 'IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM si.reader_grants g', 'IF NOT FOUND OR false AND NOT EXISTS (SELECT 1 FROM si.reader_grants g') },
  { name: 'availability intent claim omitted', scenario: scnAvailIntent, baseline: 'SI_READ_INTENT_INVALID', mutant: 'ok:1',
    sql: mutate(AVAIL_FN, '  PERFORM si.si_claim_read_intent(who, p_source_id, p_intent_id, cur, 1);', '') },
  { name: 'availability SUSPENDED reason omitted', scenario: scnAvailReason, baseline: 'INTEL:SOURCE_UNAVAILABLE:SUSPENDED', mutant: 'INTEL:SOURCE_UNAVAILABLE:UNAVAILABLE',
    sql: mutate(AVAIL_FN, "      CASE WHEN cs.last_kind = 'SUSPEND' THEN 'SUSPENDED' END,", '') },
  { name: 'availability token ignores the source row version', scenario: scnAvailRowVersion, baseline: 'INTEL:AVAILABILITY_CHANGED', mutant: 'ok:1',
    sql: mutate(AVAIL_FN, "p_source_id, cs.row_version,", 'p_source_id,') }
];
for (const m of DB_MUTANTS) {
  test(`INT-M db (${m.name}): the baseline gives exactly its refusal or value, the mutant exactly the defect`, async t => {
    const base = await m.scenario(await fresh(t, 'm4mb'));
    const x = await fresh(t, 'm4mm');
    await asOwner(x.admin, a => a.query(m.sql));
    const killed = await m.scenario(x);
    console.log(`# INT-M db ${m.name}: baseline ${base}, mutant ${killed}`);
    assert.equal(base, m.baseline, `${m.name}: baseline outcome`);
    assert.equal(killed, m.mutant, `${m.name}: mutant outcome (killed for the intended reason)`);
  });
}

/** A mutated copy of the compiled library in a temporary directory (reader.js copied next to it); one or more edits. */
async function mutatedLibrary(t, edits) {
  const dir = mkdtempSync(join(tmpdir(), 'si-intel-mutant-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  copyFileSync(join(DIST, 'reader.js'), join(dir, 'reader.js'));
  let text = readFileSync(join(DIST, 'intelligence.js'), 'utf8');
  for (const [from, to] of edits) text = mutate(text, from, to);
  writeFileSync(join(dir, 'intelligence.js'), text);
  return import(pathToFileURL(join(dir, 'intelligence.js')).href);
}
async function lscnDistinct(L, x) {                                          // mutant: distinct ads counts observations
  const src = await source(x); await collect(x, src, [AD('Northwind Synthetic', 'd1')]); await collect(x, src, [AD('Northwind Synthetic', 'd1')]);
  return `value:${(await L.advertiserHistory(await reader(x), src, 'Northwind Synthetic')).distinctAds}`;
}
async function lscnBoundary(L, x) {                                          // mutant: a record exactly at `to` is included
  const src = await source(x); const r = await collect(x, src, [AD('Northwind Synthetic', 'edge')]); await at(x, r, day(14).toISOString());
  return libOutcome(L.advertiserHistory(await reader(x), src, 'Northwind Synthetic', { period: period(10, 14) }));
}
async function lscnMerge(L, x) {                                             // mutant: one advertiser hit merges two sources
  const a = await source(x), b = await source(x);
  await collect(x, a, [AD('Shared Synthetic', 'a1')]); await collect(x, b, [AD('Shared Synthetic', 'b1')]);
  return libOutcome(L.searchAdvertisers(await reader(x), { sources: [a, b], query: 'shared' }));
}
async function lscnIdentity(L, x) {                                          // mutant: history of "Acme" includes "Acme Labs"
  const src = await source(x); await collect(x, src, [AD('Acme Synthetic', 'a'), AD('Acme Synthetic Labs', 'b')]);
  return libOutcome(L.advertiserHistory(await reader(x), src, 'Acme Synthetic'));
}
async function lscnUnavailableEmpty(L, x) {                                  // mutant (D1 itself): a suspended source reads as empty history
  const src = await source(x); await collect(x, src, [AD('Northwind Synthetic', 'u1')]); await control(x.si_rights_admin, src, 'SUSPEND');
  return libOutcome(L.advertiserHistory(await reader(x), src, 'Northwind Synthetic'));
}
async function lscnSuspendLift(L, x) {                                       // mutant: suspend + lift during the scan returns a truncated success
  const src = await source(x); await collect(x, src, [1, 2, 3].map(i => AD('Northwind Synthetic', `sl${n}-${i}`)));
  let step = 0;
  return libOutcome(L.advertiserHistory(interleaved(await reader(x), async k => {
    if (step === 0 && k === 1) { step = 1; await control(x.si_rights_admin, src, 'SUSPEND'); }
    else if (step === 1 && k === 0) { step = 2; await lift(x.si_rights_admin, src); }
  }), src, 'Northwind Synthetic', { pageSize: 1 }));
}
const LIB_MUTANTS = [
  { name: 'distinct ads counted as observations', scenario: lscnDistinct, baseline: 'value:1', mutant: 'value:2',
    edits: [['distinctAds: new Set(mine.map(r => `${r.network}\\u0000${r.nativeAdId}`)).size,', 'distinctAds: mine.length,']] },
  { name: 'period end inclusive', scenario: lscnBoundary, baseline: 'ok:0', mutant: 'ok:1',
    edits: [['return t >= p.from.getTime() && t < p.to.getTime();', 'return t >= p.from.getTime() && t <= p.to.getTime();']] },
  { name: 'search merges sources', scenario: lscnMerge, baseline: 'ok:2', mutant: 'ok:1', edits: [['const k = `${sourceId}\\u0000${nn}`;', 'const k = nn;']] },
  { name: 'history identity by substring', scenario: lscnIdentity, baseline: 'ok:1', mutant: 'ok:2',
    edits: [['const mine = scan.records.filter(r => normalizeAdvertiser(r.advertiserName) === want && inPeriod(r, period));',
             'const mine = scan.records.filter(r => normalizeAdvertiser(r.advertiserName).includes(want) && inPeriod(r, period));']] },
  { name: 'scan availability checks omitted (D1)', scenario: lscnUnavailableEmpty, baseline: 'INTEL:SOURCE_UNAVAILABLE:SUSPENDED', mutant: 'ok:0',
    edits: [["    if (!before.available)\n        throw new IntelligenceFailed('SOURCE_UNAVAILABLE', { sourceId, reasons: before.reasons });\n", ''],
            ["    if (!after.available)\n        throw new IntelligenceFailed('SOURCE_UNAVAILABLE', { sourceId, reasons: after.reasons });\n", '']] },
  { name: 'scan state-token comparison omitted', scenario: lscnSuspendLift, baseline: 'INTEL:AVAILABILITY_CHANGED', mutant: 'ok:1',
    edits: [["    if (after.stateToken !== before.stateToken)\n        throw new IntelligenceFailed('AVAILABILITY_CHANGED', { sourceId });\n", '']] }
];
for (const m of LIB_MUTANTS) {
  test(`INT-M lib (${m.name}): the baseline gives exactly the correct outcome, the mutant exactly the defect`, async t => {
    const base = await m.scenario(INTEL, await fresh(t, 'm4lb'));
    const L = await mutatedLibrary(t, m.edits);
    const killed = await m.scenario(L, await fresh(t, 'm4lm'));
    console.log(`# INT-M lib ${m.name}: baseline ${base}, mutant ${killed}`);
    assert.equal(base, m.baseline, `${m.name}: baseline outcome`);
    assert.equal(killed, m.mutant, `${m.name}: mutant outcome (killed for the intended reason)`);
  });
}

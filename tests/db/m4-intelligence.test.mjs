// B-002 M4-P1: synthetic advertiser intelligence (history, search, freshness) over the verified read boundary.
// Real disposable PostgreSQL 16, synthetic sources only. Every value comes from si_read_evidence pages or the
// content-free si_read_source_status (migration 0011); no test reads evidence tables as a reader.
//
// Fixtures a product path cannot perform (labelled where used): the test superuser sets runs' finished_at to
// absolute, millisecond-precision historical times under session_replication_role = replica ("time shift": the
// only way to build multi-day history in a test), plants an INVALID verdict, disturbs a receipt identity, or ages
// a retention deadline; mutated copies of the status function (database) or of the library (temporary copy).
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
const MIG11 = readFileSync(new URL('../../db/migrations/0011_reader_status.up.sql', import.meta.url), 'utf8');
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

test('INT-5/INT-6: suspension and termination block reads immediately; status is refused', async t => {
  const x = await fresh(t);
  const s = await source(x), term = await source(x);
  await collect(x, s, [AD('Northwind Synthetic', 's1')]); await collect(x, term, [AD('Northwind Synthetic', 't1')]);
  const alice = await reader(x);
  assert.equal((await INTEL.advertiserHistory(alice, s, 'northwind synthetic')).observations.length, 1);
  await control(x.si_rights_admin, s, 'SUSPEND');
  await control(x.si_rights_admin, term, 'TERMINATE_RETENTION');
  for (const src of [s, term]) {
    assert.equal((await INTEL.advertiserHistory(alice, src, 'northwind synthetic')).observations.length, 0, `${src}: nothing readable`);
    await assert.rejects(INTEL.freshness(alice, src, period(-400, -40)), e => e instanceof INTEL.IntelligenceFailed && e.code === 'SOURCE_UNAVAILABLE');
  }
  await lift(x.si_rights_admin, s);
  assert.equal((await INTEL.advertiserHistory(alice, s, 'northwind synthetic')).observations.length, 1, 'LIFT restores');
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
  assert.deepEqual(first, await INTEL.searchAdvertisers(alice, q), 'repeatable');
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
  assert.deepEqual(await count(), { n: 4, c: 4, k: 4 }, '3 evidence pages (2 + 1 + empty) + 1 status: each its own committed, consumed request');
  const status = (await x.admin.query(`SELECT cursor_sha256, read_limit FROM si.read_intents WHERE rows_returned = 1 AND bytes_returned > 0 AND read_limit = 1`)).rows;
  assert.equal(status.length, 1);
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
// Negative-control mutants. Database: copies of the 0011 status function; library: a mutated temporary copy.
function fnText(mig, start, end) { const s = mig.indexOf(start); return mig.slice(s, mig.indexOf(end, s) + end.length).replace(/^CREATE FUNCTION/, 'CREATE OR REPLACE FUNCTION'); }
function mutate(text, from, to) { assert.equal(text.split(from).length, 2, `exactly one anchor: ${from.slice(0, 60)}`); return text.replace(from, to); }
const STATUS_FN = fnText(MIG11, 'CREATE FUNCTION si.si_read_source_status', 'END $read_source_status$;');
/** A raw call made the way the library makes it: a fail-closed INTENT_NOT_DURABLE (unrelated unflushed WAL) is retried
 *  with a fresh intent, at most 3 attempts; `attempt` sets up and returns the settled result of one attempt. */
async function withFreshIntentRetry(attempt) {
  let r;
  for (let i = 0; i < 3; i++) { r = await attempt(); if (!(r.status !== 'ok' && /^SI_READ_INTENT_NOT_DURABLE/.test(String(r.message)))) break; }
  return r;
}
async function scnStatusGrant(x) {                                           // detected = a principal whose grant was revoked gets status
  const src = await source(x);                                               // si_begin_read also checks the grant, so take the intent first
  const alice = await reader(x), p = period(0, 10);
  const r = await withFreshIntentRetry(async () => {
    const id = await beginRead(alice, src, { cursor: INTEL.statusCursor(src, p), limit: 1 });
    await revokeReader(x.si_rights_admin, 'si_reader_alice', src, 'revoked between intent and status');
    const out = await settle(alice.query('SELECT * FROM si.si_read_source_status($1, $2, $3, $4)', [src, id, p.from, p.to]));
    await grantReader(x.si_rights_admin, 'si_reader_alice', src, 'granted again for the next attempt');
    return out;
  });
  return r.status === 'ok';
}
async function scnStatusSuspended(x) {                                       // detected = status of a suspended source is served
  const src = await source(x); await control(x.si_rights_admin, src, 'SUSPEND');
  return (await settle(INTEL.sourceStatus(await reader(x), src, period(0, 10)))).status === 'ok';
}
async function scnStatusLatestVerified(x) {                                  // detected = latest "verified" evidence names an INVALID run
  const src = await source(x);
  const ok = await collect(x, src, [AD('N S', 'v1')]); const bad = await collect(x, src, [AD('N S', 'v2')], { verify: false });
  await replica(x, `INSERT INTO si.receipt_verifications (run_id, source_id, rights_version_id, verdict, reason, commit_xid, commit_ts, window_start, window_end, verified_at, verified_by)
    SELECT r.run_id, r.source_id, r.rights_version_id, 'INVALID', 'COMMITTED_AFTER_WINDOW', 3, r.finished_at, r.finished_at - interval '1 hour', r.finished_at, clock_timestamp(), 'fixture'
      FROM si.collection_runs r WHERE r.run_id = $1`, [bad]);
  await at(x, ok, day(1).toISOString()); await at(x, bad, day(2).toISOString());
  return (await INTEL.sourceStatus(await reader(x), src, period(0, 10))).latestVerifiedEvidenceAt === day(2).toISOString();
}
async function scnStatusIntent(x) {                                          // detected = an evidence-page intent (another scope) releases status
  const src = await source(x);
  const alice = await reader(x);
  const r = await withFreshIntentRetry(async () =>
    settle(alice.query('SELECT * FROM si.si_read_source_status($1, $2, $3, $4)', [src, await beginRead(alice, src, { limit: 1 }), day(0), day(10)])));
  return r.status === 'ok';
}
const DB_MUTANTS = [
  { name: 'status grant check omitted', scenario: scnStatusGrant,
    sql: mutate(STATUS_FN, 'IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM si.reader_grants g', 'IF NOT FOUND OR false AND NOT EXISTS (SELECT 1 FROM si.reader_grants g') },
  { name: 'status availability check omitted', scenario: scnStatusSuspended, sql: mutate(STATUS_FN, '    IF available IS NOT TRUE THEN', '    IF false THEN') },
  { name: 'latest verified evidence not restricted to readable runs', scenario: scnStatusLatestVerified,
    sql: mutate(STATUS_FN, "           max(finished_at) FILTER (WHERE readable),", "           max(finished_at) FILTER (WHERE status = 'COMPLETED' AND published_count > 0),") },
  { name: 'status intent claim omitted', scenario: scnStatusIntent, sql: mutate(STATUS_FN, '  PERFORM si.si_claim_read_intent(who, p_source_id, p_intent_id, cur, 1);', '') }
];
for (const m of DB_MUTANTS) {
  test(`INT-M db (${m.name}): the baseline passes the scenario and the mutant is detected`, async t => {
    const base = await m.scenario(await fresh(t, 'm4mb'));
    const x = await fresh(t, 'm4mm');
    await asOwner(x.admin, a => a.query(m.sql));
    const killed = await m.scenario(x);
    console.log(`# INT-M db ${m.name}: baseline ${base ? 'DETECTED (unexpected)' : 'clean'}, mutant ${killed ? 'KILLED' : 'SURVIVED'}`);
    assert.equal(base, false); assert.equal(killed, true);
  });
}

/** A mutated copy of the compiled library in a temporary directory (reader.js copied next to it). */
async function mutatedLibrary(t, from, to) {
  const dir = mkdtempSync(join(tmpdir(), 'si-intel-mutant-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  copyFileSync(join(DIST, 'reader.js'), join(dir, 'reader.js'));
  writeFileSync(join(dir, 'intelligence.js'), mutate(readFileSync(join(DIST, 'intelligence.js'), 'utf8'), from, to));
  return import(pathToFileURL(join(dir, 'intelligence.js')).href);
}
async function lscnDistinct(L, x) {                                          // detected = distinct ads counts observations
  const src = await source(x); await collect(x, src, [AD('Northwind Synthetic', 'd1')]); await collect(x, src, [AD('Northwind Synthetic', 'd1')]);
  return (await L.advertiserHistory(await reader(x), src, 'Northwind Synthetic')).distinctAds !== 1;
}
async function lscnBoundary(L, x) {                                          // detected = a record exactly at `to` is included
  const src = await source(x); const r = await collect(x, src, [AD('Northwind Synthetic', 'edge')]); await at(x, r, day(14).toISOString());
  return (await L.advertiserHistory(await reader(x), src, 'Northwind Synthetic', { period: period(10, 14) })).observations.length !== 0;
}
async function lscnMerge(L, x) {                                             // detected = one advertiser hit merges two sources
  const a = await source(x), b = await source(x);
  await collect(x, a, [AD('Shared Synthetic', 'a1')]); await collect(x, b, [AD('Shared Synthetic', 'b1')]);
  return (await L.searchAdvertisers(await reader(x), { sources: [a, b], query: 'shared' })).hits.length !== 2;
}
async function lscnIdentity(L, x) {                                          // detected = history of "Acme" includes "Acme Labs"
  const src = await source(x); await collect(x, src, [AD('Acme Synthetic', 'a'), AD('Acme Synthetic Labs', 'b')]);
  return (await L.advertiserHistory(await reader(x), src, 'Acme Synthetic')).observations.length !== 1;
}
const LIB_MUTANTS = [
  { name: 'distinct ads counted as observations', scenario: lscnDistinct,
    from: 'distinctAds: new Set(mine.map(r => `${r.network}\\u0000${r.nativeAdId}`)).size,', to: 'distinctAds: mine.length,' },
  { name: 'period end inclusive', scenario: lscnBoundary, from: 'return t >= p.from.getTime() && t < p.to.getTime();', to: 'return t >= p.from.getTime() && t <= p.to.getTime();' },
  { name: 'search merges sources', scenario: lscnMerge, from: 'const k = `${sourceId}\\u0000${nn}`;', to: 'const k = nn;' },
  { name: 'history identity by substring', scenario: lscnIdentity,
    from: 'const mine = scan.records.filter(r => normalizeAdvertiser(r.advertiserName) === want && inPeriod(r, period));',
    to: 'const mine = scan.records.filter(r => normalizeAdvertiser(r.advertiserName).includes(want) && inPeriod(r, period));' }
];
for (const m of LIB_MUTANTS) {
  test(`INT-M lib (${m.name}): the baseline passes the scenario and the mutant is detected`, async t => {
    const base = await m.scenario(INTEL, await fresh(t, 'm4lb'));
    const L = await mutatedLibrary(t, m.from, m.to);
    const killed = await m.scenario(L, await fresh(t, 'm4lm'));
    console.log(`# INT-M lib ${m.name}: baseline ${base ? 'DETECTED (unexpected)' : 'clean'}, mutant ${killed ? 'KILLED' : 'SURVIVED'}`);
    assert.equal(base, false); assert.equal(killed, true);
  });
}

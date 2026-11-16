// B-002 M4-P3.1: immutable per-run advertiser summaries and the per-source identity dictionary (migration 0020).
// Real disposable PostgreSQL 16, synthetic sources only. Nothing here reads through the M4 readers' summaries: they are
// not switched (M4-P3.2). The reference for every summary is an INDEPENDENT recomputation in JavaScript from the raw
// observations (only the normalizer, the identity rule itself, is evaluated by the database).
//
// Fixtures a product path cannot perform, labelled where used:
//   - COLLISION: SHA-256 collisions cannot be constructed; the digest CHECK is dropped in a disposable database and a
//     dictionary row is planted whose digest belongs to another normalized name.
//   - PRE-0020 DATA: a database migrated to 0019, populated through the product path, then migrated to 0020.
//   - NORMALIZER CHANGE: si_normalizer_fingerprint replaced (owner) to simulate an ICU/major-version change.
//   - CORRUPTION: the owner disables the 0020 insert guard and adds evidence to a completed run.
//
//   SUM-1  publication: summaries equal the independent recomputation (repeated ads across runs, several sources,
//          networks, spellings, long Unicode names); distinct ads across runs = |union of ad_ids| (not the sum).
//   SUM-2  identity: spellings that normalize equally share one identity; a planted digest collision fails the
//          publication closed and atomically (run stays RUNNING, no evidence, no summary).
//   SUM-3  atomicity: a rolled-back publication leaves nothing; a duplicate completion is refused and changes nothing;
//          concurrent publications sharing identities neither deadlock nor duplicate identities.
//   SUM-4  backfill: pre-0020 data is INCOMPLETE until backfilled; bounded, resumable, an interrupted batch leaves
//          nothing; the result equals publication-time summaries; search results are unchanged throughout.
//   SUM-5  normalizer change: runs become STALE (coverage INCOMPLETE), backfill re-derives them, old identities go.
//   SUM-6  drift: privileged evidence corruption is found by verification (DRIFT), blocks coverage, rebuild requires
//          the recorded drift, a clean verification clears it; summaries refuse UPDATE/DELETE/TRUNCATE.
//   SUM-7  lifecycle: verdicts, rights, controls and grants do not touch summaries; purge removes the run's summaries
//          and the identities it alone held; purge and backfill serialize on the source lock in either order.
//   SUM-M  targeted mutants, each killed for its stated reason (a setup failure is never a kill).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { latestDefinition } from './durability-fixtures.mjs';
import { asOwner, cfg, connect, control, createSources, freshDatabase, lift, recordRights, roles } from './helpers.mjs';
import { provisionReaderPrincipal } from '../../dist/persistence/bootstrap.js';
import { fixtureSha256, requestSha256 } from '../../dist/persistence/request-hash.js';
import { grantReader, revokeReader } from '../../dist/persistence/reader.js';
import { migrateUp } from '../../dist/persistence/migrate.js';
import * as INTEL from '../../dist/persistence/intelligence.js';

const ROLES = ['admin', 'si_rights_admin', 'si_collector', 'si_monitor', 'si_retention'];
const GATE = readFileSync(new URL('../../db/ops/integrity-gate.sql', import.meta.url), 'utf8');
const AUDIT = readFileSync(new URL('../../db/ops/fk-audit.sql', import.meta.url), 'utf8');
let n = 0;
test.before(async () => { const a = await connect(); try { await provisionReaderPrincipal(a, 'si_reader_alice', cfg.rolePassword); } finally { await a.end(); } });

function mutate(text, from, to) { assert.equal(text.split(from).length, 2, `exactly one anchor: ${from.slice(0, 70)}`); return text.replace(from, () => to); }
const AD = (id, name, network = 'META') => ({ network, nativeAdId: id, advertiserName: name, countries: ['DE'], seenAt: '2026-01-01T00:00:00.000Z',
  sourceUrl: `https://example.test/${encodeURIComponent(id)}`, destinationUrl: 'https://example.test/d', creativeUrl: 'https://example.test/c', title: `Synthetic ${id}` });
async function begin(x, src, rows, collector = x.si_collector) {
  const networks = [...new Set(rows.map(r => r.network))].sort();
  const fx = fixtureSha256(rows), sha = requestSha256({ adapterId: src, evidenceKind: 'SYNTHETIC', networks: networks.length ? networks : ['META'], fixtureSha256: fx });
  return (await collector.query('SELECT * FROM si.si_begin_run_scoped($1,$2,$3,$4,$5::text[],$6)', [src, `sum${++n}`, sha, 'SYNTHETIC', networks.length ? networks : ['META'], fx])).rows[0];
}
async function complete(x, run, rows, collector = x.si_collector) {
  await collector.query('BEGIN');
  try { await collector.query('SELECT * FROM si.si_complete_run($1::uuid, $2::uuid, $3::jsonb)', [run.run_id, run.lease_token, JSON.stringify(rows)]); await collector.query('COMMIT'); }
  catch (e) { await collector.query('ROLLBACK').catch(() => {}); throw e; }
}
async function verifyReceipts(x) {
  for (let i = 0; i < 20; i++) { const r = await x.si_monitor.query('SELECT * FROM si.si_verify_receipts(500)'); if (!r.rows.length || Number(r.rows[0].verified) === 0) break; }
}
async function collect(x, src, rows, { verify = true } = {}) {
  const run = await begin(x, src, rows); await complete(x, run, rows); if (verify) await verifyReceipts(x); return run.run_id;
}
async function fresh(t, prefix, opts) {
  const db = await freshDatabase(t, prefix, opts);
  const x = await roles(t, db, ROLES);
  Object.defineProperty(x, 'db', { value: db, enumerable: false });
  return x;
}
async function source(x, id, networks = ['META', 'TIKTOK', 'GOOGLE']) {
  await createSources(x.admin, [id], networks); await recordRights(x.si_rights_admin, id, {}); return id;
}
const utf8cmp = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/** Independent recomputation: per run, per (normalized name, network): count, sorted ad ids, sorted distinct names. */
async function expected(c, src) {
  const obs = (await c.query(`SELECT o.run_id, o.ad_id::text AS ad_id, o.network, o.native_ad_id, o.advertiser_name, si.si_normalize_advertiser(o.advertiser_name) AS nn
                                FROM si.observations o WHERE o.source_id = $1`, [src])).rows;
  const m = new Map();
  for (const o of obs) {
    const k = `${o.run_id}\u0000${o.nn}\u0000${o.network}`;
    const e = m.get(k) ?? { run_id: o.run_id, nn: o.nn, network: o.network, observations: 0, ad_ids: [], names: new Set() };
    e.observations++; e.ad_ids.push(BigInt(o.ad_id)); e.names.add(o.advertiser_name); m.set(k, e);
  }
  return [...m.values()].map(e => ({ run_id: e.run_id, nn: e.nn, network: e.network, observations: e.observations,
    ad_ids: e.ad_ids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map(String), names: [...e.names].sort(utf8cmp) }))
    .sort((a, b) => (a.run_id + a.network).localeCompare(b.run_id + b.network) || utf8cmp(a.nn, b.nn));
}
async function stored(c, src) {
  const rows = (await c.query(`SELECT s.run_id, i.normalized_name AS nn, s.network, s.observations, s.ad_ids::text[] AS ad_ids, s.names
                                 FROM si.run_advertiser_summaries s JOIN si.advertiser_identities i ON i.identity_id = s.identity_id
                                WHERE s.source_id = $1`, [src])).rows;
  return rows.map(r => ({ ...r })).sort((a, b) => (a.run_id + a.network).localeCompare(b.run_id + b.network) || utf8cmp(a.nn, b.nn));
}
const verify = async (c, src) => (await asOwnerQ(c, `SELECT run_id, finding FROM si.si_verify_summaries($1)`, [src])).map(r => `${r.finding}${r.run_id ? ':' + r.run_id.slice(0, 8) : ''}`);
const coverage = async (c, src) => (await asOwnerQ(c, `SELECT eligible, reasons FROM si.si_summary_coverage($1)`, [src]))[0];
async function asOwnerQ(c, sql, params) { let rows; await asOwner(c, async a => { rows = (await a.query(sql, params)).rows; }); return rows; }
const tableDigest = async c => (await c.query(`SELECT md5(coalesce(string_agg(t::text, E'\\n' ORDER BY t::text), '')) AS h FROM (
    SELECT s::text AS t FROM si.run_advertiser_summaries s UNION ALL SELECT i::text FROM si.advertiser_identities i
    UNION ALL SELECT (st.run_id, st.normalizer, st.observation_count, st.summary_rows, st.identities, st.content_digest, st.method)::text FROM si.run_summary_status st) q`)).rows[0].h;

// ------------------------------------------------------------------------------------------------
test('SUM-1: publication-time summaries equal the independent recomputation; distinct ads are a union, not a sum', async t => {
  const x = await fresh(t, 'm4sum1');
  const c = x.admin;
  const a = await source(x, 'sum-a'), b = await source(x, 'sum-b', ['META']);
  const LONG = 'ﷺ'.repeat(1000);                                          // NFKC expands each to 18 characters: 18,000
  const runs = [];
  runs.push(await collect(x, a, [AD('a1', 'Acme Synthetic'), AD('a2', 'ACME  Synthetic'), AD('t1', 'Acme Synthetic', 'TIKTOK'), AD('l1', LONG), AD('u1', 'Ｆｕｌｌ　Ｗｉｄｔｈ')]));
  runs.push(await collect(x, a, [AD('a1', 'Acme Synthetic'), AD('a3', 'acme\u3000synthetic'), AD('g1', '\u{1F600} Emoji Co', 'GOOGLE'), AD('u2', 'full width')]));
  runs.push(await collect(x, a, [AD('a1', 'Acme Synthetic'), AD('a2', 'Acme Synthetic')]));
  runs.push(await collect(x, a, []).catch(() => null) ?? (await begin(x, a, [])).run_id);   // an EMPTY run (or a running one)
  runs.push(await collect(x, b, [AD('a1', 'Acme Synthetic'), AD('b1', 'Beta')]));         // another source, same native id
  for (const s of [a, b]) {
    assert.deepEqual(await stored(c, s), await expected(c, s), `${s}: stored summaries == independent recomputation`);
    assert.deepEqual(await verify(c, s), [], `${s}: verification clean`);
    assert.deepEqual(await coverage(c, s), { eligible: true, reasons: [] }, `${s}: eligible`);
  }
  // Status rows: one per completed run, counts consistent, method PUBLICATION.
  const st = (await c.query(`SELECT s.run_id, s.observation_count, s.summary_rows, s.method, r.published_count, r.retention_state
                               FROM si.run_summary_status s JOIN si.collection_runs r USING (run_id) ORDER BY 1`)).rows;
  assert.ok(st.length >= 4 && st.every(r => r.method === 'PUBLICATION' && r.observation_count === r.published_count), 'status covers each publication');
  // Identities: one per (source, normalized name); the 18,000-character name is stored (digest-indexed).
  const ids = (await c.query(`SELECT source_id, normalized_name, length(normalized_name) AS len FROM si.advertiser_identities ORDER BY 1, 2`)).rows;
  assert.deepEqual(ids.filter(r => r.source_id === a).map(r => r.normalized_name).filter(v => v.length < 100).sort(),
    ['acme synthetic', 'full width', '\u{1F600} emoji co'].sort(), 'spellings unify into one identity per normalized name');
  assert.equal(ids.find(r => r.len === 18000)?.source_id, a, 'the 18,000-character normalized name is an identity');
  assert.deepEqual(ids.filter(r => r.source_id === b).map(r => r.normalized_name), ['acme synthetic', 'beta'], 'per-source dictionary');
  // Distinct ads across runs for 'acme synthetic' in source a: union of ad_ids vs sum of per-run counts.
  const u = (await c.query(`SELECT count(DISTINCT x)::int AS union_n, sum(s.observations)::int AS summed
                              FROM si.run_advertiser_summaries s JOIN si.advertiser_identities i ON i.identity_id = s.identity_id,
                                   unnest(s.ad_ids) x
                             WHERE s.source_id = $1 AND i.normalized_name = 'acme synthetic'`, [a])).rows[0];
  const direct = (await c.query(`SELECT count(DISTINCT (network, native_ad_id))::int AS n, count(*)::int AS obs FROM si.observations
                                  WHERE source_id = $1 AND si.si_normalize_advertiser(advertiser_name) = 'acme synthetic'`, [a])).rows[0];
  console.log(`# SUM-1 acme synthetic: distinct ads ${direct.n} (union of ad_ids ${u.union_n}); per-run counts summed ${direct.obs}`);
  assert.equal(u.union_n, direct.n, 'distinct ads = |union of ad_ids|');
  assert.ok(direct.obs > direct.n, 'the fixture repeats ads across runs (a sum would over-count)');
  assert.deepEqual(await c.query(GATE).then(r => r.rows), [], 'integrity gate PASS');
  assert.deepEqual(await c.query(AUDIT).then(r => r.rows), [], 'FK_AUDIT PASS');
});

// ------------------------------------------------------------------------------------------------
async function collisionScenario(t, mutantSql) {
  const x = await fresh(t, 'm4sum2');
  const c = x.admin;
  if (mutantSql) await asOwner(c, a => a.query(mutantSql));
  const s = await source(x, 'sum-col', ['META']);
  // COLLISION fixture: the digest of 'acme victim' recorded for another normalized name.
  await c.query('ALTER TABLE si.advertiser_identities DROP CONSTRAINT advertiser_identities_digest');
  const runFirst = await collect(x, s, [AD('x0', 'Seed')]);
  await asOwner(c, a => a.query(`INSERT INTO si.advertiser_identities (source_id, normalizer, advertiser_key, normalized_name, first_run_id)
      VALUES ($1, si.si_normalizer_fingerprint(), si.si_advertiser_key('Acme Victim'), 'impostor', $2)`, [s, runFirst]));
  const run = await begin(x, s, [AD('v1', 'Acme Victim')]);
  let outcome;
  try { await complete(x, run, [AD('v1', 'Acme Victim')]); outcome = 'published'; } catch (e) { outcome = `refused:${e.message.split(':')[0]}`; }
  const after = (await c.query(`SELECT r.status, (SELECT count(*)::int FROM si.observations o WHERE o.run_id = r.run_id) AS obs,
      (SELECT count(*)::int FROM si.run_advertiser_summaries s WHERE s.run_id = r.run_id) AS sums FROM si.collection_runs r WHERE r.run_id = $1`, [run.run_id])).rows[0];
  return { outcome, after };
}
test('SUM-2: one identity per normalized name; a digest collision fails the publication closed and atomically', async t => {
  const { outcome, after } = await collisionScenario(t);
  assert.equal(outcome, 'refused:SI_SUMMARY_IDENTITY_COLLISION');
  assert.deepEqual(after, { status: 'RUNNING', obs: 0, sums: 0 }, 'nothing was published: no evidence, no summary, run still RUNNING');
});

// ------------------------------------------------------------------------------------------------
test('SUM-3: rollback leaves nothing; a duplicate completion changes nothing; concurrent publications share identities safely', async t => {
  const x = await fresh(t, 'm4sum3');
  const c = x.admin;
  const s = await source(x, 'sum-atom');
  const rows = [AD('r1', 'Rollback Co'), AD('r2', 'Rollback Co', 'TIKTOK')];
  const run = await begin(x, s, rows);
  await x.si_collector.query('BEGIN');
  await x.si_collector.query('SELECT * FROM si.si_complete_run($1::uuid, $2::uuid, $3::jsonb)', [run.run_id, run.lease_token, JSON.stringify(rows)]);
  await x.si_collector.query('ROLLBACK');
  const cnt = async () => (await c.query(`SELECT (SELECT count(*) FROM si.run_advertiser_summaries)::int AS s, (SELECT count(*) FROM si.advertiser_identities)::int AS i,
      (SELECT count(*) FROM si.run_summary_status)::int AS st, (SELECT count(*) FROM si.observations)::int AS o`)).rows[0];
  assert.deepEqual(await cnt(), { s: 0, i: 0, st: 0, o: 0 }, 'rolled back: nothing remains');
  await complete(x, run, rows);
  const once = await tableDigest(c);
  await assert.rejects(complete(x, run, rows), /SI_T2_NOT_OWNER/, 'the duplicate completion is refused (existing idempotency)');
  assert.equal(await tableDigest(c), once, 'and changes no summary');
  // Concurrent publications of one source with overlapping advertisers (sorted identity inserts: no deadlock).
  const cols = await Promise.all(Array.from({ length: 6 }, () => connect({ user: 'si_collector', database: x.db })));
  t.after(() => Promise.all(cols.map(k => k.end().catch(() => {}))));
  const jobs = cols.map(async (k, j) => {
    for (let i = 0; i < 5; i++) {
      const rws = Array.from({ length: 8 }, (_, q) => AD(`c${j}-${i}-${q}`, `Shared ${(q + j) % 5}`, q % 2 ? 'TIKTOK' : 'META'));
      const r = await begin(x, s, rws, k); await complete(x, r, rws, k);
    }
  });
  await Promise.all(jobs);
  const dupes = (await c.query(`SELECT count(*)::int AS n FROM (SELECT normalized_name FROM si.advertiser_identities WHERE source_id = $1
                                  GROUP BY 1 HAVING count(*) > 1) d`, [s])).rows[0].n;
  assert.equal(dupes, 0, 'one identity per normalized name under concurrency');
  assert.deepEqual(await stored(c, s), await expected(c, s), 'all concurrent summaries equal the recomputation');
  assert.deepEqual(await verify(c, s), []);
});

// ------------------------------------------------------------------------------------------------
async function preSummaryDatabase(t, prefix) {
  const x = await fresh(t, prefix, { migrate: false });
  await migrateUp(x.admin, { to: 19 });
  return x;
}
test('SUM-4: backfill of pre-0020 data — incomplete until done, bounded, resumable, an interrupted batch leaves nothing; readers unchanged', async t => {
  const x = await preSummaryDatabase(t, 'm4sum4');
  const c = x.admin;
  const s = await source(x, 'sum-bf');
  await grantReader(x.si_rights_admin, 'si_reader_alice', s, 'm4-p3.1');
  for (let k = 0; k < 7; k++) await collect(x, s, [AD(`b${k}a`, `Backfill ${k % 3}`), AD(`b${k}b`, `Backfill ${(k + 1) % 3}`, 'TIKTOK')]);
  const alice = await connect({ user: 'si_reader_alice', database: x.db });
  t.after(() => alice.end().catch(() => {}));
  const search = async () => JSON.stringify((await INTEL.searchAdvertisers(alice, { sources: [s], query: 'backfill', limit: 20 })).hits);
  const before = await search();
  assert.deepEqual(await migrateUp(c, { to: 20 }), [20]);
  assert.deepEqual(await coverage(c, s), { eligible: false, reasons: ['INCOMPLETE'] }, 'pre-0020 runs: not eligible');
  assert.equal(await search(), before, 'the reader is unchanged by the migration');
  // An interrupted batch (rolled back) leaves nothing.
  await c.query('BEGIN'); await c.query('SET LOCAL ROLE si_owner');
  const r1 = (await c.query('SELECT * FROM si.si_backfill_summaries(3)')).rows[0];
  await c.query('ROLLBACK');
  assert.deepEqual([r1.summarized, r1.remaining], [3, 4], 'inside the batch: 3 summarized, 4 remaining');
  assert.equal((await c.query('SELECT count(*)::int AS n FROM si.run_summary_status')).rows[0].n, 0, 'interrupted: nothing persisted');
  // Resumable, deterministic order, bounded.
  const steps = [];
  for (;;) { const r = (await asOwnerQ(c, 'SELECT * FROM si.si_backfill_summaries(3)'))[0]; steps.push([r.summarized, r.remaining]); if (r.remaining === 0) break;
    assert.deepEqual(await coverage(c, s), { eligible: false, reasons: ['INCOMPLETE'] }, 'partial: still not eligible'); }
  assert.deepEqual(steps, [[3, 4], [3, 1], [1, 0]]);
  assert.deepEqual((await asOwnerQ(c, 'SELECT * FROM si.si_backfill_summaries(3)'))[0], { summarized: 0, remaining: 0 }, 'idempotent');
  assert.deepEqual(await coverage(c, s), { eligible: true, reasons: [] });
  assert.deepEqual(await stored(c, s), await expected(c, s), 'backfilled summaries == independent recomputation');
  assert.deepEqual(await verify(c, s), []);
  assert.ok((await c.query(`SELECT bool_and(method = 'BACKFILL') AS b FROM si.run_summary_status`)).rows[0].b);
  assert.equal(await search(), before, 'the reader is unchanged by the backfill');
  // A run published after 0020 is summarized at publication.
  await collect(x, s, [AD('late', 'Backfill 0')]);
  assert.deepEqual(await coverage(c, s), { eligible: true, reasons: [] });
  assert.deepEqual(await stored(c, s), await expected(c, s));
});

// ------------------------------------------------------------------------------------------------
test('SUM-5: a normalizer change makes summaries STALE; backfill re-derives them and removes the old identities', async t => {
  const x = await fresh(t, 'm4sum5');
  const c = x.admin;
  const s = await source(x, 'sum-nz');
  for (let k = 0; k < 3; k++) await collect(x, s, [AD(`n${k}`, `Norm ${k}`)]);
  const oldIds = (await c.query('SELECT array_agg(identity_id ORDER BY identity_id) AS a FROM si.advertiser_identities')).rows[0].a;
  const FP = latestDefinition('si_normalizer_fingerprint', '$normalizer_fingerprint$;').text;
  await asOwner(c, a => a.query(mutate(FP, "'|pg=' || (current_setting('server_version_num')::int / 10000)::text", "'|pg=simulated-upgrade'")));
  assert.deepEqual(await coverage(c, s), { eligible: false, reasons: ['INCOMPLETE'] }, 'stale summaries are not eligible');
  const r = (await asOwnerQ(c, 'SELECT * FROM si.si_backfill_summaries(10)'))[0];
  assert.deepEqual(r, { summarized: 3, remaining: 0 });
  assert.deepEqual(await coverage(c, s), { eligible: true, reasons: [] });
  const now = (await c.query(`SELECT array_agg(identity_id ORDER BY identity_id) AS a, bool_and(normalizer LIKE '%simulated-upgrade') AS b FROM si.advertiser_identities`)).rows[0];
  assert.ok(now.b, 'every identity is under the new fingerprint');
  assert.ok(!now.a.some(v => oldIds.includes(v)), 'the old identities were removed with their stale summaries');
  assert.deepEqual(await stored(c, s), await expected(c, s));
  assert.deepEqual(await verify(c, s), []);
});

// ------------------------------------------------------------------------------------------------
test('SUM-6: privileged corruption is found and blocks coverage; rebuild requires recorded drift; summaries are append-only', async t => {
  const x = await fresh(t, 'm4sum6');
  const c = x.admin;
  const s = await source(x, 'sum-dr');
  const R = await collect(x, s, [AD('d1', 'Drift Co')]);
  await collect(x, s, [AD('d2', 'Other Co')]);
  await assert.rejects(asOwner(c, a => a.query(`SELECT si.si_rebuild_run_summaries($1)`, [R])), /SI_SUMMARY_NO_DRIFT/, 'no rebuild without recorded drift');
  // Append-only, also for the owner.
  for (const sql of ['UPDATE si.run_advertiser_summaries SET observations = observations', 'DELETE FROM si.run_advertiser_summaries',
                     'TRUNCATE si.run_advertiser_summaries', 'UPDATE si.run_summary_status SET method = method', 'DELETE FROM si.run_summary_status',
                     'DELETE FROM si.advertiser_identities', 'TRUNCATE si.summary_events', 'TRUNCATE si.advertiser_identities CASCADE']) {
    await assert.rejects(asOwner(c, a => a.query(sql)), /SI_SUMMARY_IMMUTABLE/, `refused: ${sql}`);
  }
  // CORRUPTION: the owner disables the insert guard and adds evidence to the completed run R.
  await c.query('BEGIN'); await c.query('SET LOCAL ROLE si_owner');
  await assert.rejects(c.query(`INSERT INTO si.observations (run_id, source_id, rights_version_id, ordinal, ad_id, network, native_ad_id, advertiser_name, countries, seen_at, source_url, content_sha256)
      SELECT run_id, source_id, rights_version_id, 1, ad_id, network, native_ad_id, advertiser_name, countries, seen_at, source_url, content_sha256
        FROM si.observations WHERE run_id = $1`, [R]), /SI_EVIDENCE_IMMUTABLE/, 'the 0020 guard refuses evidence for a completed run');
  await c.query('ROLLBACK');
  await c.query('BEGIN'); await c.query('SET LOCAL ROLE si_owner');
  await c.query('ALTER TABLE si.observations DISABLE TRIGGER trg_observation_open_run');
  await c.query(`INSERT INTO si.ads (source_id, network, native_ad_id, first_run_id) VALUES ($1, 'META', 'd1-extra', $2)`, [s, R]);
  await c.query(`INSERT INTO si.observations (run_id, source_id, rights_version_id, ordinal, ad_id, network, native_ad_id, advertiser_name, countries, seen_at, source_url, content_sha256)
      SELECT o.run_id, o.source_id, o.rights_version_id, 1, a.ad_id, a.network, a.native_ad_id, 'Drift Co', o.countries, o.seen_at, o.source_url, o.content_sha256
        FROM si.observations o JOIN si.ads a ON a.native_ad_id = 'd1-extra' WHERE o.run_id = $1`, [R]);
  await c.query('SET CONSTRAINTS ALL IMMEDIATE');                              // the deferred integrity checks run (and pass)
  await c.query('ALTER TABLE si.observations ENABLE TRIGGER trg_observation_open_run');
  await c.query('COMMIT');
  const found = await verify(c, s);
  console.log(`# SUM-6 verification after corruption: ${JSON.stringify(found)}`);
  assert.deepEqual(found, [`CONTENT_MISMATCH:${R.slice(0, 8)}`, `STATUS_MISMATCH:${R.slice(0, 8)}`]);
  assert.deepEqual(await coverage(c, s), { eligible: false, reasons: ['DRIFT'] }, 'drift blocks summary-backed reads');
  await asOwner(c, a => a.query(`SELECT si.si_rebuild_run_summaries($1)`, [R]));
  assert.deepEqual(await coverage(c, s), { eligible: false, reasons: ['DRIFT'] }, 'still blocked until a clean verification');
  assert.deepEqual(await verify(c, s), [], 'the rebuilt run matches its (corrupted) evidence');
  assert.deepEqual(await coverage(c, s), { eligible: true, reasons: [] }, 'cleared');
  const ev = (await c.query(`SELECT kind, finding FROM si.summary_events ORDER BY event_id`)).rows.map(r => `${r.kind}${r.finding ? ':' + r.finding : ''}`);
  assert.deepEqual(ev, ['DRIFT_DETECTED:CONTENT_MISMATCH', 'DRIFT_DETECTED:STATUS_MISMATCH', 'REBUILT', 'DRIFT_CLEARED'], 'the record is append-only and complete');
  assert.deepEqual(await stored(c, s), await expected(c, s));
  assert.deepEqual((await c.query(AUDIT)).rows, [], 'the corrupting rows were FK-consistent (FK_AUDIT cannot see this; verification can)');
});

// ------------------------------------------------------------------------------------------------
test('SUM-7: verdicts, rights, controls and grants do not touch summaries; purge removes them; purge and backfill serialize', async t => {
  const x = await fresh(t, 'm4sum7');
  const c = x.admin;
  const s = await source(x, 'sum-lc');
  const P = await collect(x, s, [AD('p1', 'Purged Only'), AD('p2', 'Shared Co')]);
  const K = await collect(x, s, [AD('k1', 'Shared Co'), AD('k2', 'Kept Only')]);
  const pending = await collect(x, s, [AD('v1', 'Verdict Co')], { verify: false });
  const h0 = await tableDigest(c);
  await verifyReceipts(x);                                                    // a verdict arrives
  await recordRights(x.si_rights_admin, s, {});                               // a new rights version
  await control(x.si_rights_admin, s, 'SUSPEND'); await lift(x.si_rights_admin, s);
  await grantReader(x.si_rights_admin, 'si_reader_alice', s, 'm4-p3.1'); await revokeReader(x.si_rights_admin, 'si_reader_alice', s, 'm4-p3.1');
  assert.equal(await tableDigest(c), h0, 'summaries, identities and status are byte-identical');
  void pending;
  // Purge P (retention ended): its summaries, status and the identity it alone held go; the shared identity stays.
  await c.query('BEGIN'); await c.query('SET LOCAL session_replication_role = replica');
  await c.query(`UPDATE si.collection_runs SET retain_until = clock_timestamp() - interval '1 minute' WHERE run_id = $1`, [P]);
  await c.query('COMMIT');
  const t0 = performance.now();
  const p = (await x.si_retention.query('SELECT * FROM si.si_purge_due(20)')).rows[0];
  console.log(`# SUM-7 purge of one run with summaries: ${p.outcome} in ${(performance.now() - t0).toFixed(1)} ms`);
  assert.equal(p.outcome, 'PURGED');
  const left = (await c.query(`SELECT (SELECT count(*) FROM si.run_advertiser_summaries WHERE run_id = $1)::int AS sums,
      (SELECT count(*) FROM si.run_summary_status WHERE run_id = $1)::int AS st,
      (SELECT array_agg(normalized_name ORDER BY normalized_name COLLATE "C") FROM si.advertiser_identities WHERE source_id = $2) AS ids`, [P, s])).rows[0];
  assert.deepEqual(left, { sums: 0, st: 0, ids: ['kept only', 'shared co', 'verdict co'] }, 'purged run: no summary, no status; its own identity removed');
  assert.deepEqual(await stored(c, s), await expected(c, s));
  assert.deepEqual(await verify(c, s), []);
  assert.deepEqual((await c.query(GATE)).rows, []); assert.deepEqual((await c.query(AUDIT)).rows, []);
  void K;
  // Purge during maintenance, both orders. (1) A backfill holding the source lock: the purger skips the locked source.
  const Q = await collect(x, s, [AD('q1', 'Queue Co')]);
  await c.query('BEGIN'); await c.query('SET LOCAL session_replication_role = replica');
  await c.query(`UPDATE si.collection_runs SET retain_until = clock_timestamp() - interval '1 minute' WHERE run_id = $1`, [Q]);
  await c.query('COMMIT');
  const owner = await connect({ database: x.db }); t.after(() => owner.end().catch(() => {}));
  await owner.query('BEGIN'); await owner.query('SET LOCAL ROLE si_owner');
  await owner.query('SELECT * FROM si.si_backfill_summaries(10)');            // holds FOR SHARE on the sources it scanned
  await owner.query(`SELECT 1 FROM si.sources WHERE source_id = $1 FOR SHARE`, [s]);
  assert.equal((await x.si_retention.query('SELECT * FROM si.si_purge_due(20)')).rows[0].outcome, 'BUSY', 'purge does not interleave with maintenance');
  await owner.query('COMMIT');
  // (2) A purge holding the source lock while a backfill waits. NOTE (M4-P3.1-ACCEPT-01): Q was published after 0020, so it
  // already has a status and is never a backfill candidate; this checks only that the wait ends cleanly and that nothing
  // is written for Q. The genuine race (an UNBACKFILLED run purged while backfill waits) is CC-MX7 in m4-summaries-close.
  const ret = await connect({ user: 'si_retention', database: x.db }); t.after(() => ret.end().catch(() => {}));
  await ret.query('BEGIN');
  assert.equal((await ret.query('SELECT * FROM si.si_purge_due(20)')).rows[0].outcome, 'PURGED');
  const waiting = asOwnerQ(c, 'SELECT * FROM si.si_backfill_summaries(10)');
  await new Promise(r => setTimeout(r, 300));
  await ret.query('COMMIT');
  const bf = (await waiting)[0];
  assert.deepEqual(bf, { summarized: 0, remaining: 0 }, 'the backfill waits and writes nothing (Q was not a candidate: see CC-MX7)');
  assert.equal((await c.query('SELECT count(*)::int AS n FROM si.run_advertiser_summaries WHERE run_id = $1', [Q])).rows[0].n, 0);
  assert.deepEqual(await verify(c, s), []);
});

// ------------------------------------------------------------------------------------------------
// SUM-M: targeted mutants. Each scenario returns a value; the baseline must give exactly `baseline`, the mutant exactly
// `mutant` (a fixture failure throws and fails the test: it is never counted as a kill).
const SUMMARIZE = latestDefinition('si_summarize_run', 'END $summarize_run$;').text;
const CONTENT = latestDefinition('si_summary_content', '$summary_content$;').text;
const COVERAGE = latestDefinition('si_summary_coverage', '$summary_coverage$;').text;
const BACKFILL = latestDefinition('si_backfill_summaries', 'END $backfill$;').text;
const PURGE_TRG = latestDefinition('trg_runs_purge_summaries', 'END $runs_purge_summaries$;').text;
const CHECK_TRG = latestDefinition('trg_runs_summary_check', 'END $runs_summary_check$;').text;

async function scnPublishMixed(t, sqls = []) {                                // publish a mixed-network run, then compare
  const x = await fresh(t, 'm4summ');
  await asOwner(x.admin, async a => { for (const q of sqls) await a.query(q); });
  const s = await source(x, 'sum-m');
  try { await collect(x, s, [AD('m1', 'Mixed Co'), AD('m2', 'Mixed Co', 'TIKTOK'), AD('m3', 'mixed  co')]); }
  catch (e) { return `refused:${e.message.split(':')[0]}`; }
  const eq = JSON.stringify(await stored(x.admin, s)) === JSON.stringify(await expected(x.admin, s));
  return `published:${eq ? 'equal' : 'DIFFERENT'}:verify=${(await verify(x.admin, s)).length}`;
}
async function scnPartialBackfill(t, sqls = []) {
  const x = await preSummaryDatabase(t, 'm4summ');
  const s = await source(x, 'sum-m');
  for (let k = 0; k < 4; k++) await collect(x, s, [AD(`p${k}`, `Partial ${k}`)]);
  await migrateUp(x.admin, { to: 20 });
  await asOwner(x.admin, async a => { for (const q of sqls) await a.query(q); });
  await asOwnerQ(x.admin, 'SELECT * FROM si.si_backfill_summaries(2)');
  const cov = await coverage(x.admin, s);
  return `eligible=${cov.eligible}:verify=${(await verify(x.admin, s)).join(',') || 'clean'}`;
}
async function scnPurge(t, sqls = []) {
  const x = await fresh(t, 'm4summ');
  await asOwner(x.admin, async a => { for (const q of sqls) await a.query(q); });
  const s = await source(x, 'sum-m');
  const P = await collect(x, s, [AD('pp', 'Only Purged')]);
  await x.admin.query('BEGIN'); await x.admin.query('SET LOCAL session_replication_role = replica');
  await x.admin.query(`UPDATE si.collection_runs SET retain_until = clock_timestamp() - interval '1 minute' WHERE run_id = $1`, [P]);
  await x.admin.query('COMMIT');
  const out = (await x.si_retention.query('SELECT * FROM si.si_purge_due(20)')).rows[0].outcome;
  if (out !== 'PURGED') throw new Error(`fixture: purge outcome ${out}`);
  const r = (await x.admin.query(`SELECT (SELECT count(*) FROM si.run_advertiser_summaries WHERE run_id = $1)::int AS s,
      (SELECT count(*) FROM si.advertiser_identities)::int AS i`, [P])).rows[0];
  return `summaries=${r.s}:identities=${r.i}`;
}
const MUT = [
  { name: 'summary rows missing for one network (self-check intact)', scn: scnPublishMixed, baseline: 'published:equal:verify=0',
    mutant: 'refused:SI_SUMMARY_INCONSISTENT',
    sql: [mutate(SUMMARIZE, "    FROM unnest(content) u\n    CROSS JOIN LATERAL (SELECT e.identity_id FROM si.advertiser_identities e\n                         WHERE e.source_id = src AND e.normalizer = fp AND e.advertiser_key = u.advertiser_key LIMIT 1) i;\n  GET DIAGNOSTICS",
      "    FROM unnest(content) u\n    CROSS JOIN LATERAL (SELECT e.identity_id FROM si.advertiser_identities e\n                         WHERE e.source_id = src AND e.normalizer = fp AND e.advertiser_key = u.advertiser_key LIMIT 1) i\n   WHERE u.network <> 'TIKTOK';\n  GET DIAGNOSTICS")] },
  { name: 'summary rows missing, self-check and commit check removed', scn: scnPublishMixed, baseline: 'published:equal:verify=0',
    mutant: 'published:DIFFERENT:verify=1',   // CONTENT_MISMATCH (the status, derived from the full content, is consistent)
    sql: [mutate(mutate(SUMMARIZE, "    FROM unnest(content) u\n    CROSS JOIN LATERAL (SELECT e.identity_id FROM si.advertiser_identities e\n                         WHERE e.source_id = src AND e.normalizer = fp AND e.advertiser_key = u.advertiser_key LIMIT 1) i;\n  GET DIAGNOSTICS nrows = ROW_COUNT;",
      "    FROM unnest(content) u\n    CROSS JOIN LATERAL (SELECT e.identity_id FROM si.advertiser_identities e\n                         WHERE e.source_id = src AND e.normalizer = fp AND e.advertiser_key = u.advertiser_key LIMIT 1) i\n   WHERE u.network <> 'TIKTOK';\n  GET DIAGNOSTICS nrows = ROW_COUNT;"),
      'IF nrows <> cardinality(content) OR nobs <>', 'IF false AND nobs <>'),
      mutate(CHECK_TRG, '  IF NOT EXISTS (SELECT 1 FROM si.run_summary_status s', '  IF false AND NOT EXISTS (SELECT 1 FROM si.run_summary_status s')] },
  { name: 'incorrect content: names stored normalized (shared derivation; only the independent recomputation sees it)', scn: scnPublishMixed,
    baseline: 'published:equal:verify=0', mutant: 'published:DIFFERENT:verify=0',
    sql: [mutate(CONTENT, 'array_agg(DISTINCT q.advertiser_name COLLATE "C" ORDER BY q.advertiser_name COLLATE "C")',
      'array_agg(DISTINCT q.nn COLLATE "C" ORDER BY q.nn COLLATE "C")')] },
  { name: 'incorrect count: observations + 1', scn: scnPublishMixed, baseline: 'published:equal:verify=0', mutant: 'refused:new row for relation "run_advertiser_summaries" violates check constraint "run_advertiser_summaries_check"',
    sql: [mutate(SUMMARIZE, 'SELECT p_run_id, src, i.identity_id, u.network, u.observations, u.ad_ids, u.names', 'SELECT p_run_id, src, i.identity_id, u.network, u.observations + 1, u.ad_ids, u.names')] },
  { name: 'collision check removed', scn: 'collision', baseline: 'refused:SI_SUMMARY_IDENTITY_COLLISION', mutant: 'published',
    sql: [mutate(SUMMARIZE, '  IF EXISTS (SELECT 1 FROM unnest(content) u\n               CROSS JOIN LATERAL', '  IF false AND EXISTS (SELECT 1 FROM unnest(content) u\n               CROSS JOIN LATERAL')] },
  { name: 'incomplete backfill reported complete (coverage ignores missing runs)', scn: scnPartialBackfill, baseline: 'eligible=false:verify=MISSING:', mutant: 'eligible=true:verify=MISSING:',
    sql: [mutate(COVERAGE, "              THEN 'INCOMPLETE' END], NULL);", "              AND false THEN 'INCOMPLETE' END], NULL);")] },
  { name: 'backfill records status without summary rows', scn: scnPartialBackfill, baseline: 'eligible=false:verify=MISSING:', mutant: 'eligible=false:verify=CONTENT_MISMATCH:',
    sql: [mutate(BACKFILL, "      PERFORM si.si_summarize_run(x.run_id, 'BACKFILL');",
      "      INSERT INTO si.run_summary_status (run_id, source_id, normalizer, observation_count, summary_rows, identities, content_digest, method)\n      SELECT x.run_id, x.source_id, fp, 0, 0, 0, sha256(''::bytea), 'BACKFILL';")] },
  { name: 'purge drift: summaries kept after purge', scn: scnPurge, baseline: 'summaries=0:identities=0', mutant: 'summaries=1:identities=1',
    sql: [mutate(PURGE_TRG, '  WITH d AS (DELETE FROM si.run_advertiser_summaries s WHERE s.run_id = NEW.run_id RETURNING s.identity_id)\n  SELECT array_agg(DISTINCT d.identity_id) INTO ids FROM d;\n  DELETE FROM si.run_summary_status s WHERE s.run_id = NEW.run_id;\n', '')] },
  { name: 'purge drift: identities of the purged run kept', scn: scnPurge, baseline: 'summaries=0:identities=0', mutant: 'summaries=0:identities=1',
    sql: [mutate(PURGE_TRG, '  DELETE FROM si.advertiser_identities i\n   WHERE i.identity_id = ANY (coalesce(ids, \'{}\'))', '  DELETE FROM si.advertiser_identities i\n   WHERE false AND i.identity_id = ANY (coalesce(ids, \'{}\'))')] },
];
for (const m of MUT) {
  test(`SUM-M (${m.name}): baseline exactly its outcome, mutant exactly the defect`, async t => {
    const run = async sql => {
      if (m.scn === 'collision') { const r = await collisionScenario(t, sql?.[0]); return r.outcome; }
      return m.scn(t, sql ?? []);
    };
    const norm = v => v.replace(/verify=([A-Z_]+)(:[0-9a-f]{8})?(,[A-Z_:0-9a-f]+)*/, (_, k) => `verify=${k}:`);
    const base = await run(null), killed = await run(m.sql);
    console.log(`# SUM-M ${m.name}: baseline ${base}, mutant ${killed}`);
    assert.equal(norm(base), m.baseline, 'baseline outcome');
    assert.equal(norm(killed), m.mutant, 'mutant outcome (killed for the stated reason)');
  });
}

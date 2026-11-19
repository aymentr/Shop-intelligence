// B-002 M4-P3.3 Phase 3 (migration 0026, docs §19): content-free operational observability — search-path telemetry,
// failure accounting, verification health, emergency-control latency and the alerting contract. Real disposable
// PostgreSQL 16; the reader is a dedicated si_reader principal; monitoring is the si_monitor login.
// Fixtures a product path cannot perform, labelled where used:
//   - FORCED FALLBACK / TAMPERING: as in m4-summary-search (owner drift event; replica-mode status removal).
//   - EXPIRED INTENT: an OPEN intent's times moved 2 minutes back in replica mode (instead of waiting 60 s).
//   - BROKEN TELEMETRY: the superuser adds CHECK (false) NOT VALID to a telemetry table (a failing telemetry write).
//   - HELD SOURCE LOCK: an admin transaction holds the source row FOR SHARE (like a reader page) for a measured time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { asOwner, cfg, connect, control, createSources, freshDatabase, lift, recordRights, roles, settle, ownerRecovery, schemaFingerprint, waitUntilBlocked, pid } from './helpers.mjs';
import { latestDefinition } from './durability-fixtures.mjs';
import { PAUSE_SQL, armPause, awaitMarkedPause, observeCall, pauseMarker, releasePause } from './barriers.mjs';
import { provisionReaderPrincipal } from '../../dist/persistence/bootstrap.js';
import { fixtureSha256, requestSha256 } from '../../dist/persistence/request-hash.js';
import { grantReader, revokeReader, beginRead } from '../../dist/persistence/reader.js';
import * as INTEL from '../../dist/persistence/intelligence.js';
import { clearDrift, runSweepBatch, startSweep, verifySource } from '../../dist/persistence/summary-verification.js';
import * as OBS from '../../dist/persistence/observability.js';
import { migrateDown, migrateUp } from '../../dist/persistence/migrate.js';

const SEARCH_DEF = latestDefinition('si_search_advertisers', 'END $search$;');
const SEARCH_FN = SEARCH_DEF.text;
const ROLES = ['admin', 'si_rights_admin', 'si_collector', 'si_retention', 'si_monitor'];
const CAP = 200000;
let n = 0;
test.before(async () => { const a = await connect(); try { for (const p of ['si_reader_alice', 'si_reader_bob']) await provisionReaderPrincipal(a, p, cfg.rolePassword); } finally { await a.end(); } });

// ------------------------------------------------------------------------------------------------ fixtures
function mutate(text, from, to) { assert.equal(text.split(from).length, 2, `exactly one anchor: ${from.slice(0, 70)}`); return text.replace(from, () => to); }
async function fresh(t, prefix = 'm4ob') {
  const db = await freshDatabase(t, prefix);
  const x = await roles(t, db, ROLES);
  const extra = [];
  t.after(async () => { for (const e of extra) await e.end().catch(() => {}); });
  Object.defineProperty(x, 'db', { value: db, enumerable: false });
  Object.defineProperty(x, 'connect', { enumerable: false, value: async user => { const k = await connect({ user, database: db }); extra.push(k); return k; } });
  return x;
}
const AD = (name, id, network = 'META', o = {}) => ({ network, nativeAdId: id, advertiserName: name, countries: ['DE'], seenAt: '2026-01-01T00:00:00.000Z',
  sourceUrl: `https://example.test/${encodeURIComponent(id)}`, destinationUrl: 'https://example.test/d', creativeUrl: 'https://example.test/c', title: `Synthetic ${id}`, ...o });
async function source(x, { grant = true, networks = ['META', 'TIKTOK', 'GOOGLE'] } = {}) {
  const src = `ob-${++n}`;
  await createSources(x.admin, [src], networks);
  await recordRights(x.si_rights_admin, src, {});
  if (grant) await grantReader(x.si_rights_admin, 'si_reader_alice', src, 'm4-p3.2 summary-backed search');
  return src;
}
async function collect(x, src, rows, { verify = true, collector = x.si_collector } = {}) {
  const networks = rows.length ? [...new Set(rows.map(r => r.network))].sort() : ['META'];
  const fx = fixtureSha256(rows), sha = requestSha256({ adapterId: src, evidenceKind: 'SYNTHETIC', networks, fixtureSha256: fx });
  const run = (await collector.query('SELECT * FROM si.si_begin_run_scoped($1,$2,$3,$4,$5::text[],$6)', [src, `ss${++n}`, sha, 'SYNTHETIC', networks, fx])).rows[0];
  await collector.query('BEGIN');
  try { await collector.query('SELECT * FROM si.si_complete_run($1::uuid, $2::uuid, $3::jsonb)', [run.run_id, run.lease_token, JSON.stringify(rows)]); await collector.query('COMMIT'); }
  catch (e) { await collector.query('ROLLBACK').catch(() => {}); throw e; }
  if (verify) await x.si_monitor.query('SELECT * FROM si.si_verify_receipts(500)');
  return run.run_id;
}
async function replica(x, sql, params) {
  await x.admin.query('BEGIN');
  try { await x.admin.query('SET LOCAL session_replication_role = replica'); await x.admin.query(sql, params); await x.admin.query('COMMIT'); }
  catch (e) { await x.admin.query('ROLLBACK').catch(() => {}); throw e; }
}
const DAY = 86400000;
const day = k => new Date(Date.UTC(2026, 9, 1) + k * DAY);
const at = (x, runId, d) => replica(x, `UPDATE si.collection_runs SET started_at = $2::timestamptz - interval '1 second', finished_at = $2::timestamptz WHERE run_id = $1`, [runId, d.toISOString()]);
const invalid = (x, run) => replica(x, `INSERT INTO si.receipt_verifications (run_id, source_id, rights_version_id, verdict, reason, commit_xid, commit_ts, window_start, window_end, verified_at, verified_by)
    SELECT r.run_id, r.source_id, r.rights_version_id, 'INVALID', 'COMMITTED_AFTER_WINDOW', 3, r.finished_at, r.finished_at - interval '1 hour', r.finished_at, clock_timestamp(), 'fixture'
      FROM si.collection_runs r WHERE r.run_id = $1`, [run]);
const invalidate = (x, run) => replica(x, `UPDATE si.receipt_verifications SET verdict = 'INVALID', reason = 'COMMITTED_AFTER_WINDOW', window_end = commit_ts WHERE run_id = $1`, [run]);   // a VALID verdict rewritten
const expire = (x, run) => replica(x, `UPDATE si.collection_runs SET retain_until = clock_timestamp() - interval '1 minute' WHERE run_id = $1`, [run]);
const forceFallback = (x, src) => x.admin.query(`INSERT INTO si.summary_events (source_id, kind, finding) VALUES ($1, 'DRIFT_DETECTED', 'MISSING')`, [src]);
const clearFallback = (x, src) => x.admin.query(`INSERT INTO si.summary_events (source_id, kind) VALUES ($1, 'DRIFT_CLEARED')`, [src]);

// ------------------------------------------------------------------------------------------------ the reader, with its path
async function reader(x) {
  const c = await x.connect('si_reader_alice');
  await c.query('SET client_min_messages = debug1');
  c.paths = [];
  c.on('notice', m => { const k = /^SI_READ_PATH (summary|observations)$/.exec(m.message); if (k) c.paths.push(k[1]); });
  return c;
}
const us = d => (d ? d.toISOString().replace(/\.(\d{3})Z$/, '.$1000Z') : null);
const scope = (src, r) => INTEL.intelligenceScope('search', src, [r.q, r.n.join(','), us(r.from), us(r.to), r.after, String(r.incl)]);
/** One audited request through the SQL function (fresh intent; bounded retry on INTENT_NOT_DURABLE only). */
async function search(alice, src, r) {
  for (let attempt = 0; ; attempt++) {
    const before = alice.paths.length;
    let id;
    try { id = await beginRead(alice, src, { cursor: scope(src, r), limit: r.limit }); }
    catch (e) { return { out: `BEGIN:${e.code ?? e.message}` }; }
    const res = await settle(alice.query('SELECT si.si_search_advertisers($1, $2, $3, $4::text[], $5, $6, $7, $8, $9) AS doc',
      [src, id, r.q, r.n, r.from, r.to, r.after, r.incl, r.limit]));
    if (res.status !== 'ok' && /^SI_READ_INTENT_NOT_DURABLE/.test(String(res.message)) && attempt < 3) continue;
    const path = alice.paths.slice(before).at(-1) ?? null;
    if (res.status !== 'ok') return { out: String(res.message).match(/^SI_[A-Z_]+/)?.[0] ?? `SQLSTATE:${res.code}`, path };
    const d = res.value.rows[0].doc;
    return { out: 'ok', doc: { source_id: d.source_id, normalized_query: d.normalized_query, hits: d.hits, has_more: d.has_more }, path };
  }
}
const R = (q, o = {}) => ({ q, n: [], from: null, to: null, after: null, incl: false, limit: 50, ...o });

// ------------------------------------------------------------------------------------------------ the independent oracle
const utf8cmp = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
/** Raw observations of the source in runs readable by si_evidence_readable (optionally only `runs`), normalized by the DB. */
async function observations(x, src, runs = null) {
  return (await x.admin.query(`SELECT o.run_id, o.network, o.native_ad_id, o.advertiser_name, si.si_normalize_advertiser(o.advertiser_name) AS nn,
                                      r.finished_at, si.si_intelligence_iso(r.finished_at) AS fin
                                 FROM si.observations o JOIN si.collection_runs r ON r.run_id = o.run_id
                                WHERE o.source_id = $1 AND r.status = 'COMPLETED' AND r.retention_state = 'RETAINED' AND r.published_count > 0
                                  AND ($2::uuid[] IS NULL OR r.run_id = ANY ($2::uuid[]))
                                  AND si.si_evidence_readable(r.run_id)`, [src, runs])).rows;
}
async function oracle(x, src, r, obs = null, cap = CAP) {
  const q = (await x.admin.query('SELECT si.si_normalize_advertiser($1) AS q', [r.q])).rows[0].q;
  obs ??= await observations(x, src);
  const cand = obs.filter(o => (!r.from || (o.finished_at >= r.from && o.finished_at < r.to)) && (r.n.length === 0 || r.n.includes(o.network)) && o.nn.includes(q));
  if (cand.length > cap) return { out: 'SI_READ_SCAN_LIMIT' };
  const g = new Map();
  for (const o of cand) {
    const e = g.get(o.nn) ?? { nn: o.nn, obs: 0, ads: new Set(), runs: new Set(), fins: [], nets: new Set(), names: new Set() };
    e.obs++; e.ads.add(`${o.network}\u0000${o.native_ad_id}`); e.runs.add(o.run_id); e.fins.push(o.fin); e.nets.add(o.network); e.names.add(o.advertiser_name);
    g.set(o.nn, e);
  }
  const groups = [...g.values()].filter(e => r.after === null || utf8cmp(e.nn, r.after) > 0 || (r.incl && e.nn === r.after)).sort((a, b) => utf8cmp(a.nn, b.nn));
  const page = groups.slice(0, r.limit).map(e => {
    const names = [...e.names].sort(utf8cmp), fins = e.fins.sort();
    return { normalized_name: e.nn, names: names.slice(0, 10), names_truncated: names.length > 10, observations: e.obs, distinct_ads: e.ads.size,
             runs_with_evidence: e.runs.size, first_observed_at: fins[0], last_observed_at: fins.at(-1), networks: [...e.nets].sort(utf8cmp) };
  });
  return { out: 'ok', doc: { source_id: src, normalized_query: q, hits: page, has_more: groups.length > r.limit } };
}
/** Follows every page (exclusive cursor) and returns the per-page results. */
async function pages(alice, src, r, max = 200) {
  const out = [];
  for (let req = { ...r }, i = 0; i < max; i++) {
    const s = await search(alice, src, req);
    out.push({ req: { ...req }, ...s });
    if (s.out !== 'ok' || !s.doc.has_more) break;
    req = { ...req, after: s.doc.hits.at(-1).normalized_name, incl: false };
  }
  return out;
}

async function small(x) {
  const s = await source(x);
  const runs = [];
  runs.push(await collect(x, s, [AD('Northwind Synthetic', 'f1'), AD('Contoso Ltd', 'f2', 'TIKTOK')]));
  runs.push(await collect(x, s, [AD('Northwind Synthetic', 'f1'), AD('Northwind Synthetic Labs', 'f3')]));
  runs.push(await collect(x, s, [AD('Contoso Ltd.', 'f4'), AD('Northwind Synthetic', 'f5')]));
  for (const [i, r] of runs.entries()) await at(x, r, new Date(day(1 + 2 * i).getTime()));
  return { s, runs };
}
const both = async (x, alice, s, r, path) => assert.deepEqual(await search(alice, s, r), { ...(await oracle(x, s, r)), path }, `${path} ${JSON.stringify(r)}`);


const events = async x => (await x.admin.query('SELECT * FROM si.read_path_events ORDER BY recorded_at, intent_id')).rows;
const failuresOf = async x => (await x.admin.query('SELECT * FROM si.read_failures ORDER BY recorded_at')).rows;
const accessFor = async (x, intent) => (await x.admin.query('SELECT count(*)::int AS n FROM si.reader_access_log WHERE intent_id = $1', [intent])).rows[0].n;
const lastEvent = async x => (await events(x)).at(-1);
const statusOf = async (x, s, kind = 'search') => (await OBS.readPathStatus(x.si_monitor)).find(r => r.sourceId === s && r.requestKind === kind);
const alertsOf = async (x, t = {}) => (await OBS.operationalAlerts(x.si_monitor, t)).map(a => `${a.alert}:${a.sourceId ?? '-'}`);
const SECRETS = ['north', 'Northwind', 'contoso', 'Contoso', 'example.test', 'Synthetic f', 'Forged'];
function noContent(label, value) {
  const j = JSON.stringify(value);
  for (const s of SECRETS) assert.ok(!j.includes(s), `${label} must not contain ${JSON.stringify(s)}`);
}

// ------------------------------------------------------------------------------------------------ OB-0 the active functions
test('OB-0: the active read functions are 0026 and only ADD lines to their predecessors (0023 search, 0018 history)', () => {
  assert.equal(SEARCH_DEF.file, '0026_operational_observability.up.sql');
  const hist = latestDefinition('si_advertiser_history', 'END $history$;');
  assert.equal(hist.file, '0026_operational_observability.up.sql');
  const prevS = latestDefinition('si_search_advertisers', 'END $search$;', { before: '0026' }).text;
  const prevH = latestDefinition('si_advertiser_history', 'END $history$;', { before: '0026' }).text;
  for (const [a, b] of [[prevS, SEARCH_FN], [prevH, hist.text]]) {
    const A = a.split('\n'), B = b.split('\n'); let i = 0;
    for (const l of B) if (i < A.length && l === A[i]) i++;
    assert.equal(i, A.length, 'the previous text is a subsequence (lines only added)');
    assert.ok(B.length - A.length <= 8, `few lines added (${B.length - A.length})`);
  }
});

// ------------------------------------------------------------------------------------------------ OB-1..4 path classification
test('OB-1: summary path: one content-free event per successful search, after (and coupled to) its audit; response = the independent oracle', async t => {
  const x = await fresh(t);
  const { s } = await small(x);
  const alice = await reader(x);
  await both(x, alice, s, R('north'), 'summary');
  const e = await lastEvent(x);
  assert.deepEqual([e.request_kind, e.path, e.fallback_reason, e.principal, e.source_id], ['search', 'summary', null, 'si_reader_alice', s]);
  assert.ok(Number(e.duration_us) > 0);
  assert.equal(await accessFor(x, e.intent_id), 1, 'the event and the access log row belong to the same consumed intent');
  assert.equal((await x.admin.query('SELECT state FROM si.read_intents WHERE intent_id = $1', [e.intent_id])).rows[0].state, 'CONSUMED');
  noContent('read_path_events', await events(x));
});

test('OB-2: exact fallback reasons: DRIFT, INCOMPLETE, DRIFT,INCOMPLETE; answers stay exact; recovery returns to the summary path', async t => {
  const x = await fresh(t);
  const { s, runs } = await small(x);
  const alice = await reader(x);
  await forceFallback(x, s);                                                     // FORCED FALLBACK
  await both(x, alice, s, R('north'), 'observations');
  assert.deepEqual([(await lastEvent(x)).path, (await lastEvent(x)).fallback_reason], ['observations', 'DRIFT']);
  await replica(x, 'DELETE FROM si.run_advertiser_summaries WHERE run_id = $1', [runs[2]]);   // TAMPERING: a run unsummarized
  await replica(x, 'DELETE FROM si.run_summary_status WHERE run_id = $1', [runs[2]]);
  await both(x, alice, s, R('north'), 'observations');
  assert.equal((await lastEvent(x)).fallback_reason, 'DRIFT,INCOMPLETE');
  await clearFallback(x, s);
  await both(x, alice, s, R('north'), 'observations');
  assert.equal((await lastEvent(x)).fallback_reason, 'INCOMPLETE');
  await asOwner(x.admin, a => a.query('SELECT * FROM si.si_backfill_summaries(100)'));
  await both(x, alice, s, R('north'), 'summary');
  assert.equal((await lastEvent(x)).fallback_reason, null);
  const st = await statusOf(x, s);
  assert.deepEqual([st.requests, st.summaryPath, st.observationPath, st.fallback.drift, st.fallback.incomplete, st.fallback.guard], [4, 1, 3, 2, 2, 0]);
});

test('OB-3: GUARD: eligible at the coverage check, drift committed before the page statement (deterministic pause): observation path, reason GUARD', async t => {
  const x = await fresh(t);
  const { s } = await small(x);
  const expected = await oracle(x, s, R('north'));
  await asOwner(x.admin, a => a.query(mutate(SEARCH_FN, '    IF cov.eligible IS TRUE THEN\n', PAUSE_SQL.replace(/^/gm, '  ') + '    IF cov.eligible IS TRUE THEN\n')));
  const alice = await reader(x), holder = await x.connect(undefined);
  const alicePid = (await alice.query('SELECT pg_backend_pid() AS p')).rows[0].p;
  const p = pauseMarker(); await armPause(holder, alice, p);
  const pending = search(alice, s, R('north'));
  await awaitMarkedPause(x.admin, alicePid, p.mark);
  await forceFallback(x, s);                                                     // commits while the reader is between coverage and page
  await releasePause(holder, p);
  assert.deepEqual(await pending, { ...expected, path: 'observations' });
  assert.deepEqual([(await lastEvent(x)).path, (await lastEvent(x)).fallback_reason], ['observations', 'GUARD']);
});

test('OB-4: history requests are classified (kind history, observation path, NOT_APPLICABLE) through the library', async t => {
  const x = await fresh(t);
  const { s } = await small(x);
  const alice = await x.connect('si_reader_alice');
  const h = await INTEL.advertiserHistory(alice, s, 'Northwind Synthetic');
  assert.ok(h.observations.length > 0);
  const e = await lastEvent(x);
  assert.deepEqual([e.request_kind, e.path, e.fallback_reason], ['history', 'observations', 'NOT_APPLICABLE']);
  assert.equal((await statusOf(x, s, 'history')).fallback.notApplicable, 1);
});

// ------------------------------------------------------------------------------------------------ OB-5..8 failures and audit
test('OB-5: failed requests: no path event (rolled back with the read); the client-reported code for the own OPEN intent; expired OPEN intents counted server-side', async t => {
  const x = await fresh(t);
  const { s } = await small(x);
  const alice = await x.connect('si_reader_alice');
  await control(x.si_rights_admin, s, 'SUSPEND');
  await assert.rejects(INTEL.searchAdvertisers(alice, { sources: [s], query: 'north' }), e => e.code === 'SOURCE_UNAVAILABLE');
  await assert.rejects(INTEL.advertiserHistory(alice, s, 'Northwind Synthetic'), e => e.code === 'SOURCE_UNAVAILABLE');
  assert.equal((await events(x)).length, 0, 'a failed read leaves no path event');
  const f = await failuresOf(x);
  assert.deepEqual(f.map(z => [z.request_kind, z.code, z.principal, z.source_id]), [['search', 'SOURCE_UNAVAILABLE', 'si_reader_alice', s], ['history', 'SOURCE_UNAVAILABLE', 'si_reader_alice', s]]);
  for (const z of f) assert.equal((await x.admin.query('SELECT state FROM si.read_intents WHERE intent_id = $1', [z.intent_id])).rows[0].state, 'OPEN');
  await replica(x, `UPDATE si.read_intents SET created_at = created_at - interval '2 minutes', expires_at = expires_at - interval '2 minutes' WHERE state = 'OPEN'`);   // EXPIRED INTENT
  const st = await statusOf(x, s);
  assert.deepEqual([st.requests, st.failuresReported, st.failureCodes, st.intentsExpiredOpen], [0, 1, { SOURCE_UNAVAILABLE: 1 }, 2], 'expired OPEN intents are per source (intents carry no request kind): the search and the history');
  await lift(x.si_rights_admin, s);
  await INTEL.searchAdvertisers(alice, { sources: [s], query: 'north' });
  assert.equal((await statusOf(x, s)).requests, 1, 'the successful request after LIFT is counted');
});

test('OB-6: the failure label is bounded: own OPEN intent only, fixed codes, once; never a consumed intent or another principal\'s; no other role may call it', async t => {
  const x = await fresh(t);
  const { s } = await small(x);
  await grantReader(x.si_rights_admin, 'si_reader_bob', s, 'm4-p3.3 observability');
  const alice = await x.connect('si_reader_alice'), bob = await x.connect('si_reader_bob');
  const mine = await beginRead(alice, s, { cursor: scope(s, R('north')), limit: 50 });
  const theirs = await beginRead(bob, s, { cursor: scope(s, R('north')), limit: 50 });
  const rec = async (c, id, code = 'BUSY', kind = 'search') => (await c.query('SELECT si.si_record_read_failure($1, $2, $3) AS r', [id, kind, code])).rows[0].r;
  assert.equal(await rec(alice, theirs), false, 'another principal\'s intent: nothing recorded');
  assert.equal(await rec(alice, mine), true);
  assert.equal(await rec(alice, mine, 'INTERNAL'), false, 'once per intent');
  await assert.rejects(rec(alice, mine, 'Northwind Synthetic'), /SI_BAD_ARGUMENT/, 'a free-text code is refused');
  await assert.rejects(rec(alice, mine, 'BUSY', 'evidence'), /SI_BAD_ARGUMENT/);
  await both(x, await reader(x), s, R('north'), 'summary');
  const consumed = (await lastEvent(x)).intent_id;
  assert.equal(await rec(alice, consumed), false, 'a consumed (successful) intent cannot be labelled failed');
  for (const role of ['si_monitor', 'si_collector', 'si_rights_admin', 'si_retention'])
    await assert.rejects(x[role].query('SELECT si.si_record_read_failure($1, $2, $3)', [mine, 'search', 'BUSY']), e => e.code === '42501', role);
  assert.deepEqual((await failuresOf(x)).map(z => [z.intent_id, z.code]), [[mine, 'BUSY']]);
});

test('OB-7: audit coupling: a request whose audit fails (intent already used) records no event; events and access-log rows are 1:1 by intent', async t => {
  const x = await fresh(t);
  const { s } = await small(x);
  const alice = await reader(x);
  const r = R('north');
  const id = await beginRead(alice, s, { cursor: scope(s, r), limit: r.limit });
  const call = () => alice.query('SELECT si.si_search_advertisers($1, $2, $3, $4::text[], $5, $6, $7, $8, $9) AS doc', [s, id, r.q, r.n, r.from, r.to, r.after, r.incl, r.limit]);
  await call();
  await assert.rejects(call(), /SI_READ_INTENT_USED/);
  for (let i = 0; i < 3; i++) await both(x, alice, s, R('north'), 'summary');
  const ev = await events(x);
  assert.equal(ev.length, 4);
  const log = (await x.admin.query('SELECT intent_id FROM si.reader_access_log ORDER BY access_id')).rows.map(z => z.intent_id);
  assert.deepEqual(ev.map(e => e.intent_id).sort(), log.slice().sort(), 'exactly the audited requests');
});

test('OB-8: telemetry never fails a read or an emergency control: with every telemetry write failing (BROKEN TELEMETRY) both succeed, the audit is complete, a warning is raised', async t => {
  const x = await fresh(t);
  const { s } = await small(x);
  await x.admin.query('ALTER TABLE si.read_path_events ADD CONSTRAINT broken CHECK (false) NOT VALID');
  await x.admin.query('ALTER TABLE si.source_control_timings ADD CONSTRAINT broken CHECK (false) NOT VALID');
  const alice = await reader(x); const warnings = [];
  alice.on('notice', m => { if (/^SI_TELEMETRY_LOST/.test(m.message)) warnings.push(m.message); });
  await both(x, alice, s, R('north'), 'summary');
  assert.equal((await events(x)).length, 0); assert.equal(warnings.length, 1);
  assert.equal((await x.admin.query('SELECT count(*)::int AS n FROM si.reader_access_log')).rows[0].n, 1, 'the audit is complete');
  const ctl = await settle(control(x.si_rights_admin, s, 'SUSPEND'));
  assert.equal(ctl.status, 'ok', JSON.stringify(ctl));
  assert.equal((await x.admin.query('SELECT count(*)::int AS n FROM si.source_control_timings')).rows[0].n, 0);
  assert.equal((await x.admin.query(`SELECT count(*)::int AS n FROM si.source_controls WHERE source_id = $1 AND kind = 'SUSPEND'`, [s])).rows[0].n, 1);
});

// ------------------------------------------------------------------------------------------------ OB-9 equivalence
test('OB-9: response and pagination are unchanged: paged searches with networks, periods and inclusive cursors equal the oracle on both paths', async t => {
  const x = await fresh(t);
  const { s } = await small(x);
  const alice = await reader(x);
  const reqs = [R('north', { limit: 1 }), R('n', { limit: 2 }), R('co', { n: ['META'] }), R('north', { from: day(0), to: day(4) }), R('north', { after: 'northwind synthetic', incl: true })];
  for (const path of ['summary', 'observations']) {
    if (path === 'observations') await forceFallback(x, s);
    for (const r of reqs) {
      const got = await pages(alice, s, r);
      for (const g of got) assert.deepEqual({ out: g.out, doc: g.doc, path: g.path }, { ...(await oracle(x, s, g.req)), path }, `${path} ${JSON.stringify(g.req)}`);
    }
  }
});

// ------------------------------------------------------------------------------------------------ OB-10 verification health
test('OB-10: verification health: never verified, clean, active progress, drift, rebuild, BUSY failures, stale, clearance; and the matching alerts', async t => {
  const x = await fresh(t);
  const { s, runs } = await small(x);
  const H = async () => (await OBS.verificationHealth(x.si_monitor)).find(h => h.sourceId === s);
  let h = await H();
  assert.deepEqual([h.lastCleanCompletedAt, h.active, h.driftOpen], [null, null, false]);
  assert.ok((await alertsOf(x)).includes(`VERIFICATION_OVERDUE:${s}`), 'never verified = overdue');
  const c1 = await verifySource(x.si_monitor, s);
  h = await H();
  assert.equal(h.lastCleanSweepId, c1.sweepId); assert.ok(h.secondsSinceClean >= 0 && h.secondsSinceClean < 60);
  assert.ok(!(await alertsOf(x)).includes(`VERIFICATION_OVERDUE:${s}`));
  assert.ok((await alertsOf(x, { maxCleanAgeSeconds: 1 })).length >= 0);
  // active sweep progress and BUSY
  const st = await startSweep(x.si_monitor, s);
  await runSweepBatch(x.si_monitor, st.sweepId, 1, { maxRuns: 1, maxObservations: 500, maxIdentities: 1 });
  const v = await x.connect('si_monitor');
  await v.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  await v.query('SELECT * FROM si.si_summary_sweep_batch($1, 2, 1, 500, 1)', [st.sweepId]);
  for (let i = 0; i < 3; i++) await assert.rejects(runSweepBatch(x.si_monitor, st.sweepId, 2, { maxRuns: 1, maxObservations: 500, maxIdentities: 1 }), e => e.code === 'BUSY');
  await v.query('ROLLBACK');
  h = await H();
  assert.deepEqual([h.active.sweepId, h.active.phase, h.active.runsDone, h.active.scopeRuns, h.recentBusy, h.active.failuresSinceLastBatch], [st.sweepId, 'RUNS', 1, 3, 3, 3]);
  assert.ok((await alertsOf(x, { failureMax: 3 })).includes(`VERIFICATION_FAILING:${s}`));
  assert.ok(!(await alertsOf(x, { failureMax: 4 })).includes(`VERIFICATION_FAILING:${s}`), 'boundary: 3 failures < 4');
  // stale: the active sweep abandoned
  await replica(x, `UPDATE si.summary_sweeps SET last_batch_at = clock_timestamp() - interval '1 hour', started_at = clock_timestamp() - interval '1 hour' WHERE sweep_id = $1`, [st.sweepId]);
  await x.si_monitor.query(`SELECT si.si_summary_sweep_expire(interval '5 minutes')`);
  h = await H();
  assert.deepEqual([h.active, h.latestTerminalState, h.latestStaleReason], [null, 'STALE', 'ABANDONED']);
  assert.ok((await alertsOf(x)).includes(`VERIFICATION_STALLED:${s}`));
  // drift, rebuild, clearance
  await replica(x, 'UPDATE si.run_summary_status SET observation_count = observation_count + 1 WHERE run_id = $1', [runs[0]]);   // TAMPERING
  assert.equal((await verifySource(x.si_monitor, s)).state, 'COMPLETED_DRIFT');
  h = await H();
  assert.equal(h.driftOpen, true); assert.ok(h.driftDetectedAt);
  assert.ok((await alertsOf(x)).includes(`DRIFT_OPEN:${s}`));
  await asOwner(x.admin, a => a.query('SELECT si.si_rebuild_run_summaries($1)', [runs[0]]));
  h = await H(); assert.equal(h.rebuildsSinceDrift, 1); assert.ok(h.lastRebuildAt);
  const c2 = await verifySource(x.si_monitor, s);
  await clearDrift(x.admin, s, c2.sweepId);
  h = await H();
  assert.deepEqual([h.driftOpen, h.lastClearanceSweepId, h.rebuildsSinceDrift, h.lastCleanSweepId], [false, c2.sweepId, 0, c2.sweepId]);
  assert.ok(!(await alertsOf(x)).some(a => a.endsWith(`:${s}`) && /DRIFT_OPEN|VERIFICATION_STALLED|VERIFICATION_OVERDUE/.test(a)));
  noContent('verification health', await OBS.verificationHealth(x.si_monitor));
});

// ------------------------------------------------------------------------------------------------ OB-11 emergency controls
test('OB-11: emergency-control lock waits: measured per committed control, live waiters visible with their blockers; deadline alerts at the configured budget', async t => {
  const x = await fresh(t);
  const { s } = await small(x);
  const quick = await settle(control(x.si_rights_admin, s, 'SUSPEND'));
  assert.equal(quick.status, 'ok');
  const h = await x.connect(undefined); const hp = await pid(h);
  await h.query('BEGIN'); await h.query('SELECT 1 FROM si.sources WHERE source_id = $1 FOR SHARE', [s]);   // HELD SOURCE LOCK
  const rp = await pid(x.si_rights_admin);
  const pending = settle(lift(x.si_rights_admin, s));
  await waitUntilBlocked(x.admin, rp, hp);
  await sleep(700);
  const live = (await OBS.controlLockWaits(x.si_monitor)).find(w => w.waiterPid === rp);
  assert.ok(live, 'the waiting control is visible');
  assert.deepEqual([live.waiterRole, live.onSources, live.blockerPids.includes(hp)], ['si_rights_admin', true, true]);
  assert.ok(live.waitMs >= 600, `live wait ${live.waitMs}`);
  assert.ok((await alertsOf(x, { controlBudgetMs: 500 })).includes('CONTROL_WAITING:-'));
  assert.ok(!(await alertsOf(x, { controlBudgetMs: 5000 })).includes('CONTROL_WAITING:-'));
  await sleep(500);
  await h.query('COMMIT');
  assert.equal((await pending).status, 'ok');
  const lat = await OBS.controlLatency(x.si_monitor, 86400, 1000);
  const sus = lat.find(l => l.sourceId === s && l.kind === 'SUSPEND'), lif = lat.find(l => l.sourceId === s && l.kind === 'LIFT');
  console.log(`# OB-11 SUSPEND wait ${sus.maxWaitMs} ms (uncontended); LIFT wait ${lif.maxWaitMs} ms (held ~1.2 s by a FOR SHARE holder)`);
  assert.ok(sus.maxWaitMs < 200); assert.ok(lif.maxWaitMs >= 1100 && lif.maxWaitMs < 3000); assert.equal(lif.overBudget, 1);
  assert.ok((await alertsOf(x, { controlBudgetMs: 1000 })).includes(`CONTROL_DEADLINE_BREACH:${s}`));
  assert.ok(!(await alertsOf(x, { controlBudgetMs: 5000 })).includes(`CONTROL_DEADLINE_BREACH:${s}`));
  noContent('control telemetry', await x.admin.query('SELECT * FROM si.source_control_timings').then(r => r.rows));
});

test('OB-11b: a REFUSED control (lock_timeout while a holder keeps the source): visible live while it waits, not in the committed timings, counted by its client report; CONTROL_REFUSED alert', async t => {
  const x = await fresh(t);
  const { s } = await small(x);
  const h = await x.connect(undefined); const hp = await pid(h);
  await h.query('BEGIN'); await h.query('SELECT 1 FROM si.sources WHERE source_id = $1 FOR SHARE', [s]);   // HELD SOURCE LOCK
  const ra = await x.connect('si_rights_admin'); const rp = await pid(ra);
  await ra.query(`SET lock_timeout = '1500ms'`);                                     // a control client with a short deadline
  const pending = settle(control(ra, s, 'SUSPEND'));
  await waitUntilBlocked(x.admin, rp, hp);
  const live = (await OBS.controlLockWaits(x.si_monitor)).find(w => w.waiterPid === rp);
  assert.deepEqual([live?.waiterRole, live?.onSources], ['si_rights_admin', true]);
  const r = await pending;
  assert.equal(r.code, '55P03', JSON.stringify(r));
  const code = await OBS.recordControlFailure(ra, s, 'SUSPEND', Object.assign(new Error(r.message), { code: r.code }));
  assert.equal(code, 'LOCK_TIMEOUT');
  await h.query('ROLLBACK');
  const lat = (await OBS.controlLatency(x.si_monitor)).find(l => l.sourceId === s && l.kind === 'SUSPEND');
  assert.deepEqual([lat.controls, lat.refused, lat.refusalCodes], [0, 1, { LOCK_TIMEOUT: 1 }]);
  assert.ok((await alertsOf(x)).includes(`CONTROL_REFUSED:${s}`));
  for (const role of ['si_monitor', 'si_collector', 'si_retention'])
    await assert.rejects(x[role].query(`SELECT si.si_record_control_failure($1, 'SUSPEND', 'LOCK_TIMEOUT')`, [s]), e => e.code === '42501', role);
  await assert.rejects(ra.query(`SELECT si.si_record_control_failure($1, 'SUSPEND', 'emergency text')`, [s]), /SI_BAD_ARGUMENT/);
});

// ------------------------------------------------------------------------------------------------ OB-12 alert thresholds
test('OB-12: persistent fallback and reader latency alerts fire exactly at their thresholds (>= ratio and minimum count; p95 > bound)', async t => {
  const x = await fresh(t);
  const { s } = await small(x);
  const alice = await reader(x);
  await both(x, alice, s, R('north'), 'summary');
  await forceFallback(x, s);
  for (let i = 0; i < 3; i++) await both(x, alice, s, R('north'), 'observations');          // 3 of 4 on the observation path
  const has = async (t, code) => (await alertsOf(x, t)).includes(`${code}:${s}`);
  assert.equal(await has({ fallbackMinRequests: 4, fallbackRatio: 0.75 }, 'PERSISTENT_FALLBACK'), true, '3/4 >= 0.75');
  assert.equal(await has({ fallbackMinRequests: 4, fallbackRatio: 0.76 }, 'PERSISTENT_FALLBACK'), false);
  assert.equal(await has({ fallbackMinRequests: 5, fallbackRatio: 0.5 }, 'PERSISTENT_FALLBACK'), false, 'below the minimum request count');
  const p95 = (await statusOf(x, s)).p95Ms;
  assert.equal(await has({ readerMinRequests: 4, readerP95Ms: Math.max(0, p95 - 0.001) }, 'READER_LATENCY'), true);
  assert.equal(await has({ readerMinRequests: 4, readerP95Ms: p95 }, 'READER_LATENCY'), false, 'p95 equal to the bound does not fire');
  assert.equal(await has({ readerMinRequests: 5, readerP95Ms: 0 }, 'READER_LATENCY'), false);
  await assert.rejects(OBS.operationalAlerts(x.si_monitor, { fallbackRatio: 1.5 }), /OBSERVABILITY_BAD_ARGUMENT/);
});

// ------------------------------------------------------------------------------------------------ OB-13..15 security, content, lifecycle
test('OB-13: least privilege: only si_monitor reads monitoring; nobody but the owner reads or writes telemetry tables; si_monitor cannot record events', async t => {
  const x = await fresh(t);
  const alice = await x.connect('si_reader_alice');
  const calls = ['SELECT * FROM si.si_read_path_status()', 'SELECT * FROM si.si_verification_health()', 'SELECT * FROM si.si_control_latency_status()',
                 'SELECT * FROM si.si_control_lock_waits()', 'SELECT * FROM si.si_operational_alerts()'];
  for (const [label, c] of [['reader', alice], ['si_collector', x.si_collector], ['si_rights_admin', x.si_rights_admin], ['si_retention', x.si_retention]])
    for (const q of calls) await assert.rejects(c.query(q), e => e.code === '42501', `${label}: ${q}`);
  for (const q of calls) await x.si_monitor.query(q);
  for (const t of ['read_path_events', 'read_failures', 'source_control_timings', 'source_control_failures'])
    for (const [label, c] of [['si_monitor', x.si_monitor], ['reader', alice], ['si_collector', x.si_collector]]) {
      await assert.rejects(c.query(`SELECT * FROM si.${t}`), e => e.code === '42501', `${label} SELECT ${t}`);
      await assert.rejects(c.query(`DELETE FROM si.${t}`), e => e.code === '42501', `${label} DELETE ${t}`);
    }
  await assert.rejects(x.si_monitor.query(`SELECT si.si_record_read_path('search', 'si_reader_alice', 'x-src', gen_random_uuid(), 'summary', NULL, now())`), e => e.code === '42501');
  await asOwner(x.admin, a => a.query(`INSERT INTO si.read_path_events (intent_id, request_kind, principal, source_id, path, fallback_reason, duration_us) VALUES (gen_random_uuid(), 'search', 'si_reader_alice', 'x-src', 'summary', NULL, 1)`));
  await assert.rejects(asOwner(x.admin, a => a.query('DELETE FROM si.read_path_events')), /SI_TELEMETRY_APPEND_ONLY/);
  await assert.rejects(asOwner(x.admin, a => a.query(`UPDATE si.read_path_events SET path = 'observations', fallback_reason = 'GUARD'`)), /SI_TELEMETRY_APPEND_ONLY/);
  await assert.rejects(asOwner(x.admin, a => a.query('TRUNCATE si.source_control_timings')), /SI_TELEMETRY_APPEND_ONLY/);
});

test('OB-14: no sensitive content anywhere: every telemetry row and every monitoring output is free of query terms, names, URLs and ad content', async t => {
  const x = await fresh(t);
  const { s } = await small(x);
  const alice = await reader(x);
  await both(x, alice, s, R('northwind synthetic labs'), 'summary');
  await INTEL.advertiserHistory(await x.connect('si_reader_alice'), s, 'Contoso Ltd');
  await control(x.si_rights_admin, s, 'SUSPEND');
  await assert.rejects(INTEL.searchAdvertisers(await x.connect('si_reader_alice'), { sources: [s], query: 'Northwind' }));
  for (const t of ['read_path_events', 'read_failures', 'source_control_timings', 'source_control_failures']) noContent(t, (await x.admin.query(`SELECT * FROM si.${t}`)).rows);
  noContent('ops status', [await OBS.readPathStatus(x.si_monitor), await OBS.verificationHealth(x.si_monitor), await OBS.controlLatency(x.si_monitor), await OBS.operationalAlerts(x.si_monitor)]);
  const cols = (await x.admin.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'si' AND table_name IN ('read_path_events', 'read_failures', 'source_control_timings', 'source_control_failures') ORDER BY 1, 2`)).rows.map(r => `${r.table_name}.${r.column_name}`);
  assert.ok(!cols.some(c => /query|name|url|title|reason_text|term/.test(c.split('.')[1]) && !/fallback_reason/.test(c)), cols.join(','));
});

test('OB-15: lifecycle interactions: a purge leaves telemetry intact and the path summary; a revoked grant fails NOT_AUTHORIZED with no event', async t => {
  const x = await fresh(t);
  const { s, runs } = await small(x);
  const alice = await reader(x);
  await both(x, alice, s, R('north'), 'summary');
  await expire(x, runs[1]);
  assert.equal((await x.si_retention.query('SELECT * FROM si.si_purge_due(20)')).rows[0].outcome, 'PURGED');
  await both(x, alice, s, R('north'), 'summary');
  assert.deepEqual((await events(x)).map(e => e.path), ['summary', 'summary'], 'telemetry is not evidence: the purge keeps it');
  await revokeReader(x.si_rights_admin, 'si_reader_alice', s, 'm4-p3.3 observability test');
  const r = await search(alice, s, R('north'));
  assert.notEqual(r.out, 'ok');
  assert.equal((await events(x)).length, 2);
});

test('OB-16: 0026 down restores the exact 0025 catalog; up re-applies identically', async t => {
  const x = await fresh(t);
  const v26 = await schemaFingerprint(x.admin);
  const ref = await freshDatabase(t, 'm4ob25', { migrate: false });
  const r = await roles(t, ref, ['admin']);
  await migrateUp(r.admin, { to: 25 });
  assert.deepEqual(await migrateDown(x.admin, { to: 25, allowDestructive: true }), [26]);
  assert.deepEqual(await schemaFingerprint(x.admin), await schemaFingerprint(r.admin));
  assert.deepEqual(await migrateUp(x.admin), [26]);
  assert.deepEqual(await schemaFingerprint(x.admin), v26);
});

test('OB-17: emergency-control latency matrix, measured by the 0026 telemetry itself: uncontended, an open clean sweep batch, an idle verifier after a sweep start, a reader page held 1 s (purge: RT-13)', async t => {
  const x = await fresh(t);
  const { s, runs } = await small(x);
  const waits = async () => (await x.admin.query('SELECT wait_ms FROM si.source_control_timings WHERE source_id = $1 ORDER BY control_event_id DESC LIMIT 1', [s])).rows[0].wait_ms;
  const pair = async () => { await control(x.si_rights_admin, s, 'SUSPEND'); const a = Number(await waits()); await lift(x.si_rights_admin, s); return a; };
  const out = {};
  const u = []; for (let i = 0; i < 10; i++) u.push(await pair());
  out.uncontended_max = Math.max(...u);
  // an open (uncommitted) clean sweep batch: no source lock
  const st = await startSweep(x.si_monitor, s);
  const v = await x.connect('si_monitor');
  await v.query('BEGIN ISOLATION LEVEL REPEATABLE READ'); await v.query('SELECT * FROM si.si_summary_sweep_batch($1, 1, 1, 500, 1)', [st.sweepId]);
  out.clean_batch_open = await pair();
  await v.query('COMMIT');
  // an idle verifier right after a sweep start (KEY SHARE on the source; terminated at the 2 s idle bound)
  const w = await x.connect('si_monitor'); w.on('error', () => {});
  const s2 = await source(x); await collect(x, s2, [AD('Idle Co', 'i1')]);
  await w.query('BEGIN'); await w.query('SELECT * FROM si.si_summary_sweep_start($1)', [s2]);
  await control(x.si_rights_admin, s2, 'SUSPEND');
  out.idle_verifier = Number((await x.admin.query('SELECT wait_ms FROM si.source_control_timings WHERE source_id = $1', [s2])).rows[0].wait_ms);
  // a reader page held 1 s inside the search (FOR SHARE on the source), by the deterministic pause
  await asOwner(x.admin, a => a.query(mutate(SEARCH_FN, '    IF cov.eligible IS TRUE THEN\n', PAUSE_SQL.replace(/^/gm, '  ') + '    IF cov.eligible IS TRUE THEN\n')));
  const alice = await reader(x), holder = await x.connect(undefined);
  const ap = (await alice.query('SELECT pg_backend_pid() AS p')).rows[0].p;
  const p = pauseMarker(); await armPause(holder, alice, p);
  const pending = search(alice, s, R('north'));
  await awaitMarkedPause(x.admin, ap, p.mark);
  const c = settle(control(x.si_rights_admin, s, 'SUSPEND'));
  await sleep(1000); await releasePause(holder, p); await pending; await c;
  out.reader_page_held_1s = Number(await waits());
  await lift(x.si_rights_admin, s);
  console.log(`# OB-17 control lock wait (ms, from si.source_control_timings): ${JSON.stringify(Object.fromEntries(Object.entries(out).map(([k, z]) => [k, Number(z.toFixed(1))])))}`);
  assert.ok(out.uncontended_max < 100 && out.clean_batch_open < 100);
  assert.ok(out.idle_verifier >= 1800 && out.idle_verifier < 5000, 'bounded by the 2 s si_monitor idle timeout');
  assert.ok(out.reader_page_held_1s >= 900 && out.reader_page_held_1s < 5000);
});

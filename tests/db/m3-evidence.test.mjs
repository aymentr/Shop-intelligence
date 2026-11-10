// B-002 Milestone 3 part 2B (migration 0005): atomic evidence persistence. Real disposable PostgreSQL,
// synthetic sources only. Server-log canaries read SI_TEST_SERVER_LOG (a file) or, by default,
// `docker compose logs db`; they FAIL (never skip) when the log cannot be read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { asOwner, cfg, connect, control, createSources, expectWaiterOk, freshDatabase, holderCommit, pid, recordRights, rejects, roles,
         waitUntilBlocked, waiter } from './helpers.mjs';
import { fixtureSha256, requestSha256 } from '../../dist/persistence/request-hash.js';
import { completeRunWithEvidence, T2Refused } from '../../dist/persistence/runs.js';
import { checkCollectorLogging } from '../../dist/persistence/preconditions.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const MIGRATION = readFileSync(new URL('../../db/migrations/0005_evidence.up.sql', import.meta.url), 'utf8');
const CHECK = '23514';
const cleanups = [];
const scope = { after: fn => cleanups.push(fn) };
let db, c, n = 0;
test.before(async () => {
  db = await freshDatabase(scope, 'm3evid');
  c = await roles(scope, db, ['admin', 'si_rights_admin', 'si_collector']);
});
test.after(async () => { for (const fn of cleanups.reverse()) await fn(); });

const canary = () => `CANARY${randomBytes(8).toString('hex')}`;
const ROW = (id, x = {}) => ({ network: 'META', nativeAdId: id, advertiserName: 'Synthetic Co', countries: ['DE', 'FR'],
  seenAt: '2026-01-01T00:00:00.000Z', sourceUrl: 'https://example.test/a', ...x });
async function source({ networks = ['META', 'TIKTOK'], policy, rights = {} } = {}) {
  const id = `ev-${++n}`;
  await createSources(c.admin, [id], networks);
  if (policy) await c.si_rights_admin.query('UPDATE si.sources SET conflict_policy = $2 WHERE source_id = $1', [id, policy]);
  await recordRights(c.si_rights_admin, id, rights);
  return id;
}
async function scoped(src, rows, networks = ['META'], x = c.si_collector) {
  const fx = fixtureSha256(rows), key = `ek${++n}`;
  const sha = requestSha256({ adapterId: src, evidenceKind: 'SYNTHETIC', networks, fixtureSha256: fx });
  const r = (await x.query('SELECT * FROM si.si_begin_run_scoped($1,$2,$3,$4,$5::text[],$6)', [src, key, sha, 'SYNTHETIC', networks, fx])).rows[0];
  assert.equal(r.outcome, 'RUNNING');
  return r;
}
const plain = async src => (await c.si_collector.query("SELECT * FROM si.si_begin_run($1,$2,repeat('a',64),'SYNTHETIC','{META}')", [src, `el${++n}`])).rows[0];
const T2 = 'SELECT * FROM si.si_complete_run($1::uuid, $2::uuid, $3::jsonb)';
async function rawT2(run, rows, x = c.si_collector) {
  await x.query('BEGIN');
  try { const r = (await x.query(T2, [run.run_id, run.lease_token, JSON.stringify(rows)])).rows[0]; await x.query('COMMIT'); return r; }
  catch (e) { await x.query('ROLLBACK').catch(() => {}); throw e; }
}
const state = async id => (await c.admin.query(`SELECT r.status, r.outcome_code, r.retention_state, r.retain_until, r.finished_at,
   r.received_count, r.published_count, r.duplicate_count, r.conflict_count, r.suppressed_count, r.error_count,
   (SELECT count(*)::int FROM si.observations o WHERE o.run_id = r.run_id) AS obs,
   (SELECT count(*)::int FROM si.publication_receipts p WHERE p.run_id = r.run_id) AS receipts
   FROM si.collection_runs r WHERE r.run_id = $1`, [id])).rows[0];
const adsNamed = async ids => (await c.admin.query('SELECT count(*)::int AS n FROM si.ads WHERE native_ad_id = ANY ($1)', [ids])).rows[0].n;
async function untouched(run) {
  const s = await state(run.run_id);
  assert.deepEqual([s.status, s.obs, s.receipts], ['RUNNING', 0, 0], 'nothing written');
}
async function refused(p, code, first) {
  const e = await rejects(assert, p, { code: CHECK });
  assert.match(e.message, new RegExp(`^SI_T2_${code}:`));
  if (first) assert.equal(JSON.parse(e.detail).e[0].c, first);
  return e;
}
function serverLog() {
  if (process.env.SI_TEST_SERVER_LOG) return readFileSync(process.env.SI_TEST_SERVER_LOG, 'utf8');
  const r = spawnSync('docker', ['compose', 'logs', '--no-color', 'db'], { cwd: REPO, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  if (r.status !== 0) throw new Error('cannot read the PostgreSQL server log: set SI_TEST_SERVER_LOG or run the compose database');
  return `${r.stdout}${r.stderr}`;
}
async function unsafeSession(settings) {
  const udb = await freshDatabase(scope, 'm3unsafe');
  const adm = await connect({ database: udb }); cleanups.push(() => adm.end());
  for (const [k, v] of Object.entries(settings)) await adm.query(`ALTER ROLE si_collector IN DATABASE ${udb} SET ${k} = '${v}'`);
  const u = await roles(scope, udb, ['admin', 'si_rights_admin', 'si_collector']);
  await createSources(u.admin, ['ev-unsafe']); await recordRights(u.si_rights_admin, 'ev-unsafe');
  return { udb, u };
}

// ------------------------------------------------------------------------------------------------
test('EV-1 (P1): scoped runs must submit exactly their bound fixture, including EMPTY', async () => {
  const src = await source();
  const rows = [ROW('p1-a'), ROW('p1-b', { network: 'TIKTOK' })];
  const ok = await scoped(src, rows, ['META', 'TIKTOK']);
  const r = await rawT2(ok, rows);
  assert.deepEqual([r.outcome, r.retention_state, r.received_count, r.published_count, r.duplicate_count, r.conflict_count],
    ['COMPLETED', 'RETAINED', 2, 2, 0, 0]);
  const s = await state(ok.run_id);
  assert.deepEqual([s.obs, s.receipts, s.suppressed_count], [2, 1, 0]);
  const lying = await scoped(src, [ROW('p1-c')]);
  for (const sub of [[], [ROW('p1-d')], [ROW('p1-c'), ROW('p1-c')], [ROW('p1-c', { title: 'x' })]]) {
    await refused(rawT2(lying, sub), 'VALIDATION_FAILED', 'REQUEST_HASH_MISMATCH');
  }
  await untouched(lying);
  const honestEmpty = await scoped(src, []);
  assert.equal((await rawT2(honestEmpty, [])).retention_state, 'EMPTY');
});

test('EV-2 (P2/P3): legacy unscoped runs stay EMPTY-only; non-empty requires a scope', async () => {
  const run = await plain(await source());
  await refused(rawT2(run, [ROW('p2')]), 'VALIDATION_FAILED', 'REQUEST_SCOPE_MISSING');
  await untouched(run);
  assert.equal(await adsNamed(['p2']), 0);
  assert.equal((await rawT2(run, [])).retention_state, 'EMPTY');
});

test('EV-3 (P4): every network must be valid and authorized by the bound scope and the current source', async () => {
  const src = await source();
  const rows = [ROW('p4-a'), ROW('p4-b', { network: 'TIKTOK' })];
  const narrow = await scoped(src, rows, ['META']);
  await refused(rawT2(narrow, rows), 'VALIDATION_FAILED', 'NETWORK_NOT_AUTHORIZED');
  await untouched(narrow);
  const src2 = await source();
  const later = await scoped(src2, rows, ['META', 'TIKTOK']);
  await asOwner(c.admin, x => x.query(`UPDATE si.sources SET supported_networks = '{META}' WHERE source_id = $1`, [src2]));
  await refused(rawT2(later, rows), 'VALIDATION_FAILED', 'NETWORK_NOT_AUTHORIZED');
  await untouched(later);
  const bogus = [ROW('p4-c', { network: 'MYSPACE' })];
  await refused(rawT2(await scoped(src, bogus), bogus), 'VALIDATION_FAILED', 'INVALID_NETWORK');
});

test('EV-4 (P5): any invalid record refuses the whole batch with a coded, bounded, value-free diagnostic', async () => {
  const src = await source();
  const marker = canary();
  const cases = [
    [{ network: 'META', marker }, 'INVALID_NATIVE_AD_ID'], [ROW(' lead'), 'INVALID_NATIVE_AD_ID'],
    [ROW('x', { advertiserName: '' }), 'INVALID_TEXT'], [ROW('x', { advertiserName: `${marker} ` }), 'INVALID_TEXT'],
    [ROW('x', { advertiserName: marker.repeat(70) }), 'INVALID_TEXT'], [ROW('x', { title: null }), 'INVALID_TEXT'],
    [ROW('x', { countries: ['FR', 'DE'] }), 'INVALID_COUNTRIES'], [ROW('x', { countries: ['FR', 'FR'] }), 'INVALID_COUNTRIES'],
    [ROW('x', { countries: ['fr'] }), 'INVALID_COUNTRIES'], [ROW('x', { countries: [] }), 'INVALID_COUNTRIES'],
    [ROW('x', { seenAt: '2026-02-30T00:00:00.000Z' }), 'INVALID_TIMESTAMP'], [ROW('x', { seenAt: '2026-01-01T00:00:00Z' }), 'INVALID_TIMESTAMP'],
    [ROW('x', { seenAt: '2026-01-01T00:00:00.000+01:00' }), 'INVALID_TIMESTAMP'],
    [ROW('x', { sourceUrl: `javascript:${marker}` }), 'INVALID_URL'], [ROW('x', { sourceUrl: `https://u:p@${marker}.test/` }), 'INVALID_URL'],
    [ROW('x', { sourceUrl: `https://e.test/${marker.repeat(130)}` }), 'INVALID_URL'],
    [ROW('x', { sourceReportedFirstSeen: '2026-02-01T00:00:00.000Z', sourceReportedLastSeen: '2026-01-01T00:00:00.000Z' }), 'SEEN_ORDER'],
    ['not an object', 'INVALID_SHAPE']];
  for (const [row, code] of cases) {
    const rows = [ROW('valid-first'), row];
    const run = await scoped(src, rows);
    const e = await refused(rawT2(run, rows), 'VALIDATION_FAILED');
    const d = JSON.parse(e.detail);
    assert.deepEqual([d.v, d.n, d.e.length, d.e[0].c, d.e[0].r], [1, 1, 1, code, 1], `${code}: whole batch refused, row 1 named`);
    assert.ok(!e.detail.includes(marker) && !e.message.includes(marker) && !e.detail.includes('Synthetic'), 'no payload values');
    await untouched(run);
    assert.equal(await adsNamed(['valid-first']), 0, 'the valid row of a refused batch is not stored either');
  }
  // a number cannot be reproduced by the v1 SQL hash: the scoped run fails closed at the earlier scope check
  const numeric = [ROW('valid-first'), ROW('x', { score: 1 })];
  const nr = await scoped(src, numeric);
  await refused(rawT2(nr, numeric), 'VALIDATION_FAILED', 'REQUEST_HASH_MISMATCH');
  await untouched(nr);
  const many = Array.from({ length: 500 }, (_, i) => ROW(String(i), { network: 'NOPE' }));
  const e = await refused(rawT2(await scoped(src, many), many), 'VALIDATION_FAILED', 'INVALID_NETWORK');
  const d = JSON.parse(e.detail);
  assert.deepEqual([d.n, d.e.length, e.detail.length <= 8192], [500, 100, true], `bounded (${e.detail.length} bytes)`);
});

test('EV-5 (P6): deterministic counts — KEEP_FIRST keeps the lowest ordinal; FAIL_RUN refuses conflicts', async () => {
  const rows = [ROW('k1'), ROW('k1'), ROW('k1', { title: 'changed' }), ROW('k2'), ROW('k2', { seenAt: '2026-01-02T00:00:00.000Z' })];
  const keep = await source({ policy: 'KEEP_FIRST' });
  const run = await scoped(keep, rows);
  const r = await rawT2(run, rows);
  assert.deepEqual([r.received_count, r.published_count, r.duplicate_count, r.conflict_count], [5, 2, 3, 1],
    'R=5 U=2 D=3 C=1; a later seenAt alone is not a conflict');
  const kept = (await c.admin.query('SELECT ordinal, native_ad_id, title FROM si.observations WHERE run_id = $1 ORDER BY ordinal', [run.run_id])).rows;
  assert.deepEqual(kept.map(k => [k.ordinal, k.native_ad_id, k.title]), [[0, 'k1', null], [3, 'k2', null]], 'lowest ordinal kept');
  const s = await state(run.run_id);
  assert.deepEqual([s.received_count, s.published_count, s.duplicate_count, s.conflict_count, s.suppressed_count, s.obs],
    [5, 2, 3, 1, 0, 2]);
  const fail = await source();                                                     // default policy FAIL_RUN
  const fr = await scoped(fail, rows);
  const e = await refused(rawT2(fr, rows), 'DUPLICATE_CONFLICT', 'DUPLICATE_CONFLICT');
  assert.deepEqual(JSON.parse(e.detail).e.map(x => x.r), [2]);
  await untouched(fr);
  const dupOnly = [ROW('d1'), ROW('d1')];
  const dr = await rawT2(await scoped(fail, dupOnly), dupOnly);
  assert.deepEqual([dr.received_count, dr.published_count, dr.duplicate_count, dr.conflict_count], [2, 1, 1, 0], 'identical duplicates pass FAIL_RUN');
});

test('EV-6 (P7): every failure leaves no partial ads, observations, receipts or completion (COMMIT refusal, connection loss, owner)', async () => {
  const src = await source();
  const rows = [ROW('late-1'), ROW('late-2')];
  const run = await scoped(src, rows);
  await recordRights(c.si_rights_admin, src, { effective_from_sql: `clock_timestamp() + interval '61500 milliseconds'` });
  const x = await connect({ user: 'si_collector', database: db }); cleanups.push(() => x.end());
  await x.query('BEGIN');
  assert.equal((await x.query(T2, [run.run_id, run.lease_token, JSON.stringify(rows)])).rows[0].published_count, 2);
  await sleep(2000);
  await rejects(assert, x.query('COMMIT'), { code: CHECK, message: /^SI_T2_RIGHTS_EXPIRING/ });
  await untouched(run);
  assert.equal(await adsNamed(['late-1', 'late-2']), 0);
  const rows2 = [ROW('kill-1')];
  const run2 = await scoped(await source(), rows2);
  const y = await connect({ user: 'si_collector', database: db });
  const ypid = await pid(y);
  await y.query('BEGIN');
  await y.query(T2, [run2.run_id, run2.lease_token, JSON.stringify(rows2)]);
  await c.admin.query('SELECT pg_terminate_backend($1)', [ypid]);
  await y.end().catch(() => {});
  await sleep(300);
  await untouched(run2);
  assert.equal(await adsNamed(['kill-1']), 0);
  await rejects(assert, asOwner(c.admin, z => z.query(`INSERT INTO si.ads (source_id, network, native_ad_id, first_run_id) VALUES ($1, 'META', 'orphan', gen_random_uuid())`, [src])),
    { code: CHECK, message: /^SI_AD_WITHOUT_OBSERVATION/ });
});

test('EV-7 (P8): no content is returned; no application role can read or write evidence; owner cannot alter it', async () => {
  const args = (await c.admin.query(`SELECT proargnames FROM pg_proc WHERE proname = 'si_complete_run'`)).rows[0].proargnames;
  assert.deepEqual(args.filter(a => !a.startsWith('p_')), ['outcome', 'run_id', 'retention_state', 'publish_control_seq', 'finished_at',
    'received_count', 'published_count', 'duplicate_count', 'conflict_count']);
  const content = ['advertiser_name', 'native_ad_id', 'source_url', 'title', 'destination_url', 'creative_url', 'countries', 'seen_at'];
  assert.deepEqual((await c.admin.query(`SELECT proname FROM pg_proc WHERE pronamespace = 'si'::regnamespace
     AND proargnames && $1::text[]`, [content])).rows, [], 'no si routine takes or returns content columns');
  for (const role of ['si_collector', 'si_rights_admin', 'si_retention', 'si_monitor']) {
    for (const t of ['si.ads', 'si.observations']) for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      assert.equal((await c.admin.query('SELECT has_table_privilege($1, $2, $3) AS h', [role, t, p])).rows[0].h, false, `${role} ${p} ${t}`);
    }
    assert.equal((await c.admin.query(`SELECT has_type_privilege($1, 'si.t2_stage_row', 'USAGE') AS h`, [role])).rows[0].h, false);
  }
  await rejects(assert, c.si_collector.query('SELECT * FROM si.observations'), { code: '42501' });
  const rows = [ROW('imm-1')];
  const run = await scoped(await source(), rows);
  await rawT2(run, rows);
  for (const sql of [`UPDATE si.observations SET title = 'x' WHERE run_id = '${run.run_id}'`, `DELETE FROM si.observations WHERE run_id = '${run.run_id}'`,
                     `UPDATE si.ads SET native_ad_id = 'x' WHERE native_ad_id = 'imm-1'`, `DELETE FROM si.ads WHERE native_ad_id = 'imm-1'`,
                     'TRUNCATE si.observations', 'TRUNCATE si.ads CASCADE']) {
    await rejects(assert, asOwner(c.admin, x => x.query(sql)), { code: CHECK, message: /^SI_EVIDENCE_IMMUTABLE/ });
  }
  const cat = (await c.admin.query(`SELECT proname, prosecdef, proconfig FROM pg_proc WHERE pronamespace = 'si'::regnamespace
     AND proname IN ('si_complete_run', 'si_t2_row_error', 'si_t2_fingerprint', 'trg_evidence_append_only', 'trg_observation_run_completed',
                     'trg_ad_has_observation', 'trg_runs_publish_check') ORDER BY 1`)).rows;
  assert.deepEqual(cat.map(f => [f.proname, f.prosecdef]), [['si_complete_run', true], ['si_t2_fingerprint', false], ['si_t2_row_error', false],
    ['trg_ad_has_observation', true], ['trg_evidence_append_only', false], ['trg_observation_run_completed', true], ['trg_runs_publish_check', true]]);
  for (const f of cat) assert.deepEqual(f.proconfig, ['search_path=pg_catalog, pg_temp'], f.proname);
  for (const f of ['trg_ad_has_observation', 'trg_observation_run_completed', 'trg_runs_publish_check']) {
    const src = (await c.admin.query('SELECT prosrc FROM pg_proc WHERE proname = $1', [f])).rows[0].prosrc;
    assert.doesNotMatch(src, /\m(INSERT|UPDATE|DELETE|TRUNCATE|MERGE)\M/i, `${f} is read-only`);
  }
});

test('EV-8: static retention metadata — retain_until = least(finished_at + retention_days, rights retention end)', async () => {
  const days = await source();
  const r1 = [ROW('ret-1')];
  const a = await scoped(days, r1); await rawT2(a, r1);
  const s1 = await state(a.run_id);
  assert.equal(s1.retain_until.getTime() - s1.finished_at.getTime(), 30 * 86400000, 'retention_days = 30 from finished_at');
  const exp = await source({ rights: { expires_at_sql: `clock_timestamp() + interval '1 day'` } });
  const b = await scoped(exp, r1); await rawT2(b, r1);
  const s2 = await state(b.run_id);
  const expiry = (await c.admin.query('SELECT expires_at FROM si.rights_versions WHERE source_id = $1', [exp])).rows[0].expires_at;
  assert.equal(s2.retain_until.getTime(), expiry.getTime(), 'capped by the rights retention end (version expiry)');
});

test('EV-9 (O1, D7): logging preconditions — checked in the effective collector session; unsafe sessions never transmit', async () => {
  assert.ok((await checkCollectorLogging(c.si_collector)).every(p => p.ok), 'bootstrap makes collector sessions safe');
  assert.deepEqual((await checkCollectorLogging(c.admin)).filter(p => !p.ok).map(p => p.name),
    ['collector_session', 'log_parameter_max_length'], 'an admin session is not a collector session (on_error defaults to 0)');
  const { udb, u } = await unsafeSession({ log_parameter_max_length: '-1' });
  assert.deepEqual((await checkCollectorLogging(u.si_collector)).filter(p => !p.ok).map(p => p.name), ['log_parameter_max_length']);
  const rows = [ROW('unsafe-1')];
  const fx = fixtureSha256(rows);
  const sha = requestSha256({ adapterId: 'ev-unsafe', evidenceKind: 'SYNTHETIC', networks: ['META'], fixtureSha256: fx });
  const run = (await u.si_collector.query('SELECT * FROM si.si_begin_run_scoped($1,$2,$3,$4,$5::text[],$6)', ['ev-unsafe', 'k', sha, 'SYNTHETIC', ['META'], fx])).rows[0];
  const sent = [];
  const spy = { query: (sql, params) => { sent.push(sql.trim().split(/\s+/).slice(0, 3).join(' ')); return u.si_collector.query(sql, params); } };
  const err = await rejects(assert, completeRunWithEvidence(spy, run.run_id, run.lease_token, rows));
  assert.ok(err instanceof T2Refused && err.code === 'UNSAFE_LOGGING');
  assert.equal(sent.length, 1, 'only the settings check was sent; no payload, no BEGIN');
  await rejects(assert, u.si_collector.query(T2, [run.run_id, run.lease_token, JSON.stringify(rows)]),
    { code: '55000', message: /^SI_UNSAFE_LOGGING/ });                                      // secondary tripwire
  assert.equal((await u.si_collector.query(T2, [run.run_id, run.lease_token, '[]']).catch(e => e)).message.startsWith('SI_T2_VALIDATION_FAILED'), true,
    'the empty payload is unaffected by the tripwire (and still bound to the fixture)');
  // D7 CLI
  const url = (user, d) => `postgresql://${user}:${encodeURIComponent(user === cfg.adminUser ? cfg.adminPassword : cfg.rolePassword)}@${cfg.host}:${cfg.port}/${d}`;
  const cli = d => spawnSync(process.execPath, ['dist/persistence/cli.js', 'preflight', '--collector'], { cwd: REPO, encoding: 'utf8',
    env: { ...process.env, SI_PRODUCTION: '', SI_DATABASE_URL: url(cfg.adminUser, d), SI_COLLECTOR_DATABASE_URL: url('si_collector', d) } });
  const okRun = cli(db), badRun = cli(udb);
  assert.equal(okRun.status, 0, okRun.stdout + okRun.stderr);
  assert.match(okRun.stdout, /ok {3}log_parameter_max_length: 0/);
  assert.equal(badRun.status, 1, badRun.stdout + badRun.stderr);
  assert.match(badRun.stdout, /FAIL log_parameter_max_length: -1/);
});

test('EV-10 (library): safe non-empty completion, coded diagnostics through T3, and pre-transmission refusals', async () => {
  const keep = await source({ policy: 'KEEP_FIRST' });
  const rows = [ROW('lib-1'), ROW('lib-1'), ROW('lib-2')];
  const run = await scoped(keep, rows);
  const ok = await completeRunWithEvidence(c.si_collector, run.run_id, run.lease_token, rows);
  assert.deepEqual([ok.outcome, ok.retentionState, ok.counts], ['COMPLETED', 'RETAINED', { received: 3, published: 2, duplicate: 1, conflict: 0 }]);
  const bad = [ROW('lib-3'), ROW('lib-4', { seenAt: 'yesterday' }), ROW('lib-5', { sourceUrl: 'ftp://x' })];
  const br = await scoped(keep, bad);
  const f = await completeRunWithEvidence(c.si_collector, br.run_id, br.lease_token, bad);
  assert.deepEqual([f.outcome, f.code, f.failRecorded], ['FAILED', 'VALIDATION_FAILED', true]);
  assert.deepEqual(f.diagnostics, { errorCount: 2, records: [{ code: 'INVALID_TIMESTAMP', rowIndex: 1, field: 'seenAt' },
                                                              { code: 'INVALID_URL', rowIndex: 2, field: 'sourceUrl' }] });
  const stored = (await c.admin.query('SELECT code, row_index, field FROM si.run_errors WHERE run_id = $1 ORDER BY seq', [br.run_id])).rows;
  assert.deepEqual(stored.map(x => [x.code, x.row_index, x.field]), [['INVALID_TIMESTAMP', 1, 'seenAt'], ['INVALID_URL', 2, 'sourceUrl']]);
  const conf = [ROW('lib-6'), ROW('lib-6', { title: 'other' })];
  const cr = await scoped(await source(), conf);
  const cf = await completeRunWithEvidence(c.si_collector, cr.run_id, cr.lease_token, conf);
  assert.deepEqual([cf.outcome, cf.code, cf.diagnostics?.records[0]?.code], ['FAILED', 'DUPLICATE_CONFLICT', 'DUPLICATE_CONFLICT']);
  assert.deepEqual(await completeRunWithEvidence(c.si_collector, cr.run_id, '00000000-0000-0000-0000-000000000000', conf), { outcome: 'NOT_OWNER' });
  // refused before any statement is sent
  const sent = [];
  const spy = { query: (sql, params) => { sent.push(sql); return c.si_collector.query(sql, params); } };
  for (const [payload, code] of [[[ROW('a\u0000b')], 'UNSAFE_PAYLOAD'], [[ROW('\ud800x')], 'UNSAFE_PAYLOAD'], [[ROW('x', { title: undefined })], 'UNSAFE_PAYLOAD'],
                                 [[ROW('x', { n: NaN })], 'UNSAFE_PAYLOAD'], [[{ [`k\u0000`]: 'v' }], 'UNSAFE_PAYLOAD'],
                                 [Array.from({ length: 501 }, (_, i) => ROW(String(i))), 'BAD_ARGUMENT'],
                                 [[ROW('x', { title: 'y'.repeat(1100000) })], 'BAD_ARGUMENT']]) {
    const e = await rejects(assert, completeRunWithEvidence(spy, run.run_id, run.lease_token, payload));
    assert.ok(e instanceof T2Refused && e.code === code, `${code}: ${e.message}`);
  }
  assert.deepEqual(sent, [], 'nothing reached the database');
});

test('EV-11 (canaries): no evidence value reaches the server log or the application log in protected sessions', async () => {
  const before = serverLog();
  const marks = [];
  const out = [];
  const saved = {};
  for (const m of ['log', 'info', 'warn', 'error', 'debug']) { saved[m] = console[m]; console[m] = (...a) => out.push(a.map(String).join(' ')); }
  const results = [];
  try {
    const keep = await source({ policy: 'KEEP_FIRST' }), fail = await source();
    const mk = () => { const m = canary(); marks.push(m); return m; };
    const t = mk(); const good = [ROW('cg-1', { title: t, advertiserName: mk() })];
    const g = await scoped(keep, good); results.push(await completeRunWithEvidence(c.si_collector, g.run_id, g.lease_token, good));
    const inval = [ROW('cg-2', { title: mk() }), ROW('cg-3', { seenAt: mk(), sourceUrl: `https://e.test/${mk()}` }), ROW(mk(), { network: mk() })];
    const iv = await scoped(keep, inval); results.push(await completeRunWithEvidence(c.si_collector, iv.run_id, iv.lease_token, inval));
    const longs = [ROW('cg-4', { advertiserName: mk().repeat(70) }), ROW('cg-5', { title: mk().repeat(70) }), ROW('cg-6', { sourceUrl: `https://e.test/${mk().repeat(130)}` })];
    const lv = await scoped(keep, longs); results.push(await completeRunWithEvidence(c.si_collector, lv.run_id, lv.lease_token, longs));
    const conf = [ROW('cg-7', { title: mk() }), ROW('cg-7', { title: mk() })];
    const cr = await scoped(fail, conf); results.push(await completeRunWithEvidence(c.si_collector, cr.run_id, cr.lease_token, conf));
    const hm = await scoped(keep, [ROW('cg-8')]); results.push(await completeRunWithEvidence(c.si_collector, hm.run_id, hm.lease_token, [ROW('cg-8', { title: mk() })]));
    const lg = await plain(keep); results.push(await completeRunWithEvidence(c.si_collector, lg.run_id, lg.lease_token, [ROW('cg-9', { title: mk() })]));
    try { await completeRunWithEvidence(c.si_collector, lg.run_id, lg.lease_token, [ROW(`${mk()}\u0000`)]); } catch (e) { results.push(e); }
    const big = Array.from({ length: 501 }, () => ROW('cg-10', { title: marks[0] }));
    results.push(await c.si_collector.query(T2, [lg.run_id, lg.lease_token, JSON.stringify(big)]).catch(e => e));   // DB cap refusal
  } finally { for (const m of Object.keys(saved)) console[m] = saved[m]; }
  await sleep(1000);
  const after = serverLog().slice(before.length > 0 ? Math.max(0, before.length - 200) : 0);
  const appText = out.join('\n') + JSON.stringify(results, (k, v) => (v instanceof Error ? { ...v, message: v.message, stack: v.stack } : v));
  for (const m of marks) {
    assert.equal(after.includes(m), false, `server log contains canary ${m}`);
    assert.equal(appText.includes(m), false, `application output contains canary ${m}`);
  }
  assert.equal(marks.length >= 14, true);
  assert.doesNotMatch(readFileSync(new URL('../../src/persistence/runs.ts', import.meta.url), 'utf8'), /console\./, 'the library never logs');
});

test('EV-12 (canary sensitivity control): with parameter logging enabled the raw path DOES leak — the detector works', async () => {
  const { u } = await unsafeSession({ log_parameter_max_length: '-1', log_statement: 'all' });
  const m = canary();
  const before = serverLog().length;
  await u.si_collector.query(T2, ['00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000',
    JSON.stringify([ROW('s-1', { title: m })])]).catch(() => {});
  await sleep(1000);
  assert.equal(serverLog().slice(Math.max(0, before - 200)).includes(m), true,
    'the canary must appear when parameter logging is on; otherwise the log reader is blind and EV-11 proves nothing');
});

test('EV-13 (O3): concurrent completions with overlapping identities in opposite order serialize without deadlock', async () => {
  const src = await source({ policy: 'KEEP_FIRST' });
  const rowsA = [ROW('ov-1'), ROW('ov-2')], rowsB = [ROW('ov-2'), ROW('ov-1')];
  const runA = await scoped(src, rowsA), runB = await scoped(src, rowsB);
  const sa = await connect({ user: 'si_collector', database: db }), sb = await connect({ user: 'si_collector', database: db });
  cleanups.push(() => sa.end(), () => sb.end());
  const pa = await pid(sa), pb = await pid(sb);
  await sa.query('BEGIN'); await sa.query(T2, [runA.run_id, runA.lease_token, JSON.stringify(rowsA)]);
  await sb.query('BEGIN');
  const pending = waiter(sb.query(T2, [runB.run_id, runB.lease_token, JSON.stringify(rowsB)]));
  await waitUntilBlocked(c.admin, pb, pa);
  await holderCommit(assert, sa, pa);
  await expectWaiterOk(assert, pending);
  await holderCommit(assert, sb, pb);
  assert.equal(await adsNamed(['ov-1', 'ov-2']), 2);
  assert.equal((await c.admin.query(`SELECT count(*)::int AS n FROM si.observations WHERE native_ad_id IN ('ov-1','ov-2')`)).rows[0].n, 4);
});

test('EV-14 (O4, targeted mutant): payload-order identity inserts deadlock under a forced interleaving; the sorted order does not', async () => {
  const start = MIGRATION.indexOf('CREATE OR REPLACE FUNCTION si.si_complete_run');
  const fn = MIGRATION.slice(start, MIGRATION.indexOf('END $run_complete$;', start) + 'END $run_complete$;'.length);
  const anchor = 'FOR a IN SELECT DISTINCT t.net COLLATE "C" AS net, t.nid COLLATE "C" AS nid FROM unnest(rws) t ORDER BY 1, 2 LOOP';
  assert.equal(fn.split(anchor).length, 2, 'exactly one anchor');
  const pause = `PERFORM pg_sleep(coalesce(nullif(current_setting('si.test_pause', true), ''), '0')::float8);`;
  const variants = {
    sorted: fn.replace(anchor, `${anchor} ${pause}`),
    unsorted: fn.replace(anchor, `FOR a IN SELECT t.net, t.nid FROM unnest(rws) t GROUP BY t.net, t.nid ORDER BY min(t.ordinal) LOOP ${pause}`)
  };
  const outcomes = {};
  for (const [name, body] of Object.entries(variants)) {
    const mdb = await freshDatabase(scope, 'm3mut');
    const m = await roles(scope, mdb, ['admin', 'si_rights_admin', 'si_collector']);
    await asOwner(m.admin, x => x.query(body));
    await createSources(m.admin, ['ev-mut']); await recordRights(m.si_rights_admin, 'ev-mut');
    await m.si_rights_admin.query(`UPDATE si.sources SET conflict_policy = 'KEEP_FIRST' WHERE source_id = 'ev-mut'`);
    const rowsA = [ROW('m-1'), ROW('m-2')], rowsB = [ROW('m-2'), ROW('m-1')];
    const ra = await scoped('ev-mut', rowsA, ['META'], m.si_collector), rb = await scoped('ev-mut', rowsB, ['META'], m.si_collector);
    const sa = await connect({ user: 'si_collector', database: mdb }), sb = await connect({ user: 'si_collector', database: mdb });
    cleanups.push(() => sa.end(), () => sb.end());
    for (const s of [sa, sb]) { await s.query(`SET si.test_pause = '1'`); await s.query('BEGIN'); }
    const call = (s, r, rows) => s.query(T2, [r.run_id, r.lease_token, JSON.stringify(rows)]).then(() => 'ok', e => e.code);
    outcomes[name] = await Promise.all([call(sa, ra, rowsA), call(sb, rb, rowsB)]);
    for (const s of [sa, sb]) await s.query('ROLLBACK').catch(() => {});
  }
  assert.deepEqual(outcomes.sorted, ['ok', 'ok'], 'sorted inserts: no deadlock');
  assert.ok(outcomes.unsorted.includes('40P01'), `unsorted inserts deadlock (mutant killed): ${JSON.stringify(outcomes.unsorted)}`);
});

test('EV-15 (gates): 500-row / 1 MiB cap — T2 timing, and SUSPEND / TERMINATE against a maximum-size completion', async () => {
  const keep = await source({ policy: 'KEEP_FIRST' });
  const atCap = i => Array.from({ length: 500 }, (_, k) => ROW(`cap${i}-${k}`, { title: 't'.repeat(900) }));
  const bytes = Buffer.byteLength(JSON.stringify(atCap(0)));
  const ms = [];
  for (let i = 0; i < 10; i++) {
    const rows = atCap(i); const run = await scoped(keep, rows);
    const t0 = performance.now(); const r = await rawT2(run, rows); ms.push(performance.now() - t0);
    assert.equal(r.published_count, 500);
  }
  ms.sort((a, b) => a - b);
  const median = (ms[4] + ms[5]) / 2, p95 = ms[9];
  const waits = [];
  for (const kind of ['SUSPEND', 'SUSPEND', 'TERMINATE_RETENTION', 'TERMINATE_RETENTION']) {
    const src = await source({ policy: 'KEEP_FIRST' });
    const rows = atCap(`${kind}${waits.length}`); const run = await scoped(src, rows);
    const x = await connect({ user: 'si_collector', database: db }); cleanups.push(() => x.end());
    const ra = await connect({ user: 'si_rights_admin', database: db }); cleanups.push(() => ra.end());
    const xp = await pid(x), rap = await pid(ra);
    await x.query('BEGIN');
    await x.query(T2, [run.run_id, run.lease_token, JSON.stringify(rows)]);
    const t0 = performance.now();
    const ctl = waiter(control(ra, src, kind));
    await waitUntilBlocked(c.admin, rap, xp);
    await holderCommit(assert, x, xp);
    const rec = await expectWaiterOk(assert, ctl);                           // recorded, never 55P03
    waits.push(performance.now() - t0);
    const s = await state(run.run_id);
    const pubSeq = (await c.admin.query('SELECT publish_control_seq FROM si.collection_runs WHERE run_id = $1', [run.run_id])).rows[0].publish_control_seq;
    assert.ok(s.status === 'COMPLETED' && pubSeq < rec.control_seq, `${kind}: G1 — completed before the control`);
  }
  const stop = await source(); const rows = [ROW('after-ctl')]; const late = await scoped(stop, rows);
  await control(c.si_rights_admin, stop, 'TERMINATE_RETENTION');
  await refused(rawT2(late, rows), 'RIGHTS_TERMINATED');
  await untouched(late);
  console.log(`# EV-15 payload ${bytes} B; T2 at cap ms: median ${median.toFixed(0)}, p95 ${p95.toFixed(0)}; ` +
              `emergency waits ms: ${waits.map(w => w.toFixed(0)).join(', ')}`);
  assert.ok(bytes <= 1048576, 'the benchmark payload is within the byte cap');
  assert.ok(median <= 2000, `median ${median.toFixed(0)} ms <= 2000 ms`);
  assert.ok(p95 <= 5000, `p95 ${p95.toFixed(0)} ms <= 5000 ms`);
  assert.ok(Math.max(...waits) <= 5000, `emergency-control wait ${Math.max(...waits).toFixed(0)} ms <= 5000 ms`);
});

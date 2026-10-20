// Migration 0001 behaviour: sources, rights versions, evidence, validity functions.
// Design test IDs are cited where a test implements one (A1, A8, R1–R6, RR8, ...).
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { mayUse } from '../../dist/index.js';
import {
  asOwner, createSources, expectOrderRejection, freshDatabase, pid, recordRights, rejects, roles, waitUntilBlocked
} from './helpers.mjs';

const one = async (c, sql, params = []) => (await c.query(sql, params)).rows[0];
const CHECK = '23514';
const DENIED = '42501';

// One database for this file (cloned from the migrated template); dropped after all tests.
let db;
let c;           // { admin, si_rights_admin, si_collector, si_retention, si_monitor }
const cleanups = [];
const fileScope = { after: fn => cleanups.push(fn) };
test.before(async () => {
  db = await freshDatabase(fileScope, 'rights');
  c = await roles(fileScope, db, ['admin', 'si_rights_admin', 'si_collector', 'si_retention', 'si_monitor']);
});
test.after(async () => { for (const fn of cleanups.reverse()) await fn(); });

test('seed: one fictional synthetic source; evaluation+retain allowed, 30 days, customer actions denied', async t => {
  const s = await one(c.admin, `SELECT * FROM si.sources`);
  assert.equal(s.source_id, 'synthetic-fixture');
  assert.equal(s.evidence_kind, 'SYNTHETIC');
  assert.deepEqual(s.supported_networks, ['META', 'TIKTOK']);
  assert.equal(s.conflict_policy, 'FAIL_RUN');
  assert.equal(s.retired_at, null);
  const v = await one(c.admin, `SELECT * FROM si.rights_versions WHERE source_id = 'synthetic-fixture'`);
  assert.equal(v.version, 1);
  assert.deepEqual([v.evaluation, v.retain, v.subscriber_display, v.media_mirror, v.export],
                   ['ALLOWED', 'ALLOWED', 'DENIED', 'DENIED', 'DENIED']);
  assert.equal(v.retention_days, 30);
  assert.equal((await one(c.admin, `SELECT cleanup_within = interval '1 hour' AS ok FROM si.rights_versions WHERE version = 1 AND source_id = 'synthetic-fixture'`)).ok, true);
  assert.equal(v.expires_at, null);
  const ev = (await c.admin.query(`SELECT kind FROM si.rights_evidence WHERE rights_version_id = $1`, [v.rights_version_id])).rows;
  assert.deepEqual(ev.map(e => e.kind), ['SYNTHETIC_DECLARATION']);
  assert.equal((await one(c.si_collector, `SELECT si.rights_valid_for_publish($1, clock_timestamp()) AS ok`, [v.rights_version_id])).ok, true);
});

test('A1: rights_valid_for_publish boundaries (strict 60 s margin, successor, retirement, fail-closed)', async t => {
  await createSources(c.admin, ['a1-src', 'a1-open', 'a1-ret', 'a1-deny', 'a1-unk']);
  const v1 = await recordRights(c.si_rights_admin, 'a1-src', {
    effective_from_sql: `clock_timestamp() + interval '1 hour'`, expires_at_sql: `clock_timestamp() + interval '1 hour 10 minutes'` });
  const at = async (id, expr) => (await one(c.si_collector,
    `SELECT si.rights_valid_for_publish(v.rights_version_id, ${expr}) AS ok FROM si.rights_versions v WHERE v.rights_version_id = $1`, [id])).ok;
  const id = v1.rights_version_id;
  assert.equal(await at(id, `v.effective_from - interval '1 microsecond'`), false, 'before effective_from');
  assert.equal(await at(id, `v.effective_from`), true, 'at effective_from');
  assert.equal(await at(id, `v.expires_at - interval '60 seconds' - interval '1 microsecond'`), true, '1 µs inside the margin');
  assert.equal(await at(id, `v.expires_at - interval '60 seconds'`), false, 'equality fails (strict)');
  assert.equal(await at(id, `v.expires_at`), false, 'at expiry');

  // A scheduled successor ends v1's window at its effective_from.
  await recordRights(c.si_rights_admin, 'a1-src', { effective_from_sql: `(SELECT expires_at - interval '5 minutes' FROM si.rights_versions WHERE rights_version_id = ${Number(id)})` });
  assert.equal((await one(c.si_collector, `SELECT si.si_window_end($1) = (SELECT effective_from FROM si.rights_versions WHERE source_id = 'a1-src' AND version = 2) AS ok`, [id])).ok, true);
  const v2eff = `(SELECT effective_from FROM si.rights_versions WHERE source_id = 'a1-src' AND version = 2)`;
  assert.equal(await at(id, `${v2eff} - interval '60 seconds' - interval '1 microsecond'`), true);
  assert.equal(await at(id, `${v2eff} - interval '60 seconds'`), false);

  const open = await recordRights(c.si_rights_admin, 'a1-open');
  assert.equal((await one(c.si_collector, `SELECT si.si_window_end($1) = 'infinity'::timestamptz AS ok`, [open.rights_version_id])).ok, true);
  assert.equal(await at(open.rights_version_id, `clock_timestamp() + interval '100 years'`), true);

  const ret = await recordRights(c.si_rights_admin, 'a1-ret');
  await c.si_rights_admin.query(`UPDATE si.sources SET retired_at = clock_timestamp() + interval '1 hour' WHERE source_id = 'a1-ret'`);
  const retAt = `(SELECT retired_at FROM si.sources WHERE source_id = 'a1-ret')`;
  assert.equal(await at(ret.rights_version_id, `${retAt} - interval '1 microsecond'`), true);
  assert.equal(await at(ret.rights_version_id, retAt), false, 'not valid once the source is retired');

  const deny = await recordRights(c.si_rights_admin, 'a1-deny', { evaluation: 'DENIED' });
  assert.equal(await at(deny.rights_version_id, 'clock_timestamp()'), false, 'evaluation DENIED');
  const unk = await recordRights(c.si_rights_admin, 'a1-unk', { retain: 'UNKNOWN', retention_days: null });
  assert.equal(await at(unk.rights_version_id, 'clock_timestamp()'), false, 'retain UNKNOWN (B-001 demo rights are rejected)');
  assert.equal((await one(c.si_collector, `SELECT si.rights_valid_for_publish(-1, clock_timestamp()) AS ok`)).ok, false, 'unknown version');
  assert.equal((await one(c.si_collector, `SELECT si.rights_valid_for_publish($1, NULL) AS ok`, [open.rights_version_id])).ok, false, 'NULL time');
});

test('A8: effective_from cannot be backdated; when omitted it is read after the source lock', async t => {
  await createSources(c.admin, ['a8-src']);
  await rejects(assert, recordRights(c.si_rights_admin, 'a8-src', { effective_from_sql: `clock_timestamp() - interval '1 second'` }),
    { code: CHECK, message: /SI_BACKDATED_EFFECTIVE_FROM/ });
  const before = (await one(c.si_rights_admin, 'SELECT clock_timestamp() AS t')).t;
  const v = await recordRights(c.si_rights_admin, 'a8-src');
  assert.ok(v.effective_from >= before);
  assert.equal(v.version, 1, 'the failed attempt consumed no version');
});

test('R1: rights and evidence are append-only for every role, the owner and a superuser (UPDATE, DELETE, TRUNCATE)', async t => {
  for (const role of ['si_collector', 'si_rights_admin', 'si_retention', 'si_monitor']) {
    for (const sql of [
      `UPDATE si.rights_versions SET basis = 'x'`, `DELETE FROM si.rights_versions`, `TRUNCATE si.rights_versions CASCADE`,
      `INSERT INTO si.rights_versions (source_id, evaluation, retain, subscriber_display, media_mirror, export, basis, change_reason)
         VALUES ('synthetic-fixture','DENIED','DENIED','DENIED','DENIED','DENIED','x','x')`,
      `UPDATE si.rights_evidence SET reference = 'x'`, `DELETE FROM si.rights_evidence`, `TRUNCATE si.rights_evidence`,
      `INSERT INTO si.rights_evidence (rights_version_id, kind, reference) VALUES (1, 'INTERNAL_NOTE', 'x')`
    ]) {
      await rejects(assert, c[role].query(sql), { code: DENIED });
    }
  }
  for (const sql of [
    `UPDATE si.rights_versions SET basis = 'x'`, `DELETE FROM si.rights_versions`, `TRUNCATE si.rights_versions CASCADE`,
    `UPDATE si.rights_evidence SET reference = 'x'`, `DELETE FROM si.rights_evidence`, `TRUNCATE si.rights_evidence`,
    `TRUNCATE si.sources CASCADE`
  ]) {
    await rejects(assert, asOwner(c.admin, x => x.query(sql)), { code: CHECK, message: /SI_APPEND_ONLY/ });
    await rejects(assert, c.admin.query(sql), { code: CHECK, message: /SI_APPEND_ONLY/ });   // superuser, no SET ROLE
  }
  assert.equal((await one(c.admin, `SELECT basis FROM si.rights_versions WHERE source_id = 'synthetic-fixture'`)).basis.startsWith('Author-created'), true);
});

test('R2: any ALLOWED needs evidence, checked at COMMIT (deferred), not at INSERT', async t => {
  await createSources(c.admin, ['r2-src']);
  const none = { evidence: [[], [], null, null] };
  await rejects(assert, recordRights(c.si_rights_admin, 'r2-src', none), { code: CHECK, message: /SI_EVIDENCE_REQUIRED/ });
  // Explicit transaction: the call itself succeeds; the COMMIT fails.
  await c.si_rights_admin.query('BEGIN');
  const v = await recordRights(c.si_rights_admin, 'r2-src', none);
  assert.equal(v.version, 1);
  await rejects(assert, c.si_rights_admin.query('COMMIT'), { code: CHECK, message: /SI_EVIDENCE_REQUIRED/ });
  assert.equal((await one(c.admin, `SELECT count(*)::int AS n FROM si.rights_versions WHERE source_id = 'r2-src'`)).n, 0);
  // A version that allows nothing (a revocation) needs no evidence.
  const r = await recordRights(c.si_rights_admin, 'r2-src', { ...none, evaluation: 'DENIED', retain: 'DENIED', retention_days: null });
  assert.equal(r.version, 1);
});

test('R3: synthetic sources need a SYNTHETIC_DECLARATION; non-synthetic sources cannot exist', async t => {
  await createSources(c.admin, ['r3-src']);
  await rejects(assert, recordRights(c.si_rights_admin, 'r3-src', { evidence: [['AGREEMENT'], ['doc:1'], null, null] }),
    { code: CHECK, message: /SI_SYNTHETIC_DECLARATION_REQUIRED/ });
  const ok = await recordRights(c.si_rights_admin, 'r3-src', { evidence: [['AGREEMENT', 'SYNTHETIC_DECLARATION'], ['doc:1', 'doc:2'], null, null] });
  assert.equal(ok.version, 1);
  await rejects(assert, asOwner(c.admin, x => x.query(
    `INSERT INTO si.sources (source_id, display_name, evidence_kind, supported_networks) VALUES ('r3-real', 'x', 'LICENSED', '{META}')`)),
    { code: CHECK });
});

test('R4: customer-facing actions can never be ALLOWED', async t => {
  await createSources(c.admin, ['r4-src']);
  for (const action of ['subscriber_display', 'media_mirror', 'export']) {
    await rejects(assert, recordRights(c.si_rights_admin, 'r4-src', { [action]: 'ALLOWED' }), { code: CHECK });
  }
});

test('R6: versions are dense; an out-of-sequence version number is refused', async t => {
  await createSources(c.admin, ['r6-src']);
  for (let i = 1; i <= 3; i++) assert.equal((await recordRights(c.si_rights_admin, 'r6-src')).version, i);
  const direct = v => asOwner(c.admin, x => x.query(
    `INSERT INTO si.rights_versions (source_id, version, evaluation, retain, subscriber_display, media_mirror, export, basis, change_reason)
     VALUES ('r6-src', ${v}, 'DENIED', 'DENIED', 'DENIED', 'DENIED', 'DENIED', 'x', 'x')`));
  await rejects(assert, direct(5), { code: CHECK, message: /SI_VERSION_SEQUENCE/ });
  await rejects(assert, direct(3), { code: CHECK, message: /SI_VERSION_SEQUENCE/ });
  await direct(4);
  await rejects(assert, asOwner(c.admin, x => x.query(
    `INSERT INTO si.rights_versions (rights_version_id, source_id, evaluation, retain, subscriber_display, media_mirror, export, basis, change_reason)
     VALUES (999999, 'r6-src', 'DENIED', 'DENIED', 'DENIED', 'DENIED', 'DENIED', 'x', 'x')`)), { code: '428C9' });
});

test('effective_from is non-decreasing across versions (NEG)', async t => {
  await createSources(c.admin, ['ord-src']);
  await recordRights(c.si_rights_admin, 'ord-src', { effective_from_sql: `clock_timestamp() + interval '1 hour'` });
  await expectOrderRejection(assert, c.si_rights_admin, 'ord-src', { effective_from_sql: `clock_timestamp() + interval '30 minutes'` });
  assert.equal((await recordRights(c.si_rights_admin, 'ord-src', { effective_from_sql: `clock_timestamp() + interval '2 hours'` })).version, 2);
});

test('FINDING (NEG): while a future-dated version is pending, an immediate revocation is refused (frozen 2.1 rule, unchanged)', async t => {
  // The frozen 2.1 rule is kept: once a version is scheduled for later, no version can take
  // effect before it. Amendment C resolves the operational need with source controls
  // (tests/db/controls.test.mjs, C2); retirement (immediate, final) also remains available.
  await createSources(c.admin, ['find-src']);
  await recordRights(c.si_rights_admin, 'find-src');
  await recordRights(c.si_rights_admin, 'find-src', { effective_from_sql: `clock_timestamp() + interval '7 days'` });
  await expectOrderRejection(assert, c.si_rights_admin, 'find-src', { evaluation: 'DENIED', retain: 'DENIED', retention_days: null });
  await c.si_rights_admin.query(`UPDATE si.sources SET retired_at = clock_timestamp() WHERE source_id = 'find-src'`);
  const v1 = (await one(c.admin, `SELECT rights_version_id FROM si.rights_versions WHERE source_id = 'find-src' AND version = 1`)).rights_version_id;
  assert.equal((await one(c.si_collector, `SELECT si.rights_valid_for_publish($1, clock_timestamp()) AS ok`, [v1])).ok, false);
});

test('CHECK constraints on rights, evidence and sources', async t => {
  await createSources(c.admin, ['chk-src']);
  const bad = [
    { cleanup_within: '2 hours' }, { cleanup_within: '-1 second' }, { retention_days: null },
    { retention_days: 0 }, { retention_days: 3651 }, { basis: '   ' }, { change_reason: ' ' }, { evaluation: 'MAYBE' },
    { effective_from_sql: `clock_timestamp() + interval '1 hour'`, expires_at_sql: `clock_timestamp() + interval '30 minutes'` },
    { evidence: [['SYNTHETIC_DECLARATION'], ['x'], ['NOT-A-SHA'], null] },
    { evidence: [['SCREENSHOT'], ['x'], null, null] },
    { evidence: [['SYNTHETIC_DECLARATION'], [''], null, null] }
  ];
  for (const o of bad) await rejects(assert, recordRights(c.si_rights_admin, 'chk-src', o), { code: CHECK });
  await rejects(assert, recordRights(c.si_rights_admin, 'chk-src', { evidence: [['SYNTHETIC_DECLARATION', 'AGREEMENT'], ['x'], null, null] }),
    { code: '22023', message: /SI_BAD_ARGUMENT/ });
  const src = sql => asOwner(c.admin, x => x.query(sql));
  for (const values of [
    `('Bad_ID', 'x', 'SYNTHETIC', '{META}')`, `('ok-id-1', 'x', 'SYNTHETIC', '{}')`, `('ok-id-2', 'x', 'SYNTHETIC', '{META,NULL}')`,
    `('ok-id-3', 'x', 'SYNTHETIC', '{FACEBOOK}')`, `('ok-id-4', 'x', 'SYNTHETIC', '{{META}}')`, `('ok-id-5', '', 'SYNTHETIC', '{META}')`
  ]) {
    await rejects(assert, src(`INSERT INTO si.sources (source_id, display_name, evidence_kind, supported_networks) VALUES ${values}`), { code: CHECK });
  }
  assert.equal((await recordRights(c.si_rights_admin, 'chk-src')).version, 1, 'failed attempts consumed no version');
});

test('attribution comes from session_user and cannot be forged', async t => {
  await createSources(c.admin, ['attr-src']);
  const v = await recordRights(c.si_rights_admin, 'attr-src');
  assert.equal((await one(c.admin, 'SELECT recorded_by FROM si.rights_versions WHERE rights_version_id = $1', [v.rights_version_id])).recorded_by, 'si_rights_admin');
  assert.equal((await one(c.admin, 'SELECT recorded_by FROM si.rights_evidence WHERE rights_version_id = $1', [v.rights_version_id])).recorded_by, 'si_rights_admin');
  await asOwner(c.admin, x => x.query(
    `INSERT INTO si.rights_versions (source_id, evaluation, retain, subscriber_display, media_mirror, export, basis, change_reason, recorded_by, recorded_at)
     VALUES ('attr-src', 'DENIED', 'DENIED', 'DENIED', 'DENIED', 'DENIED', 'x', 'x', 'someone-else', '2000-01-01')`));
  const forged = await one(c.admin, `SELECT recorded_by, recorded_at > now() - interval '1 hour' AS fresh FROM si.rights_versions WHERE source_id = 'attr-src' AND version = 2`);
  assert.equal(forged.recorded_by, 'si_bootstrap');
  assert.equal(forged.fresh, true);
});

test('concurrency: two rights admins on one source serialize on the source row; versions stay dense', async t => {
  await createSources(c.admin, ['conc-src']);
  const extra = await roles(t, db, ['si_rights_admin']);
  const a = c.si_rights_admin, b = extra.si_rights_admin;
  const [pa, pb] = [await pid(a), await pid(b)];
  assert.notEqual(pa, pb);
  await a.query('BEGIN');
  const va = await recordRights(a, 'conc-src');                       // holds sources FOR UPDATE until COMMIT
  const pending = recordRights(b, 'conc-src');
  await waitUntilBlocked(c.admin, pb, pa);
  await a.query('COMMIT');
  const vb = await pending;
  assert.equal(va.version, 1);
  assert.equal(vb.version, 2);
  const r = await one(c.admin, `SELECT pg_xact_commit_timestamp(a.xmin) IS NOT NULL AS tracked,
                                       b.effective_from > pg_xact_commit_timestamp(a.xmin) AS after_commit
                                FROM si.rights_versions a, si.rights_versions b
                                WHERE a.rights_version_id = $1 AND b.rights_version_id = $2`, [va.rights_version_id, vb.rights_version_id]);
  assert.equal(r.tracked, true, 'track_commit_timestamp must be on');
  assert.equal(r.after_commit, true, 'B read the clock after A committed (2.1 section A, point 4)');
});

test('RR8: retirement is final once passed; a future retirement may move or be cleared', async t => {
  await createSources(c.admin, ['rr8-past', 'rr8-future', 'rr8-soon']);
  const ra = c.si_rights_admin;
  await ra.query(`UPDATE si.sources SET retired_at = clock_timestamp() - interval '1 second' WHERE source_id = 'rr8-past'`);
  await rejects(assert, ra.query(`UPDATE si.sources SET retired_at = NULL WHERE source_id = 'rr8-past'`), { code: CHECK, message: /SI_RETIREMENT_FINAL/ });
  await rejects(assert, ra.query(`UPDATE si.sources SET retired_at = clock_timestamp() + interval '1 hour' WHERE source_id = 'rr8-past'`), { code: CHECK, message: /SI_RETIREMENT_FINAL/ });
  await rejects(assert, asOwner(c.admin, x => x.query(`UPDATE si.sources SET retired_at = NULL WHERE source_id = 'rr8-past'`)), { code: CHECK, message: /SI_RETIREMENT_FINAL/ });
  await ra.query(`UPDATE si.sources SET retired_at = clock_timestamp() + interval '1 hour' WHERE source_id = 'rr8-future'`);
  await ra.query(`UPDATE si.sources SET retired_at = clock_timestamp() + interval '2 hours' WHERE source_id = 'rr8-future'`);
  await ra.query(`UPDATE si.sources SET retired_at = NULL WHERE source_id = 'rr8-future'`);
  await ra.query(`UPDATE si.sources SET retired_at = clock_timestamp() + interval '1 second' WHERE source_id = 'rr8-soon'`);
  await sleep(1200);
  await rejects(assert, ra.query(`UPDATE si.sources SET retired_at = NULL WHERE source_id = 'rr8-soon'`), { code: CHECK, message: /SI_RETIREMENT_FINAL/ });
  await rejects(assert, ra.query(`UPDATE si.sources SET display_name = 'x' WHERE source_id = 'rr8-future'`), { code: DENIED });
});

test('Amendment B helper si_retention_end (function level; read-path tests RR1–RR7 belong to later milestones)', async t => {
  const ra = c.si_rights_admin;
  const end = async (src, n) => (await one(c.admin, 'SELECT si.si_retention_end($1, $2) AS e', [src, n])).e;
  const eff = async (src, v) => (await one(c.admin, 'SELECT effective_from AS e FROM si.rights_versions WHERE source_id = $1 AND version = $2', [src, v])).e;
  const exp = async (src, v) => (await one(c.admin, 'SELECT expires_at AS e FROM si.rights_versions WHERE source_id = $1 AND version = $2', [src, v])).e;
  const same = async (sql, params) => (await one(c.admin, `SELECT ${sql} AS ok`, params)).ok;
  const deny = { evaluation: 'DENIED', retain: 'DENIED', retention_days: null };
  await createSources(c.admin, ['b-regrant', 'b-super', 'b-gap', 'b-contig', 'b-exp-rev', 'b-none']);

  // revoke -> re-grant: data from v1 ends at v2; data from v3 has no end.
  await recordRights(ra, 'b-regrant');
  await recordRights(ra, 'b-regrant', { ...deny, effective_from_sql: `clock_timestamp() + interval '10 minutes'` });
  await recordRights(ra, 'b-regrant', { effective_from_sql: `clock_timestamp() + interval '20 minutes'` });
  assert.equal(await same(`si.si_retention_end('b-regrant', 1) = (SELECT effective_from FROM si.rights_versions WHERE source_id = 'b-regrant' AND version = 2)`), true);
  assert.equal(await end('b-regrant', 3), null);

  // revocation superseded at the same instant never took effect.
  await recordRights(ra, 'b-super');
  await recordRights(ra, 'b-super', { ...deny, effective_from_sql: `clock_timestamp() + interval '10 minutes'` });
  await recordRights(ra, 'b-super', { effective_from_sql: `(SELECT effective_from FROM si.rights_versions WHERE source_id = 'b-super' AND version = 2)` });
  assert.deepEqual(await eff('b-super', 3), await eff('b-super', 2));
  assert.equal(await end('b-super', 1), null);

  // expiry gap ends v1 data at the expiry; v2 data unaffected.
  await recordRights(ra, 'b-gap', { expires_at_sql: `clock_timestamp() + interval '10 minutes'` });
  await recordRights(ra, 'b-gap', { effective_from_sql: `(SELECT expires_at + interval '5 seconds' FROM si.rights_versions WHERE source_id = 'b-gap' AND version = 1)` });
  assert.equal(await same(`si.si_retention_end('b-gap', 1) = (SELECT expires_at FROM si.rights_versions WHERE source_id = 'b-gap' AND version = 1)`), true);
  assert.equal(await end('b-gap', 2), null);

  // contiguous renewal: no gap, no end.
  await recordRights(ra, 'b-contig', { expires_at_sql: `clock_timestamp() + interval '10 minutes'` });
  await recordRights(ra, 'b-contig', { effective_from_sql: `(SELECT expires_at FROM si.rights_versions WHERE source_id = 'b-contig' AND version = 1)` });
  assert.equal(await end('b-contig', 1), null);

  // earliest event wins: expiry before a later revocation.
  await recordRights(ra, 'b-exp-rev', { expires_at_sql: `clock_timestamp() + interval '10 minutes'` });
  await recordRights(ra, 'b-exp-rev', { ...deny, effective_from_sql: `clock_timestamp() + interval '2 hours'` });
  assert.deepEqual(await end('b-exp-rev', 1), await exp('b-exp-rev', 1));

  await recordRights(ra, 'b-none');
  assert.equal(await end('b-none', 1), null);
  assert.equal(await end('b-none', 99), null);
});

test('R5: SQL rights_valid_for_publish agrees with B-001 mayUse() (documented mapping and differences)', async t => {
  // Mapping: SQL(v, p_at) == mayUse(evaluation, p_at + 60 s) && mayUse(retain, p_at + 60 s)
  // for versions already effective at p_at, with no successor, on an unretired source.
  // Intended differences (asserted separately): mayUse has no effective_from and no retirement.
  const base = (await one(c.admin, `SELECT date_trunc('second', clock_timestamp()) + interval '1 hour' AS b`)).b;
  const iso = (d, s) => new Date(d.getTime() + s * 1000).toISOString();
  const P = ['ALLOWED', 'DENIED', 'UNKNOWN'];
  const cases = [];
  for (const e of P) for (const r of P) cases.push({ e, r, exp: null });
  for (const exp of [3600, 61, 60, 59, 1, 0, -60]) cases.push({ e: 'ALLOWED', r: 'ALLOWED', exp });
  for (const exp of [3600, 61, 60]) for (const [e, r] of [['ALLOWED', 'DENIED'], ['DENIED', 'ALLOWED'], ['UNKNOWN', 'ALLOWED'], ['DENIED', 'DENIED']]) cases.push({ e, r, exp });
  for (const exp of [120, 61]) for (const [e, r] of [['ALLOWED', 'UNKNOWN'], ['UNKNOWN', 'UNKNOWN']]) cases.push({ e, r, exp });
  assert.ok(cases.length >= 30, `${cases.length} cases`);
  const ids = cases.map((_, i) => `r5-${i}`);
  await createSources(c.admin, ids);
  for (const [i, k] of cases.entries()) {
    const v = await recordRights(c.si_rights_admin, ids[i], {
      evaluation: k.e, retain: k.r, retention_days: k.r === 'ALLOWED' ? 30 : null,
      expires_at_sql: k.exp === null ? 'NULL' : `'${iso(base, k.exp)}'::timestamptz` });
    const sql = (await one(c.si_collector, 'SELECT si.rights_valid_for_publish($1, $2::timestamptz) AS ok', [v.rights_version_id, iso(base, 0)])).ok;
    const rights = { sourceId: ids[i], basis: 'x', evaluation: k.e, retain: k.r, subscriber_display: 'DENIED', media_mirror: 'DENIED', export: 'DENIED',
                     ...(k.exp === null ? {} : { expiresAt: iso(base, k.exp) }) };
    const ts = mayUse(rights, 'evaluation', iso(base, 60)) && mayUse(rights, 'retain', iso(base, 60));
    assert.equal(sql, ts, `case ${JSON.stringify(k)}`);
  }
  // Documented difference 1: before effective_from, SQL says false; mayUse has no notion of it.
  await createSources(c.admin, ['r5-future']);
  const fut = await recordRights(c.si_rights_admin, 'r5-future', { effective_from_sql: `'${iso(base, 600)}'::timestamptz` });
  assert.equal((await one(c.si_collector, 'SELECT si.rights_valid_for_publish($1, $2::timestamptz) AS ok', [fut.rights_version_id, iso(base, 0)])).ok, false);
  assert.equal(mayUse({ sourceId: 'x', basis: 'x', evaluation: 'ALLOWED', retain: 'ALLOWED', subscriber_display: 'DENIED', media_mirror: 'DENIED', export: 'DENIED' }, 'evaluation', iso(base, 60)), true);
  // Documented difference 2: a retired source fails in SQL; mayUse cannot see sources.
  await c.si_rights_admin.query(`UPDATE si.sources SET retired_at = clock_timestamp() WHERE source_id = 'r5-0'`);
  const r0 = (await one(c.admin, `SELECT rights_version_id FROM si.rights_versions WHERE source_id = 'r5-0'`)).rights_version_id;
  assert.equal((await one(c.si_collector, 'SELECT si.rights_valid_for_publish($1, $2::timestamptz) AS ok', [r0, iso(base, 0)])).ok, false);
});

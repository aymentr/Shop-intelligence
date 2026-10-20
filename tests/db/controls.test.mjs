// Amendment C (with Revisions 1-3), Milestone 1 scope: source controls in migration 0001.
// Test IDs follow the accepted design (CP*, C*, CC*, LC*, LR*, LI1, CK*).
// Every history satisfies SI_EFFECTIVE_FROM_ORDER (helpers.recordRights enforces it) except
// tests marked NEG, which use expectOrderRejection(). Concurrency order is established by
// construction: a holder keeps a lock in an open transaction and the waiter is proven blocked
// with pg_blocking_pids() before the holder commits. No assertion relies on commit timestamps.
//
// Milestone 1 has no collection runs, observations or deletion: "access" here means the
// operational predicates and rights_valid_for_publish. Physical erasure is not tested
// (and not implemented) until migration 0004.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  asOwner, control, controlView, createSources, expectOrderRejection, freshDatabase, lift, pid,
  recordRights, rejects, roles, waitUntilBlocked
} from './helpers.mjs';

const CHECK = '23514', DENIED = '42501', BADARG = '22023', ISO = '25000', FK = '23503';

let db, c;
const cleanups = [];
const fileScope = { after: fn => cleanups.push(fn) };
test.before(async () => {
  db = await freshDatabase(fileScope, 'controls');
  c = await roles(fileScope, db, ['admin', 'si_rights_admin', 'si_collector', 'si_retention', 'si_monitor']);
});
test.after(async () => { for (const fn of cleanups.reverse()) await fn(); });

const one = async (cl, sql, params = []) => (await cl.query(sql, params)).rows[0];
const vid = async (src, n) => (await one(c.admin, 'SELECT rights_version_id AS id FROM si.rights_versions WHERE source_id = $1 AND version = $2', [src, n])).id;
const effOf = (src, n) => `(SELECT effective_from FROM si.rights_versions WHERE source_id = '${src}' AND version = ${n})`;
const valid = async (src, n, at = 'clock_timestamp()') =>
  (await one(c.si_collector, `SELECT si.rights_valid_for_publish($1::bigint, ${at}) AS ok`, [await vid(src, n)])).ok;
const suspended = async src => (await one(c.si_collector, 'SELECT si.si_source_suspended($1) AS s', [src])).s;
const terminated = async (src, n) => (await one(c.si_collector, 'SELECT si.si_retention_terminated($1, $2) AS t', [src, n])).t;
// Timestamps are compared as text from one connection so microseconds never round-trip through JS Date.
const retEnd = async (src, k) => (await one(c.admin, 'SELECT si.si_retention_end($1, $2)::text AS e', [src, k])).e;
const winEnd = async (src, n) => (await one(c.admin, 'SELECT si.si_window_end($1)::text AS e', [await vid(src, n)])).e;
const occ = async (src, seq) => (await one(c.admin, 'SELECT occurred_at::text AS t FROM si.source_controls WHERE source_id = $1 AND control_seq = $2', [src, seq])).t;
const kinds = async src => (await c.admin.query('SELECT kind FROM si.source_controls WHERE source_id = $1 ORDER BY control_seq', [src])).rows.map(r => r.kind);
const versionCount = async src => (await one(c.admin, 'SELECT count(*)::int AS n FROM si.rights_versions WHERE source_id = $1', [src])).n;
async function waitDb(sql, ms = 15000) {
  const deadline = Date.now() + ms;
  while (!(await one(c.admin, `SELECT (${sql}) AS ok`)).ok) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${sql}`);
    await sleep(100);
  }
}
// A second rights-admin session plus both backend pids, read BEFORE any query is queued
// (a pg client runs one query at a time, so asking a blocked session for its pid would wait).
async function extraAdmin(t) {
  const b = (await roles(t, db, ['si_rights_admin'])).si_rights_admin;
  return { b, pa: await pid(c.si_rights_admin), pb: await pid(b) };
}

// ---------------------------------------------------------------------------------------
// Structure, attribution and refusals
// ---------------------------------------------------------------------------------------

test('meta: the history helper refuses a mis-specified (unordered) history as a test bug', async () => {
  await createSources(c.admin, ['meta-src']);
  await recordRights(c.si_rights_admin, 'meta-src', { effective_from_sql: `clock_timestamp() + interval '1 hour'` });
  await assert.rejects(recordRights(c.si_rights_admin, 'meta-src'), /TEST BUG: history for meta-src violates SI_EFFECTIVE_FROM_ORDER/);
  await assert.rejects(recordRights(c.si_rights_admin, 'meta-src', { effective_from_sql: `clock_timestamp() + interval '2 hours'`, expectOrderViolation: true }),
    /TEST BUG: expected an ordering violation/);
  assert.equal(await versionCount('meta-src'), 1);
});

test('CP2: source_controls is append-only for every role, the owner and a superuser', async () => {
  await createSources(c.admin, ['cp2']);
  await control(c.si_rights_admin, 'cp2', 'SUSPEND');
  for (const role of ['si_collector', 'si_rights_admin', 'si_retention', 'si_monitor']) {
    for (const sql of [`UPDATE si.source_controls SET reason = 'x'`, `DELETE FROM si.source_controls`, `TRUNCATE si.source_controls`]) {
      await rejects(assert, c[role].query(sql), { code: DENIED });
    }
  }
  for (const sql of [`UPDATE si.source_controls SET kind = 'LIFT'`, `DELETE FROM si.source_controls`, `TRUNCATE si.source_controls`]) {
    await rejects(assert, asOwner(c.admin, x => x.query(sql)), { code: CHECK, message: /SI_APPEND_ONLY/ });
    await rejects(assert, c.admin.query(sql), { code: CHECK, message: /SI_APPEND_ONLY/ });
  }
  assert.deepEqual(await kinds('cp2'), ['SUSPEND']);
});

test('CP3: computed fields are overwritten on direct owner INSERT; the write function has no time parameter', async () => {
  await createSources(c.admin, ['cp3']);
  await recordRights(c.si_rights_admin, 'cp3');
  await recordRights(c.si_rights_admin, 'cp3', { effective_from_sql: `clock_timestamp() + interval '1 hour'` });   // pending
  await asOwner(c.admin, x => x.query(
    `INSERT INTO si.source_controls (source_id, control_seq, kind, through_version, reason, occurred_at, recorded_by)
     VALUES ('cp3', 99, 'TERMINATE_RETENTION', 99, 'forged', '2000-01-01', 'someone-else')`));
  const r = await one(c.admin, `SELECT control_seq, through_version, recorded_by, occurred_at > now() - interval '1 minute' AS fresh
                                FROM si.source_controls WHERE source_id = 'cp3'`);
  assert.deepEqual(r, { control_seq: 1, through_version: 2, recorded_by: 'si_bootstrap', fresh: true },
    'seq, through_version (pending version included), attribution and time come from the database');
  const args = (await one(c.admin, `SELECT pg_get_function_arguments('si.si_record_source_control(text,text,text,text,int,int,int,int)'::regprocedure) AS a`)).a;
  assert.doesNotMatch(args, /timestamp|interval|date/, 'immediate-only by construction');
  // LIFT-only arguments are ignored for restrictions (a restriction never fails on a stale view).
  await createSources(c.admin, ['cp3b']);
  await control(c.si_rights_admin, 'cp3b', 'SUSPEND', { expectedMaxVersion: 42, expectedControlSeq: 42, ackTerminationSeq: 1, authorizationVersion: 1 });
  const s = await one(c.admin, `SELECT expected_max_version, expected_control_seq, ack_termination_seq, authorization_version, through_version
                                FROM si.source_controls WHERE source_id = 'cp3b'`);
  assert.deepEqual(s, { expected_max_version: null, expected_control_seq: null, ack_termination_seq: null, authorization_version: null, through_version: null });
});

test('CP4: refusals consume no sequence number', async () => {
  await createSources(c.admin, ['cp4', 'cp4-ret']);
  await recordRights(c.si_rights_admin, 'cp4');
  const ra = c.si_rights_admin;
  await rejects(assert, lift(ra, 'cp4'), { code: CHECK, message: /SI_NOT_SUSPENDED/ });
  await rejects(assert, control(ra, 'cp4', 'PAUSE'), { code: BADARG, message: /SI_BAD_ARGUMENT/ });
  await rejects(assert, control(ra, 'cp4', null), { code: BADARG, message: /SI_BAD_ARGUMENT/ });
  await rejects(assert, control(ra, 'no-such-source', 'SUSPEND'), { code: FK, message: /SI_UNKNOWN_SOURCE/ });
  await rejects(assert, control(ra, 'cp4', 'SUSPEND', { reason: '   ' }), { code: CHECK });
  await rejects(assert, control(ra, 'cp4', 'SUSPEND', { reference: '' }), { code: CHECK });
  assert.equal((await control(ra, 'cp4', 'SUSPEND')).control_seq, 1);
  await rejects(assert, control(ra, 'cp4', 'LIFT'), { code: BADARG, message: /SI_BAD_ARGUMENT: LIFT requires/ });
  await rejects(assert, lift(ra, 'cp4', { expectedMaxVersion: 0 }), { code: CHECK, message: /SI_STALE_VIEW/ });
  await rejects(assert, lift(ra, 'cp4', { expectedControlSeq: 0 }), { code: CHECK, message: /SI_STALE_VIEW/ });
  await rejects(assert, lift(ra, 'cp4', { ackTerminationSeq: 1, authorizationVersion: 1 }), { code: BADARG, message: /nothing to acknowledge/ });
  assert.equal((await lift(ra, 'cp4')).control_seq, 2);
  await rejects(assert, lift(ra, 'cp4'), { code: CHECK, message: /SI_NOT_SUSPENDED/ });
  assert.deepEqual(await kinds('cp4'), ['SUSPEND', 'LIFT']);
  // LIFT on a retired source.
  await recordRights(ra, 'cp4-ret');
  await control(ra, 'cp4-ret', 'SUSPEND');
  await ra.query(`UPDATE si.sources SET retired_at = clock_timestamp() WHERE source_id = 'cp4-ret'`);
  await rejects(assert, lift(ra, 'cp4-ret'), { code: CHECK, message: /SI_SOURCE_RETIRED/ });
});

// ---------------------------------------------------------------------------------------
// Semantics
// ---------------------------------------------------------------------------------------

test('C1: SUSPEND denies at once without touching versions; LIFT restores', async () => {
  await createSources(c.admin, ['c1']);
  await recordRights(c.si_rights_admin, 'c1');
  assert.equal(await valid('c1', 1), true);
  await control(c.si_rights_admin, 'c1', 'SUSPEND');
  assert.equal(await suspended('c1'), true);
  assert.equal(await valid('c1', 1), false);
  assert.equal(await versionCount('c1'), 1);
  await lift(c.si_rights_admin, 'c1');
  assert.equal(await suspended('c1'), false);
  assert.equal(await valid('c1', 1), true);
});

test('C2 (the M1 FINDING scenario): with a re-grant scheduled in 7 days, SUSPEND stops use now and at the re-grant', async () => {
  await createSources(c.admin, ['c2']);
  const ra = c.si_rights_admin;
  await recordRights(ra, 'c2');
  await recordRights(ra, 'c2', { effective_from_sql: `clock_timestamp() + interval '7 days'` });         // scheduled re-grant v2
  await expectOrderRejection(assert, ra, 'c2', { evaluation: 'DENIED', retain: 'DENIED', retention_days: null });   // NEG: frozen rule unchanged
  await control(ra, 'c2', 'SUSPEND');
  assert.equal(await valid('c2', 1), false, 'current version denied now');
  assert.equal(await valid('c2', 2, `${effOf('c2', 2)} + interval '1 second'`), false,
    'the scheduled re-grant is denied at its effective_from (prediction over the committed history)');
  await lift(ra, 'c2');
  assert.equal(await valid('c2', 2, `${effOf('c2', 2)} + interval '1 second'`), true, 'only an explicit LIFT restores it');
});

test('C3 (real clock): a scheduled re-grant that takes effect during a suspension stays unusable until LIFT', async () => {
  await createSources(c.admin, ['c3']);
  const ra = c.si_rights_admin;
  await recordRights(ra, 'c3');
  await recordRights(ra, 'c3', { effective_from_sql: `clock_timestamp() + interval '2 seconds'` });
  await control(ra, 'c3', 'SUSPEND');
  await waitDb(`clock_timestamp() > ${effOf('c3', 2)}`);
  assert.equal(await valid('c3', 2), false, 'v2 is now the current version, but the source is suspended');
  assert.equal(await suspended('c3'), true);
  await lift(ra, 'c3');
  assert.equal(await valid('c3', 2), true);
});

test('C4: TERMINATE_RETENTION covers pending versions; window and retention end at occurred_at; source suspended', async () => {
  await createSources(c.admin, ['c4']);
  const ra = c.si_rights_admin;
  await recordRights(ra, 'c4');
  await recordRights(ra, 'c4', { effective_from_sql: `clock_timestamp() + interval '1 hour'` });          // pending re-grant
  const t = await control(ra, 'c4', 'TERMINATE_RETENTION');
  assert.equal(t.through_version, 2, 'through_version includes the pending version');
  const at = await occ('c4', 1);
  assert.equal(await winEnd('c4', 1), at);
  assert.equal(await winEnd('c4', 2), at);
  assert.equal(await retEnd('c4', 1), at);
  assert.equal(await retEnd('c4', 2), at);
  assert.equal(await retEnd('c4', 3), null);
  assert.deepEqual([await terminated('c4', 1), await terminated('c4', 2), await terminated('c4', 3)], [true, true, false]);
  assert.equal(await suspended('c4'), true, 'C-D1: termination suspends');
  assert.equal(await valid('c4', 2, `${effOf('c4', 2)} + interval '1 second'`), false);
});

test('LR2 (corrected C5): recovery after termination never revives covered data or pending versions', async () => {
  await createSources(c.admin, ['lr2']);
  const ra = c.si_rights_admin;
  await recordRights(ra, 'lr2');
  await recordRights(ra, 'lr2', { effective_from_sql: `clock_timestamp() + interval '2 seconds'` });     // v2 pending
  const t = await control(ra, 'lr2', 'TERMINATE_RETENTION');
  const ends = async () => [await retEnd('lr2', 1), await retEnd('lr2', 2)];
  const frozen = await ends();
  assert.deepEqual(frozen, [await occ('lr2', 1), await occ('lr2', 1)]);
  // New authorization: ordered after the dead pending v2 (C-D5), then one more scheduled version.
  await recordRights(ra, 'lr2', { effective_from_sql: `${effOf('lr2', 2)} + interval '1 second'` });       // v3
  assert.deepEqual(await ends(), frozen);
  await recordRights(ra, 'lr2', { effective_from_sql: `${effOf('lr2', 3)} + interval '2 seconds'` });      // v4
  assert.deepEqual(await ends(), frozen);
  await lift(ra, 'lr2', { ackTerminationSeq: t.control_seq, authorizationVersion: 4 });
  assert.deepEqual(await ends(), frozen, 'LIFT does not change retention ends of covered versions');
  await waitDb(`clock_timestamp() > ${effOf('lr2', 4)}`);
  assert.equal(await valid('lr2', 2), false);
  assert.equal(await valid('lr2', 2, `${effOf('lr2', 2)} + interval '1 second'`), false, 'the pending version was neutralized');
  assert.equal(await valid('lr2', 4), true, 'the post-termination authorization is usable');
  assert.deepEqual(await ends(), frozen);
  assert.equal(await retEnd('lr2', 3), null);
  assert.equal(await terminated('lr2', 3), false);
});

test('C6: termination suspends; a version recorded after it is unusable until an acknowledged LIFT', async () => {
  await createSources(c.admin, ['c6']);
  const ra = c.si_rights_admin;
  await recordRights(ra, 'c6');
  const t = await control(ra, 'c6', 'TERMINATE_RETENTION');
  const end1 = await retEnd('c6', 1);
  await recordRights(ra, 'c6');                                                                         // v2, nothing pending
  assert.equal(await terminated('c6', 2), false);
  assert.equal(await valid('c6', 2), false, 'suspended');
  await rejects(assert, lift(ra, 'c6'), { code: CHECK, message: /SI_TERMINATION_ACK_REQUIRED/ });
  await lift(ra, 'c6', { ackTerminationSeq: t.control_seq, authorizationVersion: 2 });
  assert.equal(await valid('c6', 2), true);
  assert.equal(await retEnd('c6', 1), end1);
  // A later plain suspension needs no acknowledgement (no termination since the last LIFT).
  await control(ra, 'c6', 'SUSPEND');
  await lift(ra, 'c6');
  assert.equal(await retEnd('c6', 1), end1);
  assert.equal(await valid('c6', 1, `${effOf('c6', 1)}`), false, 'v1 stays covered by the termination');
});

test('C7: retirement precedence — restrictions are accepted on a retired source, LIFT is refused, retirement stays final', async () => {
  await createSources(c.admin, ['c7']);
  const ra = c.si_rights_admin;
  await recordRights(ra, 'c7');
  await control(ra, 'c7', 'SUSPEND');
  await ra.query(`UPDATE si.sources SET retired_at = clock_timestamp() WHERE source_id = 'c7'`);
  await control(ra, 'c7', 'SUSPEND');
  await control(ra, 'c7', 'TERMINATE_RETENTION');
  await rejects(assert, lift(ra, 'c7', { ackTerminationSeq: 3, authorizationVersion: 1 }), { code: CHECK, message: /SI_SOURCE_RETIRED/ });
  await rejects(assert, ra.query(`UPDATE si.sources SET retired_at = NULL WHERE source_id = 'c7'`), { code: CHECK, message: /SI_RETIREMENT_FINAL/ });
  assert.equal(await valid('c7', 1), false);
});

test('LR1: LIFT after TERMINATE requires a valid new authorization and acknowledgement of the latest termination', async () => {
  await createSources(c.admin, ['lr1']);
  const ra = c.si_rights_admin;
  const deny = { evaluation: 'DENIED', retain: 'DENIED', retention_days: null };
  await recordRights(ra, 'lr1');
  const t1 = await control(ra, 'lr1', 'TERMINATE_RETENTION');                                         // seq 1, through 1
  const AUTH = { code: CHECK, message: /SI_AUTHORIZATION_REQUIRED/ };
  await rejects(assert, lift(ra, 'lr1', { ackTerminationSeq: t1.control_seq }), AUTH);                  // no authorization
  await rejects(assert, lift(ra, 'lr1', { ackTerminationSeq: 1, authorizationVersion: 1 }), AUTH);      // <= through_version
  await recordRights(ra, 'lr1', deny);                                                                  // v2 DENIED
  await rejects(assert, lift(ra, 'lr1', { ackTerminationSeq: 1, authorizationVersion: 2 }), AUTH);      // not ALLOWED
  await recordRights(ra, 'lr1');                                                                        // v3 ALLOWED
  await recordRights(ra, 'lr1', deny);                                                                  // v4 DENIED
  await rejects(assert, lift(ra, 'lr1', { ackTerminationSeq: 1, authorizationVersion: 3 }), AUTH);      // not the latest version
  await recordRights(ra, 'lr1', { expires_at_sql: `clock_timestamp() + interval '1 second'` });         // v5 expiring
  await waitDb(`clock_timestamp() > (SELECT expires_at FROM si.rights_versions WHERE source_id = 'lr1' AND version = 5)`);
  await rejects(assert, lift(ra, 'lr1', { ackTerminationSeq: 1, authorizationVersion: 5 }), AUTH);      // expired
  await recordRights(ra, 'lr1');                                                                        // v6 ALLOWED
  await rejects(assert, lift(ra, 'lr1', { ackTerminationSeq: 99, authorizationVersion: 6 }), { code: CHECK, message: /SI_TERMINATION_ACK_REQUIRED/ });
  const t2 = await control(ra, 'lr1', 'TERMINATE_RETENTION');                                         // seq 2, through 6
  assert.equal(t2.through_version, 6);
  await recordRights(ra, 'lr1');                                                                        // v7
  await rejects(assert, lift(ra, 'lr1', { ackTerminationSeq: t1.control_seq, authorizationVersion: 7 }), { code: CHECK, message: /SI_TERMINATION_ACK_REQUIRED/ });
  await lift(ra, 'lr1', { ackTerminationSeq: t2.control_seq, authorizationVersion: 7 });
  assert.equal(await valid('lr1', 7), true);
  assert.equal(await valid('lr1', 6), false);
  const lr = await one(c.admin, `SELECT ack_termination_seq, authorization_version, expected_max_version, expected_control_seq
                                 FROM si.source_controls WHERE source_id = 'lr1' AND kind = 'LIFT'`);
  assert.deepEqual(lr, { ack_termination_seq: 2, authorization_version: 7, expected_max_version: 7, expected_control_seq: 2 }, 'stored for audit');
});

test('LC1: a stale operator cannot clear a newer SUSPEND (sequence check; the version did not change)', async () => {
  await createSources(c.admin, ['lc1']);
  const ra = c.si_rights_admin;
  await recordRights(ra, 'lc1');
  await control(ra, 'lc1', 'SUSPEND');
  await lift(ra, 'lc1');
  const stale = await controlView(ra, 'lc1');                                                          // seq 2, version 1
  await control(ra, 'lc1', 'SUSPEND');                                                                 // seq 3 by someone else
  await rejects(assert, control(ra, 'lc1', 'LIFT', { expectedMaxVersion: stale.maxVersion, expectedControlSeq: stale.lastSeq }),
    { code: CHECK, message: /SI_STALE_VIEW/ });
  assert.equal(await suspended('lc1'), true);
  assert.equal(await versionCount('lc1'), 1, 'version-only compare-and-set would have passed');
  await lift(ra, 'lc1');
  assert.equal(await suspended('lc1'), false);
});

test('LC2: a stale operator cannot clear a newer TERMINATE_RETENTION; the fresh view still needs acknowledgement and authorization', async () => {
  await createSources(c.admin, ['lc2']);
  const ra = c.si_rights_admin;
  await recordRights(ra, 'lc2');
  await control(ra, 'lc2', 'SUSPEND');
  const stale = await controlView(ra, 'lc2');
  const t = await control(ra, 'lc2', 'TERMINATE_RETENTION');
  await rejects(assert, control(ra, 'lc2', 'LIFT', { expectedMaxVersion: stale.maxVersion, expectedControlSeq: stale.lastSeq }),
    { code: CHECK, message: /SI_STALE_VIEW/ });
  await rejects(assert, lift(ra, 'lc2'), { code: CHECK, message: /SI_TERMINATION_ACK_REQUIRED/ });
  await rejects(assert, lift(ra, 'lc2', { ackTerminationSeq: t.control_seq, authorizationVersion: 1 }), { code: CHECK, message: /SI_AUTHORIZATION_REQUIRED/ });
  assert.equal(await suspended('lc2'), true);
});

// ---------------------------------------------------------------------------------------
// Concurrency (order by construction; pg_blocking_pids proof)
// ---------------------------------------------------------------------------------------

test('LC3: concurrent SUSPEND vs a stale LIFT, both orders — the source ends suspended', async t => {
  const { b, pa, pb } = await extraAdmin(t);
  const a = c.si_rights_admin;
  await createSources(c.admin, ['lc3a', 'lc3b']);
  for (const s of ['lc3a', 'lc3b']) { await recordRights(a, s); await control(a, s, 'SUSPEND'); }

  // Order 1: A's new SUSPEND holds the lock; B's LIFT (view from before it) waits, then is refused.
  const stale = await controlView(b, 'lc3a');
  await a.query('BEGIN');
  await control(a, 'lc3a', 'SUSPEND');
  const p1 = control(b, 'lc3a', 'LIFT', { expectedMaxVersion: stale.maxVersion, expectedControlSeq: stale.lastSeq });
  await waitUntilBlocked(c.admin, pb, pa);
  await a.query('COMMIT');
  await rejects(assert, p1, { code: CHECK, message: /SI_STALE_VIEW/ });
  assert.deepEqual(await kinds('lc3a'), ['SUSPEND', 'SUSPEND']);
  assert.equal(await suspended('lc3a'), true);

  // Order 2: B's LIFT holds the lock; A's SUSPEND waits, then lands after it.
  await b.query('BEGIN');
  await lift(b, 'lc3b');
  const p2 = control(a, 'lc3b', 'SUSPEND');
  await waitUntilBlocked(c.admin, pa, pb);
  await b.query('COMMIT');
  assert.equal((await p2).control_seq, 3);
  assert.deepEqual(await kinds('lc3b'), ['SUSPEND', 'LIFT', 'SUSPEND']);
  assert.equal(await suspended('lc3b'), true);
});

test('LC4: two LIFTs racing with the same view — exactly one succeeds', async t => {
  const { b, pa, pb } = await extraAdmin(t);
  const a = c.si_rights_admin;
  await createSources(c.admin, ['lc4']);
  await recordRights(a, 'lc4');
  await control(a, 'lc4', 'SUSPEND');
  const view = await controlView(a, 'lc4');
  const exp = { expectedMaxVersion: view.maxVersion, expectedControlSeq: view.lastSeq };
  await a.query('BEGIN');
  await control(a, 'lc4', 'LIFT', exp);
  const p = control(b, 'lc4', 'LIFT', exp);
  await waitUntilBlocked(c.admin, pb, pa);
  await a.query('COMMIT');
  await rejects(assert, p, { code: CHECK, message: /SI_STALE_VIEW/ });
  assert.deepEqual(await kinds('lc4'), ['SUSPEND', 'LIFT']);
});

// Fixtures for CC1'-CC5': 'immediate' = v1 only (an immediate re-grant is legal);
// 'pending' = v1 + P scheduled in 1 hour (the re-grant is ordered at P + 1 s).
async function fixture(src, mode) {
  await createSources(c.admin, [src]);
  await recordRights(c.si_rights_admin, src);
  if (mode === 'pending') await recordRights(c.si_rights_admin, src, { effective_from_sql: `clock_timestamp() + interval '1 hour'` });
  const rg = mode === 'pending' ? 3 : 2;                                   // version number the re-grant will get
  return {
    rg,
    regrantOpts: mode === 'pending' ? { effective_from_sql: `${effOf(src, 2)} + interval '1 second'` } : {},
    atOf: n => mode === 'pending' ? `${effOf(src, n)} + interval '1 second'` : 'clock_timestamp()',
    nextOpts: n => mode === 'pending' ? { effective_from_sql: `${effOf(src, n)} + interval '1 second'` } : {}
  };
}

for (const mode of ['immediate', 'pending']) {
  test(`CC1' (${mode}): re-grant holds the lock, SUSPEND waits — the re-grant is unusable until LIFT`, async t => {
    const src = `cc1-${mode}`, { b, pa, pb } = await extraAdmin(t), a = c.si_rights_admin;
    const f = await fixture(src, mode);
    await a.query('BEGIN');
    await recordRights(a, src, f.regrantOpts);
    const p = control(b, src, 'SUSPEND');
    await waitUntilBlocked(c.admin, pb, pa);
    await a.query('COMMIT');
    await p;
    assert.equal(await suspended(src), true);
    assert.equal(await valid(src, f.rg, f.atOf(f.rg)), false);
    await lift(b, src);
    assert.equal(await valid(src, f.rg, f.atOf(f.rg)), true);
  });

  test(`CC2' (${mode}): SUSPEND holds the lock, re-grant waits — still suspended afterwards`, async t => {
    const src = `cc2-${mode}`, { b, pa, pb } = await extraAdmin(t), a = c.si_rights_admin;
    const f = await fixture(src, mode);
    await a.query('BEGIN');
    await control(a, src, 'SUSPEND');
    const p = recordRights(b, src, f.regrantOpts);
    await waitUntilBlocked(c.admin, pb, pa);
    await a.query('COMMIT');
    assert.equal((await p).version, f.rg);
    assert.equal(await suspended(src), true);
    assert.equal(await valid(src, f.rg, f.atOf(f.rg)), false);
    await lift(a, src);
    assert.equal(await valid(src, f.rg, f.atOf(f.rg)), true);
  });

  test(`CC3' (${mode}): re-grant holds the lock, TERMINATE waits — the re-grant is covered and never usable`, async t => {
    const src = `cc3-${mode}`, { b, pa, pb } = await extraAdmin(t), a = c.si_rights_admin;
    const f = await fixture(src, mode);
    await a.query('BEGIN');
    await recordRights(a, src, f.regrantOpts);
    const p = control(b, src, 'TERMINATE_RETENTION');
    await waitUntilBlocked(c.admin, pb, pa);
    await a.query('COMMIT');
    const term = await p;
    assert.equal(term.through_version, f.rg, 'the waiter saw the committed re-grant (READ COMMITTED, read after the lock)');
    assert.equal(await terminated(src, f.rg), true);
    await recordRights(a, src, f.nextOpts(f.rg));                                         // new authorization
    await lift(a, src, { ackTerminationSeq: term.control_seq, authorizationVersion: f.rg + 1 });
    assert.equal(await valid(src, f.rg, f.atOf(f.rg)), false, 'covered re-grant stays unusable after recovery');
    assert.equal(await valid(src, f.rg + 1, f.atOf(f.rg + 1)), true);
  });

  test(`CC4' (${mode}): TERMINATE holds the lock, re-grant waits — not covered, but unusable until an acknowledged LIFT`, async t => {
    const src = `cc4-${mode}`, { b, pa, pb } = await extraAdmin(t), a = c.si_rights_admin;
    const f = await fixture(src, mode);
    await a.query('BEGIN');
    const term = await control(a, src, 'TERMINATE_RETENTION');
    const p = recordRights(b, src, f.regrantOpts);
    await waitUntilBlocked(c.admin, pb, pa);
    await a.query('COMMIT');
    assert.equal((await p).version, f.rg);
    assert.equal(term.through_version, f.rg - 1);
    assert.equal(await terminated(src, f.rg), false);
    const end1 = await retEnd(src, 1);
    assert.equal(await valid(src, f.rg, f.atOf(f.rg)), false, 'C-D1: suspended by the termination');
    await lift(a, src, { ackTerminationSeq: term.control_seq, authorizationVersion: f.rg });
    assert.equal(await valid(src, f.rg, f.atOf(f.rg)), true);
    assert.equal(await retEnd(src, 1), end1);
    if (mode === 'pending') assert.equal(await valid(src, 2, f.atOf(2)), false, 'the pre-termination pending version stays dead');
  });

  test(`CC5' (${mode}): re-grant vs LIFT — a re-grant committed first makes the LIFT stale; a LIFT committed first precedes it`, async t => {
    const { b, pa, pb } = await extraAdmin(t), a = c.si_rights_admin;
    // Order 1: re-grant first.
    const s1 = `cc5a-${mode}`, f1 = await fixture(s1, mode);
    await control(a, s1, 'SUSPEND');
    const view = await controlView(b, s1);
    await a.query('BEGIN');
    await recordRights(a, s1, f1.regrantOpts);
    const p1 = control(b, s1, 'LIFT', { expectedMaxVersion: view.maxVersion, expectedControlSeq: view.lastSeq });
    await waitUntilBlocked(c.admin, pb, pa);
    await a.query('COMMIT');
    await rejects(assert, p1, { code: CHECK, message: /SI_STALE_VIEW/ });
    assert.equal(await suspended(s1), true);
    assert.equal(await valid(s1, f1.rg, f1.atOf(f1.rg)), false);
    // Order 2: LIFT first.
    const s2 = `cc5b-${mode}`, f2 = await fixture(s2, mode);
    await control(a, s2, 'SUSPEND');
    await a.query('BEGIN');
    await lift(a, s2);
    const p2 = recordRights(b, s2, f2.regrantOpts);
    await waitUntilBlocked(c.admin, pb, pa);
    await a.query('COMMIT');
    assert.equal((await p2).version, f2.rg);
    assert.equal(await suspended(s2), false);
    assert.equal(await valid(s2, f2.rg, f2.atOf(f2.rg)), true, 'a re-grant after the LIFT is a later, deliberate decision');
  });
}

test('CC6: two concurrent controls on one source serialize; sequence dense, occurred_at non-decreasing', async t => {
  const { b, pa, pb } = await extraAdmin(t), a = c.si_rights_admin;
  await createSources(c.admin, ['cc6']);
  await recordRights(a, 'cc6');
  await a.query('BEGIN');
  await control(a, 'cc6', 'SUSPEND');
  const p = control(b, 'cc6', 'TERMINATE_RETENTION');
  await waitUntilBlocked(c.admin, pb, pa);
  await a.query('COMMIT');
  assert.equal((await p).control_seq, 2);
  const r = await one(c.admin, `SELECT array_agg(control_seq ORDER BY control_seq) AS seqs,
                                       bool_and(occurred_at >= coalesce(prev, occurred_at)) AS monotone
                                FROM (SELECT control_seq, occurred_at, lag(occurred_at) OVER (ORDER BY control_seq) AS prev
                                      FROM si.source_controls WHERE source_id = 'cc6') x`);
  assert.deepEqual(r, { seqs: [1, 2], monotone: true });
});

test('CC7: a long-open reader (REPEATABLE READ snapshot) does not block a control', async t => {
  const reader = (await roles(t, db, ['si_collector'])).si_collector;
  await createSources(c.admin, ['cc7']);
  await recordRights(c.si_rights_admin, 'cc7');
  const id = await vid('cc7', 1);
  await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await reader.query('SELECT si.rights_valid_for_publish($1, clock_timestamp()), count(*) FROM si.source_controls', [id]);
  const started = Date.now();
  const done = control(c.si_rights_admin, 'cc7', 'SUSPEND');
  const res = await Promise.race([done.then(() => 'done'), sleep(2000).then(() => 'timeout')]);
  assert.equal(res, 'done', `control completed in ${Date.now() - started} ms while the reader was open`);
  const blockers = (await one(c.admin, 'SELECT pg_blocking_pids($1) AS b', [await pid(c.si_rights_admin)])).b;
  assert.deepEqual(blockers, []);
  await reader.query('COMMIT');
});

test('LI1: controls refuse REPEATABLE READ and SERIALIZABLE (function and direct owner INSERT)', async () => {
  await createSources(c.admin, ['li1']);
  for (const level of ['REPEATABLE READ', 'SERIALIZABLE']) {
    await c.si_rights_admin.query(`BEGIN ISOLATION LEVEL ${level}`);
    await rejects(assert, control(c.si_rights_admin, 'li1', 'SUSPEND'), { code: ISO, message: /SI_ISOLATION/ });
    await c.si_rights_admin.query('ROLLBACK');
    await c.admin.query(`BEGIN ISOLATION LEVEL ${level}`);
    await c.admin.query('SET LOCAL ROLE si_owner');
    await rejects(assert, c.admin.query(`INSERT INTO si.source_controls (source_id, control_seq, kind, reason) VALUES ('li1', 1, 'SUSPEND', 'x')`),
      { code: ISO, message: /SI_ISOLATION/ });
    await c.admin.query('ROLLBACK');
  }
  assert.equal((await control(c.si_rights_admin, 'li1', 'SUSPEND')).control_seq, 1, 'READ COMMITTED works');
});

// ---------------------------------------------------------------------------------------
// Clock independence (CK1) and commit visibility (CK2)
// ---------------------------------------------------------------------------------------

// Simulates rows recorded just before a backward clock step: occurred_at lies in the future.
// Superuser-only, inside one transaction, in a disposable test database.
async function insertSkewed(src, rows) {
  await c.admin.query('BEGIN');
  try {
    await c.admin.query('ALTER TABLE si.source_controls DISABLE TRIGGER trg_source_controls_insert');
    for (const r of rows) {
      await c.admin.query(`INSERT INTO si.source_controls (source_id, control_seq, kind, through_version, reason, occurred_at,
                             expected_max_version, expected_control_seq, ack_termination_seq, authorization_version)
                           VALUES ($1, $2, $3, $4, 'clock-skew simulation', clock_timestamp() + interval '1 hour', $5, $6, $7, $8)`,
        [src, r.seq, r.kind, r.through ?? null, r.emv ?? null, r.ecs ?? null, r.ack ?? null, r.auth ?? null]);
    }
    await c.admin.query('ALTER TABLE si.source_controls ENABLE TRIGGER trg_source_controls_insert');
    await c.admin.query('COMMIT');
  } catch (e) { await c.admin.query('ROLLBACK'); throw e; }
}

test('CK1: enforcement ignores occurred_at — controls stamped in the future still deny now; the clock guard fires', async () => {
  await createSources(c.admin, ['ck1', 'ck1b']);
  const ra = c.si_rights_admin;
  await recordRights(ra, 'ck1');
  await insertSkewed('ck1', [{ seq: 1, kind: 'SUSPEND' }]);
  assert.equal(await suspended('ck1'), true);
  assert.equal(await valid('ck1', 1), false);
  assert.equal((await one(c.admin, `SELECT si.si_source_suspended_at('ck1', clock_timestamp()) AS s`)).s, false,
    'the audit view (by occurred_at) disagrees: that is a reporting discrepancy, not an enforcement input');
  await rejects(assert, control(ra, 'ck1', 'SUSPEND'), { code: CHECK, message: /SI_CLOCK_REGRESSION/ });

  // Termination stamped in the future, then a (skewed) LIFT: the covered version stays denied
  // even though its window end (reporting) lies an hour ahead.
  await recordRights(ra, 'ck1b');
  await insertSkewed('ck1b', [{ seq: 1, kind: 'TERMINATE_RETENTION', through: 1 }]);
  assert.equal(await terminated('ck1b', 1), true);
  assert.equal(await valid('ck1b', 1), false);
  // The skewed LIFT bypasses the trigger (no acknowledgement checks): it isolates the
  // termination term, since neither suspension nor any time term denies v1 any more.
  await insertSkewed('ck1b', [{ seq: 2, kind: 'LIFT', emv: 1, ecs: 1 }]);
  assert.equal(await suspended('ck1b'), false);
  assert.equal((await one(c.admin, `SELECT si.si_window_end($1) > clock_timestamp() + interval '50 minutes' AS w`, [await vid('ck1b', 1)])).w, true,
    'the reporting window end lies an hour ahead');
  assert.equal(await valid('ck1b', 1), false, 'si_retention_terminated denies regardless of time');
});

test('CK2: commit visibility — an older snapshot keeps the old answer (documented); new statements see the control', async t => {
  const r = await roles(t, db, ['si_collector']);
  await createSources(c.admin, ['ck2']);
  await recordRights(c.si_rights_admin, 'ck2');
  const id = await vid('ck2', 1);
  const q = cl => cl.query('SELECT si.rights_valid_for_publish($1, clock_timestamp()) AS ok', [id]).then(x => x.rows[0].ok);
  const reader = r.si_collector;
  const fresh = c.si_collector;
  await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(await q(reader), true);
  await control(c.si_rights_admin, 'ck2', 'SUSPEND');                                     // committed
  assert.equal(await q(reader), true, 'V2: a snapshot taken before the commit still answers with the old state');
  assert.equal(await q(fresh), false, 'V1: a statement whose snapshot starts after the commit denies');
  await reader.query('COMMIT');
  assert.equal(await q(reader), false);
});

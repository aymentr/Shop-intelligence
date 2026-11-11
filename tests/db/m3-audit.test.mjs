// B-002 M3-AUD-01 (migration 0009): durable audit before evidence retrieval. Real disposable PostgreSQL 16,
// synthetic sources only. Every read requires a COMMITTED read intent bound to the login and the exact
// scope (source, cursor, limit); the read re-checks every authorization and consumes the intent.
//
// Fixtures a product path cannot perform (labelled where used): superuser statements under
// session_replication_role = replica (aging an intent or a retention deadline), a superuser-created
// deferred trigger that makes the intent's COMMIT fail, and mutated copies of the read function in a
// disposable database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { asOwner, cfg, connect, control, createSources, freshDatabase, lift, pid, recordRights, rejects, roles, schemaFingerprint, settle,
         waitUntilBlocked } from './helpers.mjs';
import { migrateDown, migrateUp } from '../../dist/persistence/migrate.js';
import { provisionReaderPrincipal } from '../../dist/persistence/bootstrap.js';
import { fixtureSha256, requestSha256 } from '../../dist/persistence/request-hash.js';
import { beginRead, readEvidence, grantReader, revokeReader, ReadFailed } from '../../dist/persistence/reader.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
// The read function as last defined (0010 replaces the 0009 read with the durability gate).
const MIG10 = readFileSync(new URL('../../db/migrations/0010_read_durability.up.sql', import.meta.url), 'utf8');
const ROLES = ['admin', 'si_rights_admin', 'si_collector', 'si_retention', 'si_monitor'];
let n = 0;

test.before(async () => {
  const a = await connect();
  try { for (const p of ['si_reader_alice', 'si_reader_bob', 'si_reader_carol']) await provisionReaderPrincipal(a, p, cfg.rolePassword); }
  finally { await a.end(); }
});

async function fresh(t, prefix = 'm3aud') {
  const db = await freshDatabase(t, prefix);
  const x = await roles(t, db, ROLES);
  const extra = [];
  t.after(async () => { for (const e of extra) await e.end().catch(() => {}); });
  Object.defineProperty(x, 'db', { value: db, enumerable: false });
  Object.defineProperty(x, 'connect', { enumerable: false, value: async user => { const k = await connect({ user, database: db }); extra.push(k); return k; } });
  return x;
}
const ROW = (id, o = {}) => ({ network: 'META', nativeAdId: id, advertiserName: 'Synthetic Co', countries: ['DE'],
  seenAt: '2026-01-01T00:00:00.000Z', sourceUrl: 'https://example.test/a', destinationUrl: 'https://example.test/dest',
  creativeUrl: 'https://example.test/creative', title: 'Synthetic title', ...o });
const rows = (k, tag = 'a') => Array.from({ length: k }, (_, i) => ROW(`${tag}${++n}-${i}`));
async function collect(x, src, rs) {
  const networks = [...new Set(rs.map(r => r.network))].sort();
  const fx = fixtureSha256(rs), sha = requestSha256({ adapterId: src, evidenceKind: 'SYNTHETIC', networks, fixtureSha256: fx });
  const run = (await x.si_collector.query('SELECT * FROM si.si_begin_run_scoped($1,$2,$3,$4,$5::text[],$6)',
    [src, `ak${++n}`, sha, 'SYNTHETIC', networks, fx])).rows[0];
  await x.si_collector.query('BEGIN');
  try { await x.si_collector.query('SELECT * FROM si.si_complete_run($1::uuid, $2::uuid, $3::jsonb)', [run.run_id, run.lease_token, JSON.stringify(rs)]);
        await x.si_collector.query('COMMIT'); }
  catch (e) { await x.si_collector.query('ROLLBACK').catch(() => {}); throw e; }
  return run;
}
/** A ready source with `k` verified records and a grant for alice. */
async function ready(x, k = 3, o = {}) {
  const src = `au-${++n}`;
  await createSources(x.admin, [src], ['META', 'TIKTOK']);
  await recordRights(x.si_rights_admin, src, {});
  const run = await collect(x, src, o.rows ?? rows(k));
  await x.si_monitor.query('SELECT * FROM si.si_verify_receipts(500)');
  await grantReader(x.si_rights_admin, 'si_reader_alice', src, 'internal synthetic evaluation (test)');
  return { src, run };
}
const BEGIN_READ = 'SELECT si.si_begin_read($1, $2, $3) AS id';
const READ = 'SELECT * FROM si.si_read_evidence($1, $2, $3, $4)';
const intent = async (c, src, cursor = null, limit = 100) => (await c.query(BEGIN_READ, [src, cursor, limit])).rows[0].id;
const readWith = async (c, src, id, cursor = null, limit = 100) => (await c.query(READ, [src, id, cursor, limit])).rows;
const intents = async x => (await x.admin.query(`SELECT intent_id, principal, source_id, cursor_sha256, read_limit, state, rows_returned,
                                                        bytes_returned, pg_xact_status(created_xid) AS xact FROM si.read_intents ORDER BY created_at`)).rows;
async function replica(x, sql, params) {
  await x.admin.query('BEGIN');
  try { await x.admin.query('SET LOCAL session_replication_role = replica'); await x.admin.query(sql, params); await x.admin.query('COMMIT'); }
  catch (e) { await x.admin.query('ROLLBACK').catch(() => {}); throw e; }
}
const INVALID = { code: '42501', message: /^SI_READ_INTENT_INVALID: no matching read intent$/ };
const UNCOMMITTED = { code: '55000', message: /^SI_READ_INTENT_UNCOMMITTED/ };
const USED = { code: '55000', message: /^SI_READ_INTENT_USED/ };
const NOT_AUTH = { code: '42501', message: /^SI_READ_NOT_AUTHORIZED: not authorized$/ };
const sha = s => createHash('sha256').update(s, 'utf8').digest('hex');

// ------------------------------------------------------------------------------------------------
test('AUD-1: a read commits a scoped intent first; the read consumes it; the completion names it; nothing content-bearing is stored', async t => {
  const x = await fresh(t);
  const { src } = await ready(x, 3);
  const alice = await x.connect('si_reader_alice');
  const first = await readEvidence(alice, src, { limit: 2 });
  const second = await readEvidence(alice, src, { cursor: first.nextCursor, limit: 2 });
  assert.deepEqual([first.records.length, second.records.length], [2, 1]);
  const got = await intents(x);
  assert.deepEqual(got.map(i => [i.intent_id, i.principal, i.source_id, i.cursor_sha256, i.read_limit, i.state, i.rows_returned, i.xact]),
    [[first.intentId, 'si_reader_alice', src, null, 2, 'CONSUMED', 2, 'committed'],
     [second.intentId, 'si_reader_alice', src, sha(first.nextCursor), 2, 'CONSUMED', 1, 'committed']],
    'one committed intent per page, bound to the login and the exact scope (the cursor only as a digest)');
  const log = (await x.admin.query('SELECT intent_id, rows_returned FROM si.reader_access_log ORDER BY access_id')).rows;
  assert.deepEqual(log, [{ intent_id: first.intentId, rows_returned: 2 }, { intent_id: second.intentId, rows_returned: 1 }]);
  const stored = JSON.stringify((await x.admin.query('SELECT * FROM si.read_intents')).rows);
  for (const r of [...first.records, ...second.records]) {
    for (const v of [r.nativeAdId, r.sourceUrl, r.advertiserName, r.title, r.runId]) assert.ok(!stored.includes(v), 'intents are content-free');
  }
  assert.ok(!stored.includes(first.nextCursor), 'the cursor itself is not stored');
});

test('AUD-2 (A1 regression, REQUEST audit only): a caller rollback cannot erase the committed request record; the release itself is NOT recorded', async t => {
  const x = await fresh(t);
  const { src } = await ready(x, 3);
  const alice = await x.connect('si_reader_alice');
  // The 0008 weakness: BEGIN; read; ROLLBACK. Now the read needs a committed intent, which the rollback cannot touch.
  const id = await intent(alice, src);                                           // autocommit: committed
  await alice.query('BEGIN');
  const got = await readWith(alice, src, id);
  await alice.query('ROLLBACK');
  assert.equal(got.length, 3, 'the reader received records');
  const after = await intents(x);
  assert.deepEqual(after.map(i => [i.intent_id, i.principal, i.source_id, i.state, i.xact]), [[id, 'si_reader_alice', src, 'OPEN', 'committed']],
    'the committed intent survives the rollback (state OPEN = requested, outcome unknown)');
  // Limitation asserted, not hidden: the records that rows were RELEASED (consumption, completion row) rolled back.
  // This test proves a request record, not disclosure accounting (rollback-resistant release accounting: NOT IMPLEMENTED).
  assert.equal((await x.admin.query('SELECT count(*)::int AS n FROM si.reader_access_log')).rows[0].n, 0, 'the release record rolled back with the caller');
  assert.equal(after[0].state, 'OPEN', 'no record that 3 rows were released');
  // Through the library inside a caller transaction: the intent is uncommitted, so nothing is returned at all.
  await alice.query('BEGIN');
  const err = await readEvidence(alice, src).catch(e => e);
  await alice.query('ROLLBACK');
  assert.ok(err instanceof ReadFailed);
  assert.equal(err.code, 'INTENT_UNCOMMITTED', 'a read inside a caller transaction never releases evidence');
  // Invariant over the whole test: every record ever released was covered by a committed intent of that login and scope.
  const all = await intents(x);
  assert.ok(all.every(i => i.xact === 'committed'));
  assert.equal(all.length, 1, 'the uncommitted intent left nothing behind and released nothing');
});

test('AUD-3: a failed or uncertain audit commit returns no evidence', async t => {
  const x = await fresh(t);
  const { src } = await ready(x, 2);
  const alice = await x.connect('si_reader_alice'), alice2 = await x.connect('si_reader_alice');
  // (a) the intent's own, still open transaction: refused.
  await alice.query('BEGIN');
  const id = await intent(alice, src);
  await rejects(assert, readWith(alice, src, id), UNCOMMITTED);
  await alice.query('ROLLBACK');
  // (b) uncommitted in another session: refused (since 0010 the id names its transaction, still in progress);
  // after its rollback the intent never existed.
  await alice.query('BEGIN');
  const id2 = await intent(alice, src);
  await rejects(assert, readWith(alice2, src, id2), UNCOMMITTED);
  await alice.query('ROLLBACK');
  await rejects(assert, readWith(alice2, src, id2), INVALID);
  await rejects(assert, readWith(alice, src, id), INVALID);
  // (c) COMMIT itself fails (superuser fixture: a deferred trigger that raises at commit). The library sends no read.
  await x.admin.query(`CREATE FUNCTION si.test_fail_commit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'TEST_COMMIT_FAILURE'; END$$`);
  await x.admin.query(`CREATE CONSTRAINT TRIGGER test_fail_commit AFTER INSERT ON si.read_intents DEFERRABLE INITIALLY DEFERRED
                       FOR EACH ROW EXECUTE FUNCTION si.test_fail_commit()`);
  const sent = [];
  const spy = { query: (sql, p) => { sent.push(sql); return alice2.query(sql, p); } };
  const err = await readEvidence(spy, src).catch(e => e);
  assert.ok(err instanceof ReadFailed && err.intentId === null, `commit failure is a read failure with no intent (${err.code})`);
  assert.deepEqual(sent, ['SELECT si.si_begin_read($1, $2, $3::int) AS id'], 'the read was never sent');
  await x.admin.query('DROP TRIGGER test_fail_commit ON si.read_intents');
  // (d) the outcome of the intent is unknown to the caller: the library reads only with an id it received.
  assert.deepEqual((await intents(x)).length, 0, 'no intent from (a)-(c) exists');
  assert.equal((await x.admin.query('SELECT count(*)::int AS n FROM si.reader_access_log')).rows[0].n, 0, 'and nothing was read');
});

test('AUD-4: mismatched identity or scope, missing, used and expired intents are refused', async t => {
  const x = await fresh(t);
  const { src } = await ready(x, 3);
  const other = await ready(x, 1);
  await grantReader(x.si_rights_admin, 'si_reader_bob', src, 'second reader');
  const alice = await x.connect('si_reader_alice'), bob = await x.connect('si_reader_bob');
  const id = await intent(alice, src, null, 100);
  const cursor = (await readEvidence(alice, src, { limit: 1 })).nextCursor;
  await rejects(assert, readWith(bob, src, id), INVALID, 'another principal (with its own grant) cannot use it');
  await rejects(assert, readWith(alice, other.src, id), INVALID, 'another source');
  await rejects(assert, readWith(alice, src, id, null, 99), INVALID, 'another limit');
  await rejects(assert, readWith(alice, src, id, cursor, 100), INVALID, 'another cursor');
  await rejects(assert, readWith(alice, src, null), INVALID, 'no intent');
  await rejects(assert, readWith(alice, src, '00000000-0000-4000-8000-000000000000'), INVALID, 'unknown intent');
  // SET ROLE cannot borrow an intent: identity is the login.
  const a = await connect();
  t.after(() => a.end());
  await a.query('GRANT si_reader_alice TO si_reader_carol');
  try {
    const carol = await x.connect('si_reader_carol');
    await carol.query('SET ROLE si_reader_alice');
    await rejects(assert, readWith(carol, src, id), INVALID, 'the login is carol even after SET ROLE: alice\'s intent is not hers');
  } finally { await a.query('REVOKE si_reader_alice FROM si_reader_carol'); }
  assert.equal((await readWith(alice, src, id)).length, 3, 'the owner of the intent reads its exact scope');
  await rejects(assert, readWith(alice, src, id), USED, 'single use once consumed');
  const old = await intent(alice, src);
  await replica(x, `UPDATE si.read_intents SET created_at = created_at - interval '2 minutes', expires_at = expires_at - interval '2 minutes'
                    WHERE intent_id = $1`, [old]);                                // superuser fixture: age the intent
  await rejects(assert, readWith(alice, src, old), { code: '55000', message: /^SI_READ_INTENT_EXPIRED/ });
  for (const bad of [['UPDATE si.read_intents SET read_limit = 1'], ['UPDATE si.read_intents SET principal = $1', ['si_reader_bob']],
                     ["UPDATE si.read_intents SET state = 'OPEN'"], ['DELETE FROM si.read_intents'], ['TRUNCATE si.read_intents']]) {
    await rejects(assert, asOwner(x.admin, c => c.query(...bad)), { code: '23514', message: /^SI_READ_INTENT_IMMUTABLE/ });
  }
});

test('AUD-5: revocation, controls, rights and retention changes between the intent and the read are enforced at retrieval', async t => {
  const x = await fresh(t);
  const alice = await x.connect('si_reader_alice');
  const cases = {};
  for (const k of ['revoked', 'suspended', 'terminated', 'rightsDenied', 'expired', 'ok']) cases[k] = await ready(x, 2);
  const ids = {};
  for (const [k, v] of Object.entries(cases)) ids[k] = await intent(alice, v.src);  // all committed while fully authorized
  await revokeReader(x.si_rights_admin, 'si_reader_alice', cases.revoked.src, 'revoked between intent and read');
  await control(x.si_rights_admin, cases.suspended.src, 'SUSPEND');
  await control(x.si_rights_admin, cases.terminated.src, 'TERMINATE_RETENTION');
  await recordRights(x.si_rights_admin, cases.rightsDenied.src, { retain: 'DENIED' });
  await replica(x, `UPDATE si.collection_runs SET retain_until = clock_timestamp() - interval '1 minute' WHERE run_id = $1`, [cases.expired.run.run_id]);
  await rejects(assert, readWith(alice, cases.revoked.src, ids.revoked), NOT_AUTH, 'a committed intent does not override revocation');
  const got = {};
  for (const k of ['suspended', 'terminated', 'rightsDenied', 'expired', 'ok']) got[k] = (await readWith(alice, cases[k].src, ids[k])).length;
  assert.deepEqual(got, { suspended: 0, terminated: 0, rightsDenied: 0, expired: 0, ok: 2 });
  const states = Object.fromEntries((await intents(x)).map(i => [i.intent_id, `${i.state}/${i.rows_returned ?? '-'}`]));
  assert.equal(states[ids.revoked], 'OPEN/-', 'the refused attempt stays on record as a committed, authorized request');
  assert.equal(states[ids.suspended], 'CONSUMED/0');
  await lift(x.si_rights_admin, cases.suspended.src);
  await rejects(assert, readWith(alice, cases.suspended.src, ids.suspended), USED, 'LIFT does not revive a consumed intent');
  assert.equal((await readEvidence(alice, cases.suspended.src)).records.length, 2, 'a new intent after LIFT reads');
});

test('AUD-6: retries — a failed read keeps its committed intent for a retry of the same scope; a consumed intent is final', async t => {
  const x = await fresh(t);
  const { src } = await ready(x, 2);
  const alice = await x.connect('si_reader_alice'), ra = await x.connect('si_rights_admin');
  // BUSY: an emergency control in progress holds the source past the 2 s bound.
  await ra.query('BEGIN');
  await control(ra, src, 'SUSPEND');
  const busy = await readEvidence(alice, src).catch(e => e);
  await ra.query('ROLLBACK');
  assert.deepEqual([busy.code, busy.retryable], ['BUSY', true]);
  assert.equal((await intents(x))[0].state, 'OPEN', 'the intent is still open after BUSY');
  const retried = await readEvidence(alice, src, { intentId: busy.intentId });
  assert.deepEqual([retried.records.length, retried.intentId], [2, busy.intentId], 'retry with the same intent, no new intent');
  const again = await readEvidence(alice, src, { intentId: busy.intentId }).catch(e => e);
  assert.deepEqual([again.code, again.retryable], ['INTENT_USED', false]);
  // Connection lost after the intent committed: a new session of the same login may retry it.
  const lost = await x.connect('si_reader_alice');
  const id = await intent(lost, src);
  await x.admin.query('SELECT pg_terminate_backend($1)', [await pid(lost)]);
  const fresh2 = await x.connect('si_reader_alice');
  assert.equal((await readWith(fresh2, src, id)).length, 2);
  // A retry must carry the same scope.
  const id3 = await intent(alice, src, null, 5);
  await rejects(assert, readWith(alice, src, id3, null, 6), INVALID);
  assert.equal((await readWith(alice, src, id3, null, 5)).length, 2);
  const all = await intents(x);
  assert.equal(all.length, 3, 'three requests on record: BUSY+retry share one, the lost connection one, the scoped one');
  assert.ok(all.every(i => i.state === 'CONSUMED' && i.xact === 'committed'));
});

test('AUD-7: concurrent requests — exactly one committed consumption per intent; a rolled-back consumer frees it', async t => {
  const x = await fresh(t);
  const { src } = await ready(x, 2);
  const a1 = await x.connect('si_reader_alice'), a2 = await x.connect('si_reader_alice');
  // Since 0010 a second session on the same intent cannot release anything while the first consumer's
  // transaction is open: that transaction's WAL is unflushed, so the second read fails closed in the
  // durability gate (or, once the first commits, finds the intent consumed). It never waits on the row lock.
  const id = await intent(a1, src);
  await a1.query('BEGIN');
  assert.equal((await readWith(a1, src, id)).length, 2, 'first consumer, not yet committed');
  const s = await settle(readWith(a2, src, id));
  assert.deepEqual([s.status, s.code], ['db-error', '55000']);
  assert.match(s.message, /^SI_READ_INTENT_(NOT_DURABLE|USED)/, 'the second consumer releases nothing while the first is open');
  await a1.query('COMMIT');
  await rejects(assert, readWith(a2, src, id), USED, 'after the first consumer committed, the intent is consumed');
  const id2 = await intent(a1, src);
  await a1.query('BEGIN');
  await readWith(a1, src, id2);
  const third = settle(readWith(a2, src, id2));
  await sleep(200);
  await a1.query('ROLLBACK');                                                    // the abort is flushed by the WAL writer
  assert.equal((await third).value?.length, 2, 'after the first consumer rolled back, the waiting retry consumes the intent');
  // Many sessions race on one intent in autocommit: exactly one releases evidence.
  const id3 = await intent(a1, src);
  const racers = await Promise.all(Array.from({ length: 6 }, () => x.connect('si_reader_alice')));
  const results = await Promise.all(racers.map(c => settle(readWith(c, src, id3))));
  assert.equal(results.filter(r => r.status === 'ok').length, 1, 'exactly one winner');
  assert.ok(results.filter(r => r.status !== 'ok').every(r => /^SI_READ_INTENT_USED|^SI_READ_BUSY/.test(r.message)));
  // Independent intents of the same login read concurrently.
  const many = await Promise.all(racers.map(async c => (await readEvidence(c, src)).records.length));
  assert.deepEqual(many, [2, 2, 2, 2, 2, 2]);
  const states = (await intents(x)).map(i => i.state);
  assert.ok(states.every(st => st === 'CONSUMED'), 'every committed intent was consumed exactly once');
});

test('AUD-8: no reader entry point returns evidence without a committed intent; intents are owner-only and append-only', async t => {
  const x = await fresh(t);
  const { src } = await ready(x, 1);
  const fns = (await x.admin.query(`SELECT p.oid::regprocedure::text AS f, p.prorettype::regtype::text AS r FROM pg_proc p
                                     WHERE p.pronamespace = 'si'::regnamespace AND has_function_privilege('si_reader', p.oid, 'EXECUTE') ORDER BY 1`)).rows;
  assert.deepEqual(fns, [{ f: 'si.si_begin_read(text,text,integer)', r: 'uuid' }, { f: 'si.si_read_evidence(text,uuid,text,integer)', r: 'si.evidence_read_row' }]);
  const evidenceReturning = (await x.admin.query(`SELECT p.oid::regprocedure::text AS f FROM pg_proc p
                                                  WHERE p.prorettype = 'si.evidence_read_row'::regtype`)).rows.map(r => r.f);
  assert.deepEqual(evidenceReturning, ['si.si_read_evidence(text,uuid,text,integer)'], 'the 0008 three-argument read no longer exists');
  const alice = await x.connect('si_reader_alice');
  await rejects(assert, alice.query(`SELECT * FROM si.si_read_evidence($1, NULL, 100)`, [src]), { code: '42883' }, 'the old signature is gone');
  for (const sql of ['SELECT 1 FROM si.read_intents', `INSERT INTO si.read_intents (intent_id) VALUES (gen_random_uuid())`,
                     'UPDATE si.read_intents SET state = state', 'DELETE FROM si.read_intents']) {
    await rejects(assert, alice.query(sql), { code: '42501' });
  }
  for (const role of ['si_collector', 'si_rights_admin', 'si_retention']) {
    await rejects(assert, x[role].query('SELECT 1 FROM si.read_intents'), { code: '42501' });
    await rejects(assert, x[role].query(BEGIN_READ, [src, null, 1]), { code: '42501' });
  }
  for (const sql of ['INSERT INTO si.read_intents (intent_id) VALUES (gen_random_uuid())', 'DELETE FROM si.read_intents']) {
    await rejects(assert, x.si_monitor.query(sql), { code: '42501' });
  }
  assert.equal((await x.si_monitor.query('SELECT count(*)::int AS n FROM si.read_intents')).rows[0].n, 0, 'the monitor sees intents');
  // A direct owner INSERT gets server-set identity (the owner is not a reader principal: refused by the CHECK).
  await rejects(assert, asOwner(x.admin, c => c.query(`INSERT INTO si.read_intents (intent_id, principal, source_id, read_limit, created_at, expires_at, created_xid, state)
      VALUES (gen_random_uuid(), 'si_reader_alice', $1, 1, now(), now() + interval '60 seconds', '1', 'OPEN')`, [src])), { code: '23514' });
});

test('AUD-9 (gates): intents never hold the source; emergency controls stay fast while intents are open', async t => {
  const x = await fresh(t);
  const { src } = await ready(x, 20);
  const alice = await x.connect('si_reader_alice'), ra = await x.connect('si_rights_admin');
  await alice.query('BEGIN');
  await intent(alice, src);                                                       // an intent transaction left open
  const t0 = performance.now();
  await control(ra, src, 'SUSPEND');
  const wait = performance.now() - t0;
  await alice.query('ROLLBACK');
  await lift(ra, src);
  const readers = await Promise.all(Array.from({ length: 4 }, () => x.connect('si_reader_alice')));
  let stop = false, reads = 0;
  const loops = readers.map(async c => { while (!stop) { await readEvidence(c, src).catch(() => {}); reads++; } });
  await sleep(200);
  const waits = [];
  for (const kind of ['SUSPEND', 'TERMINATE_RETENTION']) { const s = performance.now(); await control(ra, src, kind); waits.push(performance.now() - s); }
  stop = true; await Promise.all(loops);
  console.log(`# AUD-9 control with an open intent transaction: ${wait.toFixed(0)} ms; under ${reads} concurrent two-step reads: ${waits.map(w => w.toFixed(0)).join(' / ')} ms`);
  assert.ok(wait < 1000, 'an open intent transaction does not lock the source');
  assert.ok(Math.max(...waits) < 2000, 'emergency controls stay fast under concurrent two-step reads');
});

test('AUD-10: unsafe sessions and isolation are refused at the intent; no evidence value reaches intents or the server log', async t => {
  const x = await fresh(t);
  const mark = `CANARY${randomBytes(8).toString('hex')}`;
  const { src } = await ready(x, 1, { rows: [ROW(mark, { title: mark, advertiserName: mark, sourceUrl: `https://example.test/${mark}` })] });
  const alice = await x.connect('si_reader_alice');
  await alice.query(`SET synchronous_commit = off`);
  await rejects(assert, intent(alice, src), { code: '55000', message: /^SI_READ_UNSAFE_SESSION: synchronous_commit$/ }, 'an intent must be durable before it is visible');
  await alice.query('RESET synchronous_commit');
  await alice.query(`SET statement_timeout = 0`);
  await rejects(assert, intent(alice, src), { code: '55000', message: /^SI_READ_UNSAFE_SESSION: statement_timeout$/ });
  await alice.query('RESET statement_timeout');
  await alice.query(`SET default_transaction_isolation = 'repeatable read'`);
  await rejects(assert, intent(alice, src), { code: '25000', message: /^SI_ISOLATION/ });
  await alice.query('RESET default_transaction_isolation');
  await rejects(assert, intent(alice, src, `v1|other-src|x`), { code: '22023', message: /^SI_READ_BAD_CURSOR/ });
  await rejects(assert, intent(alice, src, null, 101), { code: '22023', message: /^SI_READ_BAD_ARGUMENT/ });
  const page = await readEvidence(alice, src);
  assert.equal(page.records[0].nativeAdId, mark);
  assert.equal((await intents(x)).length, 1, 'refused intents record nothing');
  await sleep(200);
  const r = spawnSync('docker', ['compose', 'logs', '--no-color', 'db'], { cwd: REPO, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  assert.equal(r.status, 0);
  const texts = [r.stdout + r.stderr, JSON.stringify((await x.admin.query('SELECT * FROM si.read_intents')).rows)];
  assert.ok(!texts.some(s => s.includes(mark)), 'no evidence value in the server log or the intents');
});

test('AUD-11: down 0009 with intents and completion rows present restores the exact 0008 catalog; up re-applies; reads work again', async t => {
  const x = await fresh(t);
  const { src } = await ready(x, 2);
  const alice = await x.connect('si_reader_alice');
  await readEvidence(alice, src);
  await intent(alice, src);                                                       // one left OPEN
  const at9 = await schemaFingerprint(x.admin);
  const ref = await freshDatabase(t, 'm3aud8', { migrate: false });
  const refc = await connect({ database: ref }); t.after(() => refc.end());
  await migrateUp(refc, { to: 8 });
  assert.deepEqual(await migrateDown(x.admin, { to: 8, allowDestructive: true }), [10, 9]);
  const norm = f => f.replaceAll('"relacl":"{si_owner=arwdDxt/si_owner}"', '"relacl":null');    // equivalent ACL spelling after restore (DR-1)
  assert.equal(norm(await schemaFingerprint(x.admin)), norm(await schemaFingerprint(refc)), 'exact 0008 catalog with 0009 data present before down');
  assert.equal((await x.admin.query('SELECT count(*)::int AS n FROM si.reader_access_log')).rows[0].n, 1, 'completion rows are kept (without the intent column)');
  assert.deepEqual(await migrateUp(x.admin), [9, 10]);
  assert.equal(norm(await schemaFingerprint(x.admin)), norm(at9));
  assert.equal((await readEvidence(await x.connect('si_reader_alice'), src)).records.length, 2, 'reads work after the round trip');
});

// ------------------------------------------------------------------------------------------------
// Negative-control mutants of the 0009 read (each must be detected; the unmutated read passes).
function fnText(mig, startMarker, endMarker) {
  const s = mig.indexOf(startMarker);
  return mig.slice(s, mig.indexOf(endMarker, s) + endMarker.length).replace(/^CREATE FUNCTION/, 'CREATE OR REPLACE FUNCTION');
}
function mutate(text, from, to) {
  assert.equal(text.split(from).length, 2, `exactly one anchor: ${from.slice(0, 60)}`);
  return text.replace(from, to);
}
const READ_FN = fnText(MIG10, 'CREATE OR REPLACE FUNCTION si.si_read_evidence', 'END $read_evidence$;');
const ok = async p => { const r = await settle(p); return r.status === 'ok' && r.value.length > 0; };
const MUTANTS = [
  { name: 'committed-intent check omitted', sql: mutate(READ_FN, `  IF st <> 'committed' THEN`, '  IF false THEN'),
    scenario: async x => {                                          // detected = a read in the intent's own open transaction releases evidence
      const { src } = await ready(x, 1);
      const alice = await x.connect('si_reader_alice');
      await x.admin.query('CREATE TABLE IF NOT EXISTS public.flushme (x int)');
      await alice.query('BEGIN');
      const id = await intent(alice, src);
      await x.admin.query('INSERT INTO public.flushme VALUES (1)');   // a synchronous commit flushes the WAL (so the durability gate alone does not mask the mutant)
      const leaked = await ok(readWith(alice, src, id));
      await alice.query('ROLLBACK');
      return leaked;
    } },
  { name: 'principal binding omitted', sql: mutate(READ_FN, 'it.principal IS NULL OR it.principal IS DISTINCT FROM who OR ', 'it.principal IS NULL OR '),
    scenario: async x => {                                          // detected = bob reads with alice's intent
      const { src } = await ready(x, 1);
      await grantReader(x.si_rights_admin, 'si_reader_bob', src, 'second reader');
      const id = await intent(await x.connect('si_reader_alice'), src);
      return ok(readWith(await x.connect('si_reader_bob'), src, id));
    } },
  { name: 'scope binding omitted', sql: mutate(READ_FN, `
     OR it.read_limit IS DISTINCT FROM p_limit OR it.cursor_sha256 IS DISTINCT FROM si.si_read_cursor_digest(p_cursor)`, ''),
    scenario: async x => {                                          // detected = an intent for one record releases a page of 100
      const { src } = await ready(x, 3);
      const alice = await x.connect('si_reader_alice');
      const r = await settle(readWith(alice, src, await intent(alice, src, null, 1), null, 100));
      return r.status === 'ok' && r.value.length > 1;
    } },
  { name: 'consumption omitted', sql: mutate(READ_FN, `
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SI_READ_INTENT_USED: the read intent was already used' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;`, '').replace(`WHERE i.intent_id = p_intent_id AND i.state = 'OPEN';`, `WHERE false;`),
    scenario: async x => {                                          // detected = one committed intent releases evidence twice
      const { src } = await ready(x, 1);
      const alice = await x.connect('si_reader_alice');
      const id = await intent(alice, src);
      return (await ok(readWith(alice, src, id))) && ok(readWith(alice, src, id));
    } }
];
for (const m of MUTANTS) {
  test(`AUD-M (${m.name}): the baseline passes the scenario and the targeted mutant is detected`, async t => {
    const bx = await fresh(t, 'm3audb');
    const base = await m.scenario(bx);
    const x = await fresh(t, 'm3audm');
    await asOwner(x.admin, a => a.query(m.sql));
    const killed = await m.scenario(x);
    console.log(`# AUD-M ${m.name}: baseline ${base ? 'DETECTED (unexpected)' : 'clean'}, mutant ${killed ? 'KILLED' : 'SURVIVED'}`);
    assert.equal(base, false, `${m.name}: the unmutated code passes`);
    assert.equal(killed, true, `${m.name}: the mutant is detected`);
  });
}

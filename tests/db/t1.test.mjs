// Milestone 2 step 2: T1 preflight (si.si_begin_run), the request-key lock and trg_runs_insert.
// Concurrency order is established by construction (a holder keeps its locks in an open
// transaction; waiters are proven blocked with pg_blocking_pids). No assertion uses clocks
// for correctness. Step-2 shortcuts (owner UPDATEs that expire a lease or mark a run
// COMPLETED) stand in for step 3/4 paths that do not exist yet; they are labelled.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { t1Preflight, T1Refused } from '../../dist/persistence/runs.js';
import {
  asOwner, control, createSources, expectWaiterError, expectWaiterOk, freshDatabase, holderCommit, lift, pid,
  recordRights, rejects, roles, settle, waitUntilBlocked, waiter
} from './helpers.mjs';

const CHECK = '23514', DENIED = '42501', ISO = '25000';
let db, c;
const cleanups = [];
const fileScope = { after: fn => cleanups.push(fn) };
test.before(async () => {
  db = await freshDatabase(fileScope, 't1');
  c = await roles(fileScope, db, ['admin', 'si_rights_admin', 'si_collector', 'si_retention', 'si_monitor']);
});
test.after(async () => { for (const fn of cleanups.reverse()) await fn(); });

const one = async (cl, sql, params = []) => (await cl.query(sql, params)).rows[0];
const SHA = ch => ch.repeat(64);
let keyN = 0;
const newKey = () => `key-${++keyN}`;
/** Raw T1 call (autocommit unless the caller opened a transaction). */
const begin = (cl, src, key, o = {}) => cl.query('SELECT * FROM si.si_begin_run($1, $2, $3, $4, $5::text[])',
  [src, key, o.sha ?? SHA('a'), o.evidenceKind ?? 'SYNTHETIC', o.networks ?? ['META']]).then(r => r.rows[0]);
const runs = async (src, key) => (await c.admin.query(
  'SELECT * FROM si.collection_runs WHERE source_id = $1 AND request_key = $2 ORDER BY attempt', [src, key])).rows;
const vid = async (src, n) => (await one(c.admin, 'SELECT rights_version_id AS id FROM si.rights_versions WHERE source_id = $1 AND version = $2', [src, n])).id;
async function source(id, { networks = ['META'], rights = {} } = {}) {
  await createSources(c.admin, [id], networks);
  if (rights !== null) await recordRights(c.si_rights_admin, id, rights);
}
// Step-2 shortcuts (owner-only; replaced by step 3/4 paths later).
const expireLease = runId => asOwner(c.admin, x => x.query(
  `UPDATE si.collection_runs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE run_id = $1`, [runId]));
const markEmptyCompleted = runId => asOwner(c.admin, x => x.query(
  `UPDATE si.collection_runs SET status = 'COMPLETED', finished_at = clock_timestamp(), rights_checked_at = clock_timestamp(),
     retention_state = 'EMPTY', publish_control_seq = start_control_seq, lease_token = NULL WHERE run_id = $1`, [runId]));
async function extra(t, role) { const cl = (await roles(t, db, [role]))[role]; return { cl, p: await pid(cl) }; }
async function ownerSession(t) {
  const cl = (await roles(t, db, ['admin'])).admin;
  return { cl, p: await pid(cl) };
}

// ---------------------------------------------------------------------------------------
// Decision and computed fields
// ---------------------------------------------------------------------------------------

test('T1-1: a RUNNING attempt gets a database-chosen lease, current rights, start_control_seq and the policy snapshot', async () => {
  await source('t1-ok');
  await c.admin.query(`UPDATE si.sources SET conflict_policy = 'KEEP_FIRST' WHERE source_id = 't1-ok'`);
  await control(c.si_rights_admin, 't1-ok', 'SUSPEND');
  await lift(c.si_rights_admin, 't1-ok');                                                        // control_seq now 2
  const r = await begin(c.si_collector, 't1-ok', 'k1');
  assert.equal(r.outcome, 'RUNNING');
  assert.equal(r.attempt, 1);
  assert.equal(r.rights_version_id, await vid('t1-ok', 1));
  assert.equal(r.start_control_seq, 2);
  assert.match(r.lease_token, /^[0-9a-f-]{36}$/);
  const row = await one(c.admin, `SELECT conflict_policy, lease_expires_at - started_at = interval '5 minutes' AS lease, finished_at, received_count
                                  FROM si.collection_runs WHERE run_id = $1`, [r.run_id]);
  assert.equal(row.conflict_policy, 'KEEP_FIRST', 'snapshot of the source policy');
  assert.equal(row.lease, true, 'lease = started_at + 5 minutes');
  assert.equal(row.finished_at, null);
});

test('T1-2: REJECTED codes, in the documented order (2.1 failure table, Q2, A11)', async () => {
  const code = async (src, o = {}) => { const r = await begin(c.si_collector, src, newKey(), o); return r.outcome === 'REJECTED' ? r.outcome_code : r.outcome; };
  await source('t2-none', { rights: null });
  assert.equal(await code('t2-none'), 'NO_RIGHTS');
  assert.equal((await runs('t2-none', `key-${keyN}`))[0].rights_version_id, null, 'NO_RIGHTS has no version');

  await source('t2-ret');
  await c.si_rights_admin.query(`UPDATE si.sources SET retired_at = clock_timestamp() + interval '2 minutes' WHERE source_id = 't2-ret'`);
  assert.equal(await code('t2-ret'), 'SOURCE_RETIRED', 'retirement inside margin + lease');
  await source('t2-ret-far');
  await c.si_rights_admin.query(`UPDATE si.sources SET retired_at = clock_timestamp() + interval '1 hour' WHERE source_id = 't2-ret-far'`);
  assert.equal(await code('t2-ret-far'), 'RUNNING');

  await source('t2-scope');
  assert.equal(await code('t2-scope', { evidenceKind: 'LICENSED', networks: ['GOOGLE'] }), 'EVIDENCE_KIND_MISMATCH', 'evidence before network');
  assert.equal(await code('t2-scope', { networks: ['META', 'GOOGLE'] }), 'NETWORK_SCOPE_MISMATCH');

  await source('t2-eval', { rights: { evaluation: 'DENIED' } });
  assert.equal(await code('t2-eval'), 'EVALUATION_NOT_ALLOWED');
  await source('t2-retain', { rights: { retain: 'UNKNOWN', retention_days: null } });
  assert.equal(await code('t2-retain'), 'RETAIN_NOT_ALLOWED', 'B-001 demo rights are rejected');

  await source('t2-exp', { rights: { expires_at_sql: `clock_timestamp() + interval '1 second'` } });
  assert.equal(await code('t2-exp'), 'RIGHTS_EXPIRING');
  await sleep(1200);
  assert.equal(await code('t2-exp'), 'RIGHTS_EXPIRED');

  await source('t2-a11-near', { rights: { expires_at_sql: `clock_timestamp() + interval '4 minutes'` } });
  assert.equal(await code('t2-a11-near'), 'RIGHTS_EXPIRING', 'A11: window inside 60 s + 5 min lease');
  await source('t2-a11-far', { rights: { expires_at_sql: `clock_timestamp() + interval '10 minutes'` } });
  assert.equal(await code('t2-a11-far'), 'RUNNING');

  await source('t2-next');
  await recordRights(c.si_rights_admin, 't2-next', { effective_from_sql: `clock_timestamp() + interval '3 minutes'` });
  assert.equal(await code('t2-next'), 'RIGHTS_EXPIRING', 'a scheduled successor ends the window');
  const r = await runs('t2-next', `key-${keyN}`);
  assert.equal(r[0].rights_version_id, await vid('t2-next', 1), 'the scheduled version is not current');

  await source('t2-prec', { rights: { evaluation: 'DENIED' } });
  await c.si_rights_admin.query(`UPDATE si.sources SET retired_at = clock_timestamp() WHERE source_id = 't2-prec'`);
  assert.equal(await code('t2-prec'), 'SOURCE_RETIRED', 'retirement takes precedence over evaluation');
});

test('T1-2b: RIGHTS_TERMINATED — after a recovery LIFT, before the new authorization takes effect', async () => {
  await source('t2-term');
  const t = await control(c.si_rights_admin, 't2-term', 'TERMINATE_RETENTION');
  await recordRights(c.si_rights_admin, 't2-term', { effective_from_sql: `clock_timestamp() + interval '1 hour'` });
  await lift(c.si_rights_admin, 't2-term', { ackTerminationSeq: t.control_seq, authorizationVersion: 2 });
  const key = newKey();
  const r = await begin(c.si_collector, 't2-term', key);
  assert.deepEqual([r.outcome, r.outcome_code, r.rights_version_id], ['REJECTED', 'RIGHTS_TERMINATED', await vid('t2-term', 1)]);
  assert.equal((await runs('t2-term', key)).length, 1, 'a RIGHTS_TERMINATED rejection consumes an attempt');
});

test('T1-3 (Q3, CR1): T1 while suspended throws and writes nothing; a termination suspends too; LIFT restores', async () => {
  await source('t3-susp');
  const key = newKey();
  await control(c.si_rights_admin, 't3-susp', 'SUSPEND');
  await rejects(assert, begin(c.si_collector, 't3-susp', key), { code: CHECK, message: /^SI_SOURCE_SUSPENDED/ });
  assert.equal((await runs('t3-susp', key)).length, 0);
  await lift(c.si_rights_admin, 't3-susp');
  assert.equal((await begin(c.si_collector, 't3-susp', key)).attempt, 1, 'no attempt was consumed');
  await source('t3-term');
  await control(c.si_rights_admin, 't3-term', 'TERMINATE_RETENTION');
  await rejects(assert, begin(c.si_collector, 't3-term', newKey()), { code: CHECK, message: /^SI_SOURCE_SUSPENDED/ });
});

// ---------------------------------------------------------------------------------------
// Idempotency, attempts and stale attempts
// ---------------------------------------------------------------------------------------

test('T1-4 (C1, C8, C4/E6): retries re-evaluate rights; a different hash is refused; COMPLETED is returned as is', async () => {
  await source('t4', { rights: { retain: 'UNKNOWN', retention_days: null } });
  const key = newKey();
  const a1 = await begin(c.si_collector, 't4', key);
  assert.deepEqual([a1.outcome, a1.outcome_code], ['REJECTED', 'RETAIN_NOT_ALLOWED']);
  await rejects(assert, begin(c.si_collector, 't4', key, { sha: SHA('b') }), { code: CHECK, message: /^SI_IDEMPOTENCY_KEY_REUSED/ });   // C8
  await recordRights(c.si_rights_admin, 't4');                                                     // v2 allows
  const a2 = await begin(c.si_collector, 't4', key);
  assert.deepEqual([a2.outcome, a2.attempt, a2.rights_version_id], ['RUNNING', 2, await vid('t4', 2)]);
  assert.equal((await runs('t4', key))[0].rights_version_id, await vid('t4', 1), 'attempt 1 keeps the version it was decided under');
  await markEmptyCompleted(a2.run_id);                                                            // step-4 stand-in
  await recordRights(c.si_rights_admin, 't4', { evaluation: 'DENIED', retain: 'DENIED', retention_days: null });
  await control(c.si_rights_admin, 't4', 'SUSPEND');
  const again = await begin(c.si_collector, 't4', key);                                          // row 2 precedes the suspension throw
  assert.deepEqual([again.outcome, again.run_id, again.retention_state, again.lease_token], ['ALREADY_COMPLETED', a2.run_id, 'EMPTY', null]);
  assert.equal((await runs('t4', key)).length, 2, 'no new row');
  await rejects(assert, begin(c.si_collector, 't4', key, { sha: SHA('c') }), { code: CHECK, message: /^SI_IDEMPOTENCY_KEY_REUSED/ });
});

test('T1-5 (C9): the 20-attempt cap, enforced by the function and by the trigger', async () => {
  await source('t5', { rights: { evaluation: 'DENIED' } });
  const key = newKey();
  for (let i = 1; i <= 20; i++) assert.equal((await begin(c.si_collector, 't5', key)).attempt, i);
  await rejects(assert, begin(c.si_collector, 't5', key), { code: CHECK, message: /^SI_ATTEMPT_LIMIT/ });
  assert.equal((await runs('t5', key)).length, 20);
  const direct = (attempt, sha = SHA('a')) => asOwner(c.admin, x => x.query(
    `INSERT INTO si.collection_runs (source_id, request_key, request_sha256, attempt, status, outcome_code, rights_version_id, conflict_policy, start_control_seq)
     VALUES ('t5', $1, $2, $3, 'REJECTED', 'EVALUATION_NOT_ALLOWED', (SELECT rights_version_id FROM si.rights_versions WHERE source_id = 't5'), 'FAIL_RUN', 0)`,
    [key, sha, attempt]));
  await rejects(assert, direct(21), { code: CHECK, message: /^SI_ATTEMPT_LIMIT/ });
  const k2 = newKey();
  await begin(c.si_collector, 't5', k2);
  await rejects(assert, asOwner(c.admin, x => x.query(
    `INSERT INTO si.collection_runs (source_id, request_key, request_sha256, attempt, status, outcome_code, rights_version_id, conflict_policy, start_control_seq)
     VALUES ('t5', $1, $2, 3, 'REJECTED', 'EVALUATION_NOT_ALLOWED', (SELECT rights_version_id FROM si.rights_versions WHERE source_id = 't5'), 'FAIL_RUN', 0)`,
    [k2, SHA('a')])), { code: CHECK, message: /^SI_ATTEMPT_SEQUENCE/ });                           // gap
  await rejects(assert, asOwner(c.admin, x => x.query(
    `INSERT INTO si.collection_runs (source_id, request_key, request_sha256, attempt, status, outcome_code, rights_version_id, conflict_policy, start_control_seq)
     VALUES ('t5', $1, $2, 2, 'REJECTED', 'EVALUATION_NOT_ALLOWED', (SELECT rights_version_id FROM si.rights_versions WHERE source_id = 't5'), 'FAIL_RUN', 0)`,
    [k2, SHA('f')])), { code: CHECK, message: /^SI_IDEMPOTENCY_KEY_REUSED/ });
});

test('T1-6 (C10, EC5): a live attempt blocks; an expired one is failed and replaced; a suspension throw rolls the expiry back', async () => {
  await source('t6');
  const key = newKey();
  const a1 = await begin(c.si_collector, 't6', key);
  await rejects(assert, begin(c.si_collector, 't6', key), { code: CHECK, message: /^SI_RUN_IN_PROGRESS/ });
  await expireLease(a1.run_id);                                                                   // step-3 stand-in
  // EC5: while suspended, the expiry happens inside a transaction that then throws -> rolled back.
  await control(c.si_rights_admin, 't6', 'SUSPEND');
  await rejects(assert, begin(c.si_collector, 't6', key), { code: CHECK, message: /^SI_SOURCE_SUSPENDED/ });
  assert.equal((await runs('t6', key))[0].status, 'RUNNING', 'expiry rolled back with the refused T1');
  await lift(c.si_rights_admin, 't6');
  const a2 = await begin(c.si_collector, 't6', key);
  const [old, cur] = await runs('t6', key);
  assert.deepEqual([old.status, old.outcome_code, old.lease_token === null, old.finished_at !== null], ['FAILED', 'LEASE_EXPIRED', true, true]);
  assert.deepEqual([cur.attempt, cur.status, a2.outcome], [2, 'RUNNING', 'RUNNING']);
});

// ---------------------------------------------------------------------------------------
// Direct SQL
// ---------------------------------------------------------------------------------------

test('DS1: application roles cannot insert runs or call the lock helpers directly', async () => {
  for (const role of ['si_collector', 'si_rights_admin', 'si_retention', 'si_monitor']) {
    await rejects(assert, c[role].query(`INSERT INTO si.collection_runs (source_id, request_key, request_sha256, attempt, status, conflict_policy, start_control_seq)
                                         VALUES ('synthetic-fixture', 'x', '${SHA('a')}', 1, 'RUNNING', 'FAIL_RUN', 0)`), { code: DENIED });
    for (const fn of [`si.si_request_lock_key('a','b')`, `si.si_lock_request_key('a','b')`, `si.si_t1_rights_decision('a', now(), NULL, NULL)`]) {
      await rejects(assert, c[role].query(`SELECT ${fn}`), { code: DENIED });
    }
  }
  for (const role of ['si_rights_admin', 'si_retention', 'si_monitor']) {
    await rejects(assert, begin(c[role], 'synthetic-fixture', newKey()), { code: DENIED });
  }
});

test('DS2: on a direct owner INSERT every computed column is overwritten', async () => {
  await source('ds2');
  const forged = randomUUID();
  await asOwner(c.admin, x => x.query(
    `INSERT INTO si.collection_runs (source_id, request_key, request_sha256, attempt, status, rights_version_id, conflict_policy,
       start_control_seq, lease_token, lease_expires_at, started_at, received_count, published_count, retention_state, publish_control_seq)
     VALUES ('ds2', 'forged', $1, 1, 'RUNNING', (SELECT rights_version_id FROM si.rights_versions WHERE source_id = 'ds2'), 'KEEP_FIRST',
       999, $2, '2099-01-01', '2000-01-01', 5, 0, 'NONE', NULL)`, [SHA('a'), forged]));
  const r = await one(c.admin, `SELECT start_control_seq, lease_token, lease_expires_at < clock_timestamp() + interval '6 minutes' AS lease_ok,
                                       started_at > clock_timestamp() - interval '1 minute' AS fresh, conflict_policy, received_count
                                FROM si.collection_runs WHERE source_id = 'ds2'`);
  assert.equal(r.start_control_seq, 0);
  assert.notEqual(r.lease_token, forged);
  assert.deepEqual([r.lease_ok, r.fresh, r.conflict_policy, r.received_count], [true, true, 'FAIL_RUN', 0]);
});

test('DS3–DS6: direct owner INSERTs obey the T1 rules (status, stale rights, suspension, unknown source)', async () => {
  await source('ds3');
  const ins = (o = {}) => asOwner(c.admin, x => x.query(
    `INSERT INTO si.collection_runs (source_id, request_key, request_sha256, attempt, status, outcome_code, rights_version_id, conflict_policy, start_control_seq,
       finished_at, rights_checked_at, retention_state, publish_control_seq)
     VALUES ($1, $2, $3, 1, $4, $5, $6, 'FAIL_RUN', 0, $7, $8, $9, $10)`,
    [o.source ?? 'ds3', o.key ?? newKey(), SHA('a'), o.status ?? 'RUNNING', o.code ?? null, o.version ?? null,
     o.finished ?? null, o.checked ?? null, o.retention ?? 'NONE', o.seq ?? null]));
  const v1 = await vid('ds3', 1);
  await rejects(assert, ins({ status: 'COMPLETED', version: v1, finished: new Date(), checked: new Date(), retention: 'EMPTY', seq: 0 }), { code: CHECK, message: /^SI_INSERT_STATUS/ });
  await rejects(assert, ins({ status: 'FAILED', code: 'LEASE_EXPIRED', version: v1, finished: new Date() }), { code: CHECK, message: /^SI_INSERT_STATUS/ });
  await recordRights(c.si_rights_admin, 'ds3');                                                    // v2 now current
  await rejects(assert, ins({ version: v1 }), { code: CHECK, message: /^SI_RUN_NOT_ALLOWED: .*current rights version/ });
  await ins({ version: await vid('ds3', 2) });
  await source('ds3-deny', { rights: { evaluation: 'DENIED' } });
  await rejects(assert, ins({ source: 'ds3-deny', version: await vid('ds3-deny', 1) }), { code: CHECK, message: /^SI_RUN_NOT_ALLOWED: .*EVALUATION_NOT_ALLOWED/ });
  await control(c.si_rights_admin, 'ds3', 'SUSPEND');
  await rejects(assert, ins({ status: 'REJECTED', code: 'NO_RIGHTS' }), { code: CHECK, message: /^SI_SOURCE_SUSPENDED/ });
  await rejects(assert, ins({ source: 'no-such-source', status: 'REJECTED', code: 'NO_RIGHTS' }), { code: '23503', message: /SI_UNKNOWN_SOURCE/ });
});

// ---------------------------------------------------------------------------------------
// Concurrency (order by construction)
// ---------------------------------------------------------------------------------------

async function waitingOnAdvisory(waiterPid) {
  const r = await c.admin.query(`SELECT locktype, classid, objid, objsubid FROM pg_locks WHERE pid = $1 AND NOT granted`, [waiterPid]);
  return r.rows[0];
}

test('C5: ten identical callers — all serialize on the request-key lock; exactly one attempt is created', async t => {
  await source('c5');
  const key = newKey();
  const holder = await extra(t, 'si_collector');
  await holder.cl.query('BEGIN');
  const first = await begin(holder.cl, 'c5', key);
  const ws = [];
  for (let i = 0; i < 9; i++) ws.push(await extra(t, 'si_collector'));
  const pending = ws.map(w => waiter(begin(w.cl, 'c5', key)));
  for (const w of ws) {
    await waitUntilBlocked(c.admin, w.p, holder.p);
    const l = await waitingOnAdvisory(w.p);
    assert.deepEqual([l.locktype, l.classid, l.objsubid], ['advisory', 21321, 2], 'each waiter is queued on the request-key lock');
  }
  await holderCommit(assert, holder.cl, holder.p);
  for (const p of pending) await expectWaiterError(assert, p, { code: CHECK, message: /^SI_RUN_IN_PROGRESS/ });
  assert.equal(first.outcome, 'RUNNING');
  assert.equal((await runs('c5', key)).length, 1);
  // Unsynchronized burst on a fresh key: still exactly one row.
  const k2 = newKey();
  const burst = await Promise.all([holder, ...ws].map(w => settle(begin(w.cl, 'c5', k2))));
  assert.equal(burst.filter(b => b.status === 'ok').length, 1, JSON.stringify(burst.map(b => b.message ?? b.value.outcome)));
  assert.ok(burst.filter(b => b.status !== 'ok').every(b => /^SI_RUN_IN_PROGRESS/.test(b.message)));
  assert.equal((await runs('c5', k2)).length, 1);
});

test('C6: five callers with different hashes — one row; the others IdempotencyKeyReused', async t => {
  await source('c6');
  const key = newKey();
  const holder = await extra(t, 'si_collector');
  await holder.cl.query('BEGIN');
  await begin(holder.cl, 'c6', key, { sha: SHA('1') });
  const ws = [];
  for (const ch of ['2', '3', '4', '5']) { const w = await extra(t, 'si_collector'); ws.push({ ...w, p2: waiter(begin(w.cl, 'c6', key, { sha: SHA(ch) })) }); }
  for (const w of ws) await waitUntilBlocked(c.admin, w.p, holder.p);
  await holderCommit(assert, holder.cl, holder.p);
  for (const w of ws) await expectWaiterError(assert, w.p2, { code: CHECK, message: /^SI_IDEMPOTENCY_KEY_REUSED/ });
  assert.equal((await runs('c6', key)).length, 1);
});

test('DS7: a direct owner INSERT takes the same request-key lock (T1 waits on it, then numbers after it)', async t => {
  await source('ds7');
  const key = newKey();
  const owner = await ownerSession(t);
  const col = await extra(t, 'si_collector');
  await owner.cl.query('BEGIN');
  await owner.cl.query('SET LOCAL ROLE si_owner');
  await owner.cl.query(`INSERT INTO si.collection_runs (source_id, request_key, request_sha256, attempt, status, outcome_code, rights_version_id, conflict_policy, start_control_seq)
                        VALUES ('ds7', $1, $2, 1, 'REJECTED', 'EVALUATION_NOT_ALLOWED', (SELECT rights_version_id FROM si.rights_versions WHERE source_id = 'ds7'), 'FAIL_RUN', 0)`,
                       [key, SHA('a')]);
  const p = waiter(begin(col.cl, 'ds7', key));
  await waitUntilBlocked(c.admin, col.p, owner.p);
  assert.equal((await waitingOnAdvisory(col.p)).locktype, 'advisory', 'blocked on the request-key lock, not on a unique index');
  await holderCommit(assert, owner.cl, owner.p);
  const r = await expectWaiterOk(assert, p);
  assert.deepEqual([r.attempt, r.outcome], [2, 'RUNNING']);
});

test('CC-R: rights change vs T1, both orders — T1 decides under committed rights; a pinned run keeps its version', async t => {
  const ra = c.si_rights_admin, praP = await pid(ra);
  const col = await extra(t, 'si_collector');
  // Order 1: a new (denying) version is being recorded; T1 waits at the source lock, then sees it.
  await source('ccr1');
  await ra.query('BEGIN');
  await recordRights(ra, 'ccr1', { evaluation: 'DENIED', retain: 'DENIED', retention_days: null });
  const p1 = waiter(begin(col.cl, 'ccr1', newKey()));
  await waitUntilBlocked(c.admin, col.p, praP);
  await holderCommit(assert, ra, praP);
  const r1 = await expectWaiterOk(assert, p1);
  assert.deepEqual([r1.outcome, r1.outcome_code, r1.rights_version_id], ['REJECTED', 'EVALUATION_NOT_ALLOWED', await vid('ccr1', 2)]);
  // Order 2: T1 holds the source (FOR KEY SHARE) until it commits; the rights writer waits.
  await source('ccr2');
  await col.cl.query('BEGIN');
  const r2 = await begin(col.cl, 'ccr2', newKey());
  const p2 = waiter(recordRights(ra, 'ccr2', { evaluation: 'DENIED', retain: 'DENIED', retention_days: null }));
  await waitUntilBlocked(c.admin, praP, col.p);
  await holderCommit(assert, col.cl, col.p);
  assert.equal((await expectWaiterOk(assert, p2)).version, 2);
  assert.deepEqual([r2.outcome, r2.rights_version_id], ['RUNNING', await vid('ccr2', 1)], 'pinned to v1; step 4 publication will see the change');
});

test('CC-C: controls vs T1, both orders — exact start_control_seq; a SUSPEND committed first stops T1', async t => {
  const ra = c.si_rights_admin, praP = await pid(ra);
  const col = await extra(t, 'si_collector');
  await source('ccc1');
  const key1 = newKey();
  await ra.query('BEGIN');
  await control(ra, 'ccc1', 'SUSPEND');
  const p1 = waiter(begin(col.cl, 'ccc1', key1));
  await waitUntilBlocked(c.admin, col.p, praP);
  await holderCommit(assert, ra, praP);
  await expectWaiterError(assert, p1, { code: CHECK, message: /^SI_SOURCE_SUSPENDED/ });
  assert.equal((await runs('ccc1', key1)).length, 0);
  await source('ccc2');
  await col.cl.query('BEGIN');
  const r2 = await begin(col.cl, 'ccc2', newKey());
  const p2 = waiter(control(ra, 'ccc2', 'SUSPEND'));
  await waitUntilBlocked(c.admin, praP, col.p);
  await holderCommit(assert, col.cl, col.p);
  const s = await expectWaiterOk(assert, p2);
  assert.deepEqual([r2.outcome, r2.start_control_seq, s.control_seq], ['RUNNING', 0, 1],
    'the SUSPEND is ordered after T1 and lies inside the run\'s control interval (checked at publication, step 4)');
});

test('LO4 (revised): T1 takes the source lock before any run lock — no lock-order exception remains', async t => {
  await source('lo4');
  const key = newKey();
  const a1 = await begin(c.si_collector, 'lo4', key);
  await expireLease(a1.run_id);
  const ra = c.si_rights_admin, praP = await pid(ra);
  const col = await extra(t, 'si_collector');
  const probe = await ownerSession(t);
  await ra.query('BEGIN');
  await recordRights(ra, 'lo4');                                                                   // holds sources FOR UPDATE
  const p = waiter(begin(col.cl, 'lo4', key));
  await waitUntilBlocked(c.admin, col.p, praP);
  await probe.cl.query('BEGIN');
  const nowait = await settle(probe.cl.query('SELECT 1 FROM si.collection_runs WHERE run_id = $1 FOR UPDATE NOWAIT', [a1.run_id]));
  await probe.cl.query('ROLLBACK');
  assert.equal(nowait.status, 'ok', 'the waiting T1 holds no lock on the expired attempt (rank 4 after rank 3)');
  await holderCommit(assert, ra, praP);
  const r = await expectWaiterOk(assert, p);
  assert.deepEqual([r.attempt, r.outcome, r.rights_version_id], [2, 'RUNNING', await vid('lo4', 2)]);
});

test('LK: the request-key lock is namespaced, two-key, stable and distinct from the migration lock', async t => {
  const jsKey = (s, k) => { const b = createHash('sha256').update(`${s}/${k}`, 'utf8').digest(); return b.readInt32BE(0); };
  const pairs = [['synthetic-fixture', 'k1'], ['synthetic-fixture', 'k2'], ['other-source', 'k1'], ['a-b', 'c.d:e_f-1']];
  for (const [s, k] of pairs) {
    assert.equal((await one(c.admin, 'SELECT si.si_request_lock_key($1, $2) AS k', [s, k])).k, jsKey(s, k), `${s}/${k}`);
  }
  assert.equal(new Set(pairs.map(([s, k]) => jsKey(s, k))).size, pairs.length);
  await source('lk');
  const holder = await extra(t, 'si_collector');
  await holder.cl.query('BEGIN');
  await begin(holder.cl, 'lk', 'kk');
  const l = await one(c.admin, `SELECT classid, objid, objsubid FROM pg_locks WHERE pid = $1 AND locktype = 'advisory'`, [holder.p]);
  await holder.cl.query('ROLLBACK');
  assert.deepEqual([l.classid, l.objsubid], [21321, 2], 'two-key form (objsubid 2); the migration lock uses the bigint form (objsubid 1)');
  assert.equal(l.objid | 0, jsKey('lk', 'kk'));
});

test('LI-T1: T1 and direct inserts refuse REPEATABLE READ and SERIALIZABLE', async () => {
  for (const level of ['REPEATABLE READ', 'SERIALIZABLE']) {
    await c.si_collector.query(`BEGIN ISOLATION LEVEL ${level}`);
    await rejects(assert, begin(c.si_collector, 'synthetic-fixture', newKey()), { code: ISO, message: /^SI_ISOLATION/ });
    await c.si_collector.query('ROLLBACK');
    await c.admin.query(`BEGIN ISOLATION LEVEL ${level}`);
    await c.admin.query('SET LOCAL ROLE si_owner');
    await rejects(assert, c.admin.query(`INSERT INTO si.collection_runs (source_id, request_key, request_sha256, attempt, status, outcome_code, conflict_policy, start_control_seq)
                                         VALUES ('synthetic-fixture', 'li', '${SHA('a')}', 1, 'REJECTED', 'NO_RIGHTS', 'FAIL_RUN', 0)`), { code: ISO });
    await c.admin.query('ROLLBACK');
  }
});

test('BAD: invalid T1 arguments are refused before any lock', async () => {
  for (const [key, sha, kind, nets] of [['has space', SHA('a'), 'SYNTHETIC', ['META']], ['k', 'xyz', 'SYNTHETIC', ['META']],
                                        ['k', SHA('a'), null, ['META']], ['k', SHA('a'), 'SYNTHETIC', []], ['k', SHA('a'), 'SYNTHETIC', ['META', null]]]) {
    await rejects(assert, c.si_collector.query('SELECT * FROM si.si_begin_run($1, $2, $3, $4, $5::text[])', ['synthetic-fixture', key, sha, kind, nets]),
      { code: '22023', message: /^SI_BAD_ARGUMENT/ });
  }
  await rejects(assert, begin(c.si_collector, 'no-such-source', newKey()), { code: '23503', message: /^SI_UNKNOWN_SOURCE/ });
});

test('LIB: t1Preflight wraps one transaction and maps refusals to typed errors', async () => {
  await source('lib');
  const req = { sourceId: 'lib', requestKey: newKey(), requestSha256: SHA('a'), evidenceKind: 'SYNTHETIC', networks: ['META'] };
  const r = await t1Preflight(c.si_collector, req);
  assert.deepEqual([r.outcome, r.attempt, typeof r.leaseToken], ['RUNNING', 1, 'string']);
  await assert.rejects(t1Preflight(c.si_collector, req), e => e instanceof T1Refused && e.code === 'RUN_IN_PROGRESS');
  await assert.rejects(t1Preflight(c.si_collector, { ...req, requestSha256: SHA('b') }), e => e instanceof T1Refused && e.code === 'IDEMPOTENCY_KEY_REUSED');
  await control(c.si_rights_admin, 'lib', 'SUSPEND');
  await assert.rejects(t1Preflight(c.si_collector, { ...req, requestKey: newKey() }), e => e instanceof T1Refused && e.code === 'SOURCE_SUSPENDED');
  assert.equal((await c.si_collector.query('SELECT 1 AS ok')).rows[0].ok, 1, 'the connection is usable after a refusal (rolled back)');
});

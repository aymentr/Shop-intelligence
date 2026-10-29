// B-002 M2 Step 4: T2 controlled completion for EMPTY runs, commit-time publication check,
// receipt guards. Real disposable PostgreSQL. Risk map: docs/b002-m2-step4-contract.md.
// Concurrency order is established by construction: a holder keeps its locks in an open
// transaction and waiters are proven blocked with pg_blocking_pids.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { asOwner, connect, control, createSources, expectWaiterError, expectWaiterOk, freshDatabase, holderCommit, lift, pid,
         recordRights, rejects, roles, waitUntilBlocked, waiter } from './helpers.mjs';
import { completeRun, heartbeatRun, T2Refused } from '../../dist/persistence/runs.js';

const CHECK = '23514';
const cleanups = [];
const scope = { after: fn => cleanups.push(fn) };
let db, c, n = 0;
test.before(async () => {
  db = await freshDatabase(scope, 'step4');
  c = await roles(scope, db, ['admin', 'si_rights_admin', 'si_collector']);
});
test.after(async () => { for (const fn of cleanups.reverse()) await fn(); });

async function source() {
  const id = `s4-${++n}`;
  await createSources(c.admin, [id]);
  await recordRights(c.si_rights_admin, id);
  return id;
}
const begin = async (src, key = 'k') => (await c.si_collector.query(
  'SELECT * FROM si.si_begin_run($1,$2,$3,$4,$5::text[])', [src, key, '4'.repeat(64), 'SYNTHETIC', ['META']])).rows[0];
async function session(user, lockTimeout = '2s') {
  const x = await connect({ user, database: db });
  cleanups.push(() => x.end().catch(() => {}));
  await x.query(`SET lock_timeout = '${lockTimeout}'`);
  return x;
}
const T2_SQL = 'SELECT * FROM si.si_complete_run($1::uuid, $2::uuid)';
/** Raw T2 transaction (the library protocol without its T3 follow-up). */
async function rawT2(x, run, token = run.lease_token) {
  await x.query('BEGIN');
  try {
    const r = (await x.query(T2_SQL, [run.run_id, token])).rows[0];
    await x.query('COMMIT');
    return r;
  } catch (err) { await x.query('ROLLBACK').catch(() => {}); throw err; }
}
const runRow = async id => (await c.admin.query(`
  SELECT r.*, (SELECT count(*)::int FROM si.publication_receipts p WHERE p.run_id = r.run_id) AS receipts
    FROM si.collection_runs r WHERE r.run_id = $1`, [id])).rows[0];
async function assertUntouched(run) {
  const r = await runRow(run.run_id);
  assert.deepEqual([r.status, r.receipts, r.lease_token, r.publish_control_seq], ['RUNNING', 0, run.lease_token, null], 'nothing written');
}
async function expireSoon(id, ms) {
  await asOwner(c.admin, x => x.query(
    `UPDATE si.collection_runs SET lease_expires_at = clock_timestamp() + $2 * interval '1 millisecond' WHERE run_id = $1`, [id, ms]));
  for (let i = 0; i < 200; i++) {
    if ((await c.admin.query('SELECT lease_expires_at <= clock_timestamp() AS e FROM si.collection_runs WHERE run_id = $1', [id])).rows[0].e) return;
    await sleep(25);
  }
  throw new Error('lease did not expire');
}
const failedWith = async (run, code) => {
  const r = await runRow(run.run_id);
  assert.deepEqual([r.status, r.outcome_code, r.receipts], ['FAILED', code, 0]);
};

test('S4-1: a valid EMPTY completion writes the run, its receipt and the completion metadata', async () => {
  const src = await source();
  await control(c.si_rights_admin, src, 'SUSPEND');
  await lift(c.si_rights_admin, src);                                // start_control_seq = 2 (a LIFT state)
  const run = await begin(src);
  assert.equal(run.start_control_seq, 2);
  const res = await completeRun(c.si_collector, run.run_id, run.lease_token);
  assert.equal(res.outcome, 'COMPLETED');
  assert.equal(res.publishControlSeq, 2);
  const r = await runRow(run.run_id);
  assert.deepEqual(
    [r.status, r.retention_state, r.retain_until, r.received_count, r.published_count, r.duplicate_count, r.suppressed_count,
     r.conflict_count, r.error_count, r.outcome_code, r.lease_token, r.lease_expires_at, r.publish_control_seq, r.receipts],
    ['COMPLETED', 'EMPTY', null, 0, 0, 0, 0, 0, 0, null, null, null, 2, 1]);
  assert.ok(r.finished_at);
  assert.equal(r.finished_at.getTime(), r.rights_checked_at.getTime());
  const p = (await c.admin.query('SELECT * FROM si.publication_receipts WHERE run_id = $1', [run.run_id])).rows[0];
  assert.deepEqual([p.source_id, p.rights_version_id, p.commit_ts, p.within_validity], [src, r.rights_version_id, null, null]);
  assert.ok(p.receipt_at);
  const again = await begin(src);
  assert.deepEqual([again.outcome, again.run_id], ['ALREADY_COMPLETED', run.run_id]);
});

test('S4-2: a stale token, an expired lease, non-EMPTY counts or the wrong isolation never complete', async () => {
  const src = await source();
  const run = await begin(src);
  await rejects(assert, rawT2(c.si_collector, run, '00000000-0000-0000-0000-000000000000'), { code: CHECK, message: /^SI_T2_NOT_OWNER/ });
  assert.deepEqual(await completeRun(c.si_collector, run.run_id, '00000000-0000-0000-0000-000000000000'), { outcome: 'NOT_OWNER' });
  for (const args of [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, -1]]) {
    await rejects(assert, c.si_collector.query('SELECT * FROM si.si_complete_run($1, $2, $3, $4, $5, $6)', [run.run_id, run.lease_token, ...args]),
      { code: '22023', message: /^SI_BAD_ARGUMENT/ });
  }
  await rejects(assert, completeRun(c.si_collector, run.run_id, run.lease_token, { conflictCount: -1 }), T2Refused);
  await c.si_collector.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  await rejects(assert, c.si_collector.query(T2_SQL, [run.run_id, run.lease_token]), { code: '25000', message: /^SI_ISOLATION/ });
  await c.si_collector.query('ROLLBACK');
  await assertUntouched(run);

  await expireSoon(run.run_id, 300);
  await rejects(assert, rawT2(c.si_collector, run), { code: CHECK, message: /^SI_T2_LEASE_EXPIRED/ });
  assert.deepEqual(await completeRun(c.si_collector, run.run_id, run.lease_token), { outcome: 'FAILED', code: 'LEASE_EXPIRED', failRecorded: true });
  await failedWith(run, 'LEASE_EXPIRED');
});

test('S4-3: duplicate completion - sequential and concurrent - finalizes exactly once', async () => {
  const src = await source();
  const run = await begin(src);
  assert.equal((await completeRun(c.si_collector, run.run_id, run.lease_token)).outcome, 'COMPLETED');
  assert.deepEqual(await completeRun(c.si_collector, run.run_id, run.lease_token), { outcome: 'NOT_OWNER' });

  const run2 = await begin(src, 'k2');
  const a = await session('si_collector'), b = await session('si_collector', '10s');
  const aPid = await pid(a), bPid = await pid(b);
  await a.query('BEGIN');
  await a.query(T2_SQL, [run2.run_id, run2.lease_token]);
  await b.query('BEGIN');
  const second = waiter(b.query(T2_SQL, [run2.run_id, run2.lease_token]));
  await waitUntilBlocked(c.admin, bPid, aPid);
  await holderCommit(assert, a, aPid);
  await expectWaiterError(assert, second, { code: CHECK, message: /^SI_T2_NOT_OWNER/ });
  await b.query('ROLLBACK');
  const r = await runRow(run2.run_id);
  assert.deepEqual([r.status, r.receipts], ['COMPLETED', 1]);
});

test('S4-4 (LO1): T2 locks the source before the run; a SUSPEND committing meanwhile makes it fail', async () => {
  const src = await source();
  const run = await begin(src);
  const admin = c.si_rights_admin, adminPid = await pid(admin);
  const t2 = await session('si_collector', '10s'), t2Pid = await pid(t2);
  const hb = await session('si_collector');
  await admin.query('BEGIN');
  await control(admin, src, 'SUSPEND');                                 // holds sources FOR UPDATE
  await t2.query('BEGIN');
  const pending = waiter(t2.query(T2_SQL, [run.run_id, run.lease_token]));
  await waitUntilBlocked(c.admin, t2Pid, adminPid);
  assert.equal(await heartbeatRun(hb, run.run_id, run.lease_token), true, 'the run row is not locked while T2 waits for the source');
  await holderCommit(assert, admin, adminPid);
  await expectWaiterError(assert, pending, { code: CHECK, message: /^SI_T2_SOURCE_SUSPENDED/ });
  await t2.query('ROLLBACK');
  await assertUntouched(run);
  assert.deepEqual(await completeRun(c.si_collector, run.run_id, run.lease_token), { outcome: 'FAILED', code: 'SOURCE_SUSPENDED', failRecorded: true });
  await failedWith(run, 'SOURCE_SUSPENDED');
});

test('S4-5: a SUSPEND and LIFT between T1 and T2 still fails the run (a later LIFT does not clear it)', async () => {
  const src = await source();
  const run = await begin(src);
  await control(c.si_rights_admin, src, 'SUSPEND');
  await lift(c.si_rights_admin, src);
  await rejects(assert, rawT2(c.si_collector, run), { code: CHECK, message: /^SI_T2_SOURCE_SUSPENDED/ });
  await assertUntouched(run);
  assert.equal((await completeRun(c.si_collector, run.run_id, run.lease_token)).code, 'SOURCE_SUSPENDED');
  await failedWith(run, 'SOURCE_SUSPENDED');
});

test('S4-6: termination, retirement, a newer version and expiring rights each fail T2 with their code, in order', async () => {
  const cases = [
    ['RIGHTS_TERMINATED', src => control(c.si_rights_admin, src, 'TERMINATE_RETENTION')],   // also suspends: (b) precedes (a)
    ['SOURCE_RETIRED', src => c.si_rights_admin.query(
      `UPDATE si.sources SET retired_at = clock_timestamp() + interval '30 seconds' WHERE source_id = $1`, [src])],
    ['RIGHTS_CHANGED', src => recordRights(c.si_rights_admin, src)],                           // v2 effective now
    ['RIGHTS_EXPIRING', src => recordRights(c.si_rights_admin, src, { effective_from_sql: `clock_timestamp() + interval '30 seconds'` })]
  ];
  for (const [code, change] of cases) {
    const src = await source();
    const run = await begin(src);
    await change(src);
    await rejects(assert, rawT2(c.si_collector, run), { code: CHECK, message: new RegExp(`^SI_T2_${code}:`) });
    await assertUntouched(run);
    assert.deepEqual(await completeRun(c.si_collector, run.run_id, run.lease_token), { outcome: 'FAILED', code, failRecorded: true });
    await failedWith(run, code);
  }
});

test('S4-7 (CR-IMM, PB4): under SET CONSTRAINTS ALL IMMEDIATE T2 completes and a SUSPEND waits until it ends', async () => {
  const src = await source();
  const run = await begin(src);
  const t2 = await session('si_collector'), t2Pid = await pid(t2);
  const admin = c.si_rights_admin, adminPid = await pid(admin);
  await t2.query('BEGIN');
  await t2.query('SET CONSTRAINTS ALL IMMEDIATE');      // checks fire at statement end: receipt must already exist
  const r = (await t2.query(T2_SQL, [run.run_id, run.lease_token])).rows[0];
  assert.equal(r.outcome, 'COMPLETED');
  const suspend = waiter(control(admin, src, 'SUSPEND'));
  await waitUntilBlocked(c.admin, adminPid, t2Pid);
  await holderCommit(assert, t2, t2Pid);
  const s = await expectWaiterOk(assert, suspend);
  const row = await runRow(run.run_id);
  assert.deepEqual([row.status, row.receipts], ['COMPLETED', 1]);
  assert.ok(row.publish_control_seq < s.control_seq, `publish ${row.publish_control_seq} < suspend ${s.control_seq} (G1 without deferral)`);
});

test('S4-8: a failure found at COMMIT rolls back the receipt and the completion together', async () => {
  const src = await source();
  const run = await begin(src);
  // v1's window now ends ~61.5 s from here: valid with the 60 s margin at T2, not 2 s later at COMMIT.
  await recordRights(c.si_rights_admin, src, { effective_from_sql: `clock_timestamp() + interval '61500 milliseconds'` });
  const t2 = await session('si_collector');
  await t2.query('BEGIN');
  assert.equal((await t2.query(T2_SQL, [run.run_id, run.lease_token])).rows[0].outcome, 'COMPLETED');
  await sleep(2000);
  await rejects(assert, t2.query('COMMIT'), { code: CHECK, message: /^SI_T2_RIGHTS_EXPIRING/ });
  await assertUntouched(run);
});

test('S4-9: no role reaches COMPLETED outside T2 - app roles lack privileges; the owner fails the commit-time check', async () => {
  const src = await source();
  const run = await begin(src);
  const set = `UPDATE si.collection_runs SET status = 'COMPLETED', finished_at = clock_timestamp(), rights_checked_at = clock_timestamp(),
                 retention_state = 'EMPTY', publish_control_seq = start_control_seq, lease_token = NULL WHERE run_id = $1`;
  for (const role of [c.si_collector, c.si_rights_admin]) await rejects(assert, role.query(set, [run.run_id]), { code: '42501' });
  await rejects(assert, c.si_collector.query(
    'INSERT INTO si.publication_receipts (run_id, source_id, rights_version_id) VALUES ($1, $2, $3)', [run.run_id, src, run.rights_version_id]),
  { code: '42501' });
  await rejects(assert, asOwner(c.admin, x => x.query(set, [run.run_id])), { code: CHECK, message: /^SI_T2_PERSISTENCE_ERROR/ });
  await rejects(assert, asOwner(c.admin, async x => {
    await x.query('SET CONSTRAINTS ALL IMMEDIATE');
    await x.query(set, [run.run_id]);                    // update before receipt (PB4 mutant shape)
    await x.query('INSERT INTO si.publication_receipts (run_id, source_id, rights_version_id) VALUES ($1, $2, $3)', [run.run_id, src, run.rights_version_id]);
  }), { code: CHECK, message: /^SI_T2_PERSISTENCE_ERROR/ });
  await assertUntouched(run);
});

test('S4-10: receipts need a COMPLETED run and are permanent; only the monitor columns are set once', async () => {
  const src = await source();
  const running = await begin(src, 'running');
  await rejects(assert, asOwner(c.admin, x => x.query(
    'INSERT INTO si.publication_receipts (run_id, source_id, rights_version_id) VALUES ($1, $2, $3)', [running.run_id, src, running.rights_version_id])),
  { code: CHECK, message: /^SI_RECEIPT_RUN_NOT_COMPLETED/ });
  const run = await begin(src);
  assert.equal((await completeRun(c.si_collector, run.run_id, run.lease_token)).outcome, 'COMPLETED');
  const own = sql => asOwner(c.admin, x => x.query(sql, [run.run_id]));
  const immutable = { code: CHECK, message: /^SI_RECEIPT_IMMUTABLE/ };
  await own('UPDATE si.publication_receipts SET commit_ts = clock_timestamp() WHERE run_id = $1');
  await own('UPDATE si.publication_receipts SET within_validity = true WHERE run_id = $1');
  for (const sql of ['UPDATE si.publication_receipts SET commit_ts = clock_timestamp() WHERE run_id = $1',
                     'UPDATE si.publication_receipts SET within_validity = false WHERE run_id = $1',
                     'UPDATE si.publication_receipts SET receipt_at = clock_timestamp() WHERE run_id = $1',
                     'DELETE FROM si.publication_receipts WHERE run_id = $1']) {
    await rejects(assert, own(sql), immutable);
  }
  await rejects(assert, asOwner(c.admin, x => x.query('TRUNCATE si.publication_receipts')), immutable);
  for (const sql of ['UPDATE si.publication_receipts SET commit_ts = NULL', 'DELETE FROM si.publication_receipts']) {
    await rejects(assert, c.si_collector.query(sql), { code: '42501' });
  }
  assert.equal((await runRow(run.run_id)).receipts, 1);
});

test('S4-11 (BD1, BD2): definer, read-only and deferral properties; T2 grantees', async () => {
  const fns = (await c.admin.query(`
    SELECT proname, prosecdef, prosrc, coalesce((SELECT array_agg(a.grantee::regrole::text ORDER BY 1) FROM aclexplode(proacl) a
                                                  WHERE a.grantee <> proowner), '{}') AS grantees
      FROM pg_proc WHERE pronamespace = 'si'::regnamespace
       AND proname IN ('si_complete_run', 'trg_runs_publish_check', 'trg_receipts_run_completed', 'trg_receipts_guard',
                       'trg_runs_transition', 'si_t2_control_outcome') ORDER BY proname`)).rows;
  const by = Object.fromEntries(fns.map(f => [f.proname, f]));
  assert.deepEqual([by.si_complete_run.prosecdef, by.si_complete_run.grantees], [true, ['si_collector']]);
  for (const f of ['trg_runs_publish_check', 'trg_receipts_run_completed']) {
    assert.deepEqual([by[f].prosecdef, by[f].grantees], [true, []], f);
    assert.doesNotMatch(by[f].prosrc, /\m(INSERT|UPDATE|DELETE|TRUNCATE|MERGE)\M/i, `${f} is read-only`);
  }
  for (const f of ['trg_receipts_guard', 'trg_runs_transition', 'si_t2_control_outcome']) assert.equal(by[f].prosecdef, false, f);
  assert.deepEqual(by.si_t2_control_outcome.grantees, []);
  const trg = (await c.admin.query(`SELECT tgname, tgdeferrable, tginitdeferred FROM pg_trigger
    WHERE tgname IN ('trg_runs_publish_check', 'trg_receipts_run_completed') ORDER BY 1`)).rows;
  assert.deepEqual(trg.map(t => [t.tgname, t.tgdeferrable, t.tginitdeferred]),
    [['trg_receipts_run_completed', true, true], ['trg_runs_publish_check', true, true]]);
});

test('S4-12 (PB1): the library sends exactly BEGIN / T2 / COMMIT and maps a lock timeout to T3', async () => {
  const src = await source();
  const run = await begin(src);
  const sent = [];
  const spy = { query: (sql, params) => { sent.push(sql.split('(')[0].trim()); return c.si_collector.query(sql, params); } };
  assert.equal((await completeRun(spy, run.run_id, run.lease_token)).outcome, 'COMPLETED');
  assert.deepEqual(sent, ['BEGIN', 'SELECT * FROM si.si_complete_run', 'COMMIT']);

  const run2 = await begin(src, 'k2');
  const t2 = await session('si_collector', '200ms');
  await c.admin.query('BEGIN');
  try {
    await c.admin.query('SELECT 1 FROM si.sources WHERE source_id = $1 FOR UPDATE', [src]);
    assert.deepEqual(await completeRun(t2, run2.run_id, run2.lease_token), { outcome: 'FAILED', code: 'LOCK_TIMEOUT', failRecorded: true });
  } finally { await c.admin.query('ROLLBACK'); }
  await failedWith(run2, 'LOCK_TIMEOUT');
});

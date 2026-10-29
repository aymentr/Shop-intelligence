// B-002 Step 3: lifecycle guards, heartbeat, T3, reaper and run_errors integrity, real disposable PostgreSQL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { asOwner, connect, createSources, expectWaiterOk, freshDatabase, holderCommit, pid, recordRights, rejects, roles,
         waitUntilBlocked, waiter } from './helpers.mjs';
import { heartbeatRun, failRun, reapExpiredRuns } from '../../dist/persistence/runs.js';

const cleanups = [];
const scope = { after: fn => cleanups.push(fn) };
let db, c;
test.before(async () => {
  db = await freshDatabase(scope, 'step3');
  c = await roles(scope, db, ['admin', 'si_rights_admin', 'si_collector']);
  await createSources(c.admin, ['step3-source']);
  await recordRights(c.si_rights_admin, 'step3-source');
});
test.after(async () => { for (const fn of cleanups.reverse()) await fn(); });

test('S3-1: DELETE and TRUNCATE are rejected even for the owner, without losing the run', async () => {
  const result = await c.si_collector.query(
    'SELECT * FROM si.si_begin_run($1,$2,$3,$4,$5::text[])',
    ['step3-source', 'step3-key', 'a'.repeat(64), 'SYNTHETIC', ['META']]
  );
  const runId = result.rows[0].run_id;
  assert.equal(result.rows[0].outcome, 'RUNNING');

  await rejects(assert, asOwner(c.admin, x =>
    x.query('DELETE FROM si.collection_runs WHERE run_id = $1', [runId])),
  { code: '23514', message: /SI_RUN_DELETE_FORBIDDEN/ });

  await rejects(assert, asOwner(c.admin, x =>
    x.query('TRUNCATE si.collection_runs CASCADE')),
  { code: '23514', message: /SI_RUN_DELETE_FORBIDDEN/ });

  const count = await c.admin.query('SELECT count(*)::int AS n FROM si.collection_runs WHERE run_id = $1', [runId]);
  assert.equal(count.rows[0].n, 1);
});

test('S3-2: deletion trigger runs as invoker; collector has no direct DELETE', async () => {
  const r = await c.admin.query(`
    SELECT p.prosecdef AS is_definer
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'si' AND p.proname = 'trg_runs_no_delete'`);
  assert.equal(r.rows[0]?.is_definer, false);
  const perms = await c.admin.query(
    "SELECT pg_catalog.has_table_privilege('si_collector', 'si.collection_runs', 'DELETE') AS can_delete");
  assert.equal(perms.rows[0].can_delete, false);
});

test('S3-3: run identity cannot change, and a terminal failure freezes counters', async () => {
  const started = await c.si_collector.query(
    'SELECT * FROM si.si_begin_run($1,$2,$3,$4,$5::text[])',
    ['step3-source', 'step3-transition', 'b'.repeat(64), 'SYNTHETIC', ['META']]
  );
  const id = started.rows[0].run_id;
  await rejects(assert, asOwner(c.admin, x =>
    x.query("UPDATE si.collection_runs SET request_sha256 = $2 WHERE run_id = $1", [id, 'c'.repeat(64)])),
  { code: '23514', message: /SI_RUN_IDENTITY_IMMUTABLE/ });

  await asOwner(c.admin, x =>
    x.query("UPDATE si.collection_runs SET status = 'FAILED', outcome_code = 'SOURCE_ERROR' WHERE run_id = $1", [id]));
  const row = (await c.admin.query('SELECT status, finished_at, lease_token FROM si.collection_runs WHERE run_id = $1', [id])).rows[0];
  assert.equal(row.status, 'FAILED');
  assert.ok(row.finished_at);
  assert.equal(row.lease_token, null);

  await rejects(assert, asOwner(c.admin, x =>
    x.query('UPDATE si.collection_runs SET received_count = 1 WHERE run_id = $1', [id])),
  { code: '23514', message: /SI_RUN_TERMINAL_IMMUTABLE/ });
});

test('S3-4: transition trigger is SECURITY INVOKER, and oversized heartbeat is rejected', async () => {
  const cat = (await c.admin.query(`
    SELECT prosecdef FROM pg_catalog.pg_proc
    WHERE pronamespace = 'si'::regnamespace AND proname = 'trg_runs_transition'`)).rows[0];
  assert.equal(cat.prosecdef, false);
  const started = await c.si_collector.query(
    'SELECT * FROM si.si_begin_run($1,$2,$3,$4,$5::text[])',
    ['step3-source', 'step3-heartbeat', 'd'.repeat(64), 'SYNTHETIC', ['META']]
  );
  await rejects(assert, asOwner(c.admin, x =>
    x.query("UPDATE si.collection_runs SET lease_expires_at = clock_timestamp() + interval '20 minutes' WHERE run_id = $1", [started.rows[0].run_id])),
  { code: '23514', message: /SI_RUN_INVALID_HEARTBEAT/ });
});

test('S3-5: heartbeat requires a live matching token; failure is terminal and idempotent', async () => {
  const started = (await c.si_collector.query(
    'SELECT * FROM si.si_begin_run($1,$2,$3,$4,$5::text[])',
    ['step3-source', 'step3-ops', 'e'.repeat(64), 'SYNTHETIC', ['META']]
  )).rows[0];
  const id = started.run_id, token = started.lease_token;
  assert.equal(await heartbeatRun(c.si_collector, id, '00000000-0000-0000-0000-000000000000'), false);
  assert.equal(await heartbeatRun(c.si_collector, id, token), true);
  assert.equal(await failRun(c.si_collector, id, token, 'SOURCE_ERROR'), true);
  assert.equal(await failRun(c.si_collector, id, token, 'SOURCE_ERROR'), false);
  assert.equal(await heartbeatRun(c.si_collector, id, token), false);
  const row = (await c.admin.query(
    'SELECT status, outcome_code, finished_at, lease_token FROM si.collection_runs WHERE run_id = $1', [id])).rows[0];
  assert.equal(row.status, 'FAILED');
  assert.equal(row.outcome_code, 'SOURCE_ERROR');
  assert.ok(row.finished_at);
  assert.equal(row.lease_token, null);
});

test('S3-6: expired token cannot be renewed or used to fail with an unrelated code', async () => {
  const started = (await c.si_collector.query(
    'SELECT * FROM si.si_begin_run($1,$2,$3,$4,$5::text[])',
    ['step3-source', 'step3-expired', 'f'.repeat(64), 'SYNTHETIC', ['META']]
  )).rows[0];
  const id = started.run_id, token = started.lease_token;
  await asOwner(c.admin, x => x.query(
    "UPDATE si.collection_runs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE run_id = $1", [id]));
  assert.equal(await heartbeatRun(c.si_collector, id, token), false);
  assert.equal(await failRun(c.si_collector, id, token, 'SOURCE_ERROR'), false);
  assert.equal(await failRun(c.si_collector, id, token, 'LEASE_EXPIRED'), true);
  assert.equal((await c.admin.query('SELECT outcome_code FROM si.collection_runs WHERE run_id = $1', [id])).rows[0].outcome_code, 'LEASE_EXPIRED');
});

// ---------------------------------------------------------------------------------------
// Step 3 slice 4: independent reaper, append-only run_errors, commit-time error count.
// Leases expire for real: an owner fixture shortens a live lease to about one second (a
// bounded heartbeat, permitted by trg_runs_transition), then the test waits until the
// database clock has passed it. Every other RUNNING run in this file keeps a 5-minute lease,
// so reaper counts below are exact.
// ---------------------------------------------------------------------------------------
const begin = async key => (await c.si_collector.query(
  'SELECT * FROM si.si_begin_run($1,$2,$3,$4,$5::text[])',
  ['step3-source', key, '9'.repeat(64), 'SYNTHETIC', ['META']])).rows[0];
const shortenLease = (id, ms) => asOwner(c.admin, x => x.query(
  `UPDATE si.collection_runs SET lease_expires_at = clock_timestamp() + $2 * interval '1 millisecond' WHERE run_id = $1`, [id, ms]));
async function waitExpired(id) {
  for (let i = 0; i < 200; i++) {
    const r = (await c.admin.query('SELECT lease_expires_at <= clock_timestamp() AS expired FROM si.collection_runs WHERE run_id = $1', [id])).rows[0];
    if (r.expired) return;
    await sleep(25);
  }
  throw new Error(`lease of ${id} did not expire`);
}
const runRow = async id => (await c.admin.query(
  `SELECT status, outcome_code, finished_at, lease_token, lease_expires_at, error_count,
          (SELECT count(*)::int FROM si.run_errors e WHERE e.run_id = r.run_id) AS stored
     FROM si.collection_runs r WHERE run_id = $1`, [id])).rows[0];
async function collector(opts = {}) {
  const x = await connect({ user: 'si_collector', database: db });
  cleanups.push(() => x.end().catch(() => {}));
  // A reaper that waited on a lock would fail here instead of hanging the test.
  await x.query(`SET lock_timeout = '${opts.lockTimeout ?? '2s'}'`);
  return x;
}

test('S3-7: the reaper fails a really expired run without its token and leaves live leases alone', async () => {
  const run = await begin('step3-reap');
  await shortenLease(run.run_id, 1200);
  assert.equal(await reapExpiredRuns(c.si_collector), 0, 'a live lease is never reaped');
  assert.equal((await runRow(run.run_id)).status, 'RUNNING');

  await waitExpired(run.run_id);
  assert.equal(await reapExpiredRuns(c.si_collector), 1);
  const row = await runRow(run.run_id);
  assert.equal(row.status, 'FAILED');
  assert.equal(row.outcome_code, 'LEASE_EXPIRED');
  assert.ok(row.finished_at);
  assert.equal(row.lease_token, null);
  assert.equal(row.lease_expires_at, null);
  assert.deepEqual([row.error_count, row.stored], [0, 0]);

  assert.equal(await reapExpiredRuns(c.si_collector), 0, 'idempotent');
  assert.equal(await heartbeatRun(c.si_collector, run.run_id, run.lease_token), false, 'the old token cannot revive it');
  assert.equal(await failRun(c.si_collector, run.run_id, run.lease_token, 'LEASE_EXPIRED'), false);
  const retry = await begin('step3-reap');
  assert.deepEqual([retry.outcome, retry.attempt], ['RUNNING', 2], 'T1 retries after the reaped attempt');

  await rejects(assert, c.si_collector.query('SELECT si.si_reap_expired_runs(0)'), { code: '22023', message: /SI_BAD_ARGUMENT/ });
  await c.si_collector.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  await rejects(assert, c.si_collector.query('SELECT si.si_reap_expired_runs(10)'), { code: '25000', message: /SI_ISOLATION/ });
  await c.si_collector.query('ROLLBACK');
});

test('S3-8: the reaper takes rank-4 run locks only (sources row and request key held elsewhere)', async () => {
  const run = await begin('step3-rank4');
  await shortenLease(run.run_id, 300);
  await waitExpired(run.run_id);
  const reaper = await collector();
  await c.admin.query('BEGIN');
  try {
    await c.admin.query(`SELECT 1 FROM si.sources WHERE source_id = 'step3-source' FOR UPDATE`);                   // rank 3
    await c.admin.query(`SELECT pg_catalog.pg_advisory_xact_lock(si.si_request_lock_namespace(),
                           si.si_request_lock_key('step3-source', 'step3-rank4'))`);                               // rank 1
    assert.equal(await reapExpiredRuns(reaper), 1, 'completes while ranks 1 and 3 are held (lock_timeout 2s)');
  } finally { await c.admin.query('ROLLBACK'); }
  assert.equal((await runRow(run.run_id)).outcome_code, 'LEASE_EXPIRED');
});

test('S3-9: heartbeat/reaper concurrency - a held heartbeat is skipped; a held reap wins and the heartbeat loses cleanly', async () => {
  // (a) heartbeat locks first, its lease extension still uncommitted when the old lease expires.
  const a = await begin('step3-race-a');
  await shortenLease(a.run_id, 800);
  const hb = await collector(), reaper = await collector();
  await hb.query('BEGIN');
  assert.equal(await heartbeatRun(hb, a.run_id, a.lease_token), true);
  await waitExpired(a.run_id);                                       // committed lease is past
  assert.equal(await reapExpiredRuns(reaper), 0, 'SKIP LOCKED: the reaper neither waits nor reaps');
  await holderCommit(assert, hb, await pid(hb));
  assert.equal(await reapExpiredRuns(reaper), 0, 'the committed heartbeat made the lease live again');
  assert.equal((await runRow(a.run_id)).status, 'RUNNING');
  assert.equal(await heartbeatRun(hb, a.run_id, a.lease_token), true);

  // (b) the reaper locks first; a heartbeat and T3 with the stale token wait, then lose without error.
  const b = await begin('step3-race-b');
  await shortenLease(b.run_id, 300);
  await waitExpired(b.run_id);
  const second = await collector();
  const hbWait = await collector({ lockTimeout: '5s' });
  const hbPid = await pid(hbWait), reaperPid = await pid(reaper);
  await reaper.query('BEGIN');
  assert.equal(await reapExpiredRuns(reaper), 1);
  assert.equal(await reapExpiredRuns(second), 0, 'a concurrent reaper skips the held row');
  const pending = waiter(heartbeatRun(hbWait, b.run_id, b.lease_token));
  await waitUntilBlocked(c.admin, hbPid, reaperPid);
  await holderCommit(assert, reaper, reaperPid);
  assert.equal(await expectWaiterOk(assert, pending), false, 'heartbeat after the reap is refused, not an error');
  assert.equal(await failRun(hbWait, b.run_id, b.lease_token, 'LEASE_EXPIRED'), false, 'exactly one finalizer');
  const row = await runRow(b.run_id);
  assert.deepEqual([row.status, row.outcome_code], ['FAILED', 'LEASE_EXPIRED']);
});

const ERR = (n, field = 'seenAt') => Array.from({ length: n }, (_, i) => ({ code: 'INVALID_TIMESTAMP', rowIndex: i, field }));

test('S3-10: T3 stores a valid failure and its first 100 coded errors atomically', async () => {
  const run = await begin('step3-errors');
  const correlationId = randomUUID();
  assert.equal(await failRun(c.si_collector, run.run_id, run.lease_token, 'VALIDATION_FAILED',
    { errorCount: 150, records: ERR(100), correlationId }), true);
  const row = await runRow(run.run_id);
  assert.deepEqual([row.status, row.outcome_code, row.error_count, row.stored], ['FAILED', 'VALIDATION_FAILED', 150, 100]);
  const e = (await c.admin.query(`SELECT min(seq)::int AS lo, max(seq)::int AS hi, count(DISTINCT correlation_id)::int AS ids,
                                         bool_and(correlation_id = $2) AS same
                                    FROM si.run_errors WHERE run_id = $1`, [run.run_id, correlationId])).rows[0];
  assert.deepEqual(e, { lo: 1, hi: 100, ids: 1, same: true });

  const small = await begin('step3-errors-small');
  assert.equal(await failRun(c.si_collector, small.run_id, small.lease_token, 'SOURCE_ERROR',
    { errorCount: 2, records: [{ code: 'HTTP_STATUS', rowIndex: null, field: null }, ...ERR(1)], correlationId }), true);
  assert.deepEqual([(await runRow(small.run_id)).error_count, (await runRow(small.run_id)).stored], [2, 2]);
});

test('S3-11: mismatched or invalid error records roll back the whole failure (no partial write)', async () => {
  const run = await begin('step3-mismatch');
  const fail = errors => failRun(c.si_collector, run.run_id, run.lease_token, 'VALIDATION_FAILED', errors);
  const id = randomUUID();
  await rejects(assert, fail({ errorCount: 3, records: ERR(2), correlationId: id }), { code: '22023', message: /SI_BAD_ARGUMENT/ });
  await rejects(assert, fail({ errorCount: 101, records: ERR(101), correlationId: id }), { code: '22023' });
  await rejects(assert, fail({ errorCount: 1, records: ERR(1), correlationId: null }), { code: '22023' });
  await rejects(assert, fail({ errorCount: 1, records: [{ code: 'free text here', rowIndex: 0, field: null }], correlationId: id }), { code: '23514' });
  await rejects(assert, fail({ errorCount: 1, records: ERR(1, 'rawPayload'), correlationId: id }), { code: '23514' });
  let row = await runRow(run.run_id);
  assert.deepEqual([row.status, row.error_count, row.stored], ['RUNNING', 0, 0], 'the status change rolled back with the bad records');

  // Direct owner writes that disagree with error_count fail at COMMIT, with nothing kept.
  await rejects(assert, asOwner(c.admin, async x => {
    await x.query(`UPDATE si.collection_runs SET status = 'FAILED', outcome_code = 'VALIDATION_FAILED', error_count = 2 WHERE run_id = $1`, [run.run_id]);
    await x.query(`INSERT INTO si.run_errors (run_id, seq, code, correlation_id) VALUES ($1, 1, 'INVALID_TIMESTAMP', $2)`, [run.run_id, id]);
  }), { code: '23514', message: /SI_RUN_ERRORS_COUNT/ });
  await rejects(assert, asOwner(c.admin, x =>
    x.query(`INSERT INTO si.run_errors (run_id, seq, code, correlation_id) VALUES ($1, 1, 'INVALID_TIMESTAMP', $2)`, [run.run_id, id])),
  { code: '23514', message: /SI_RUN_ERRORS_COUNT/ });                                 // errors for a RUNNING run
  row = await runRow(run.run_id);
  assert.deepEqual([row.status, row.error_count, row.stored], ['RUNNING', 0, 0]);
  assert.equal(await failRun(c.si_collector, run.run_id, run.lease_token, 'VALIDATION_FAILED',
    { errorCount: 1, records: ERR(1), correlationId: id }), true, 'a valid retry still succeeds');
});

test('S3-12: run_errors are append-only and a terminal error_count is frozen, for every role', async () => {
  const run = await begin('step3-append');
  const id = randomUUID();
  assert.equal(await failRun(c.si_collector, run.run_id, run.lease_token, 'VALIDATION_FAILED',
    { errorCount: 2, records: ERR(2), correlationId: id }), true);
  for (const sql of [`UPDATE si.run_errors SET code = 'OTHER_CODE' WHERE run_id = $1`, `DELETE FROM si.run_errors WHERE run_id = $1`]) {
    await rejects(assert, asOwner(c.admin, x => x.query(sql, [run.run_id])), { code: '23514', message: /SI_RUN_ERRORS_APPEND_ONLY/ });
  }
  await rejects(assert, asOwner(c.admin, x => x.query('TRUNCATE si.run_errors')), { code: '23514', message: /SI_RUN_ERRORS_APPEND_ONLY/ });
  await rejects(assert, asOwner(c.admin, x =>
    x.query(`INSERT INTO si.run_errors (run_id, seq, code, correlation_id) VALUES ($1, 3, 'LATE_ERROR', $2)`, [run.run_id, id])),
  { code: '23514', message: /SI_RUN_ERRORS_COUNT/ });                                 // appending to a finished run
  await rejects(assert, asOwner(c.admin, x =>
    x.query('UPDATE si.collection_runs SET error_count = 3 WHERE run_id = $1', [run.run_id])),
  { code: '23514', message: /SI_RUN_TERMINAL_IMMUTABLE/ });
  for (const sql of [`INSERT INTO si.run_errors (run_id, seq, code, correlation_id) VALUES ('${run.run_id}', 3, 'LATE_ERROR', '${id}')`,
                     `UPDATE si.run_errors SET code = 'OTHER_CODE'`, `DELETE FROM si.run_errors`]) {
    await rejects(assert, c.si_collector.query(sql), { code: '42501' });
  }
  const row = await runRow(run.run_id);
  assert.deepEqual([row.error_count, row.stored], [2, 2]);

  const cat = (await c.admin.query(`
    SELECT t.tgname, t.tgdeferrable, t.tginitdeferred, p.proname, p.prosecdef
      FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
     WHERE NOT t.tgisinternal AND t.tgname IN ('trg_run_errors_count', 'trg_runs_error_count', 'trg_run_errors_append_only')
     ORDER BY t.tgname`)).rows;
  assert.deepEqual(cat.map(r => [r.tgname, r.tgdeferrable, r.tginitdeferred, r.prosecdef]), [
    ['trg_run_errors_append_only', false, false, false],
    ['trg_run_errors_count', true, true, true],
    ['trg_runs_error_count', true, true, true]
  ]);
});

test('S3-13: under SET CONSTRAINTS ALL IMMEDIATE a valid failure still commits and a mismatch is still refused', async () => {
  const run = await begin('step3-immediate');
  const id = randomUUID();
  await c.si_collector.query('BEGIN');
  await c.si_collector.query('SET CONSTRAINTS ALL IMMEDIATE');
  assert.equal(await failRun(c.si_collector, run.run_id, run.lease_token, 'VALIDATION_FAILED',
    { errorCount: 2, records: ERR(2), correlationId: id }), true);
  await holderCommit(assert, c.si_collector, await pid(c.si_collector));
  assert.deepEqual([(await runRow(run.run_id)).error_count, (await runRow(run.run_id)).stored], [2, 2]);

  const other = await begin('step3-immediate-bad');
  await rejects(assert, asOwner(c.admin, async x => {
    await x.query('SET CONSTRAINTS ALL IMMEDIATE');
    await x.query(`UPDATE si.collection_runs SET status = 'FAILED', outcome_code = 'VALIDATION_FAILED', error_count = 1 WHERE run_id = $1`, [other.run_id]);
  }), { code: '23514', message: /SI_RUN_ERRORS_COUNT/ });
  assert.equal((await runRow(other.run_id)).status, 'RUNNING');
});

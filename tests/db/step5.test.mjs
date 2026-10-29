// B-002 M2 Step 5: the one acceptance gap that needed a focused test (docs/b002-m2-final-acceptance.md).
// LO4b / G2 with real objects: an open T2 holds the source FOR SHARE; T1 for another key on
// the same source (including its row-4 reap) proceeds without waiting; a rights version and a
// retirement for the source wait until T2 ends; no deadlock, nothing partial.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { asOwner, connect, createSources, expectWaiterOk, freshDatabase, holderCommit, pid, recordRights, roles,
         waiter } from './helpers.mjs';
import { t1Preflight } from '../../dist/persistence/runs.js';

const cleanups = [];
const scope = { after: fn => cleanups.push(fn) };
let db, c;
test.before(async () => {
  db = await freshDatabase(scope, 'step5');
  c = await roles(scope, db, ['admin', 'si_rights_admin', 'si_collector']);
  await createSources(c.admin, ['s5-src']);
  await recordRights(c.si_rights_admin, 's5-src');
});
test.after(async () => { for (const fn of cleanups.reverse()) await fn(); });

async function session(user, lockTimeout) {
  const x = await connect({ user, database: db });
  cleanups.push(() => x.end().catch(() => {}));
  await x.query(`SET lock_timeout = '${lockTimeout}'`);
  return x;
}
const begin = async key => (await c.si_collector.query(
  'SELECT * FROM si.si_begin_run($1,$2,$3,$4,$5::text[])', ['s5-src', key, '5'.repeat(64), 'SYNTHETIC', ['META']])).rows[0];
async function waitBlockedByAny(waiterPid, holders, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = (await c.admin.query(`SELECT pg_catalog.pg_blocking_pids($1) && $2::int[] AS blocked,
      (SELECT wait_event_type FROM pg_catalog.pg_stat_activity WHERE pid = $1) AS wait`, [waiterPid, holders])).rows[0];
    if (r.blocked && r.wait === 'Lock') return;
    await sleep(25);
  }
  throw new Error(`pid ${waiterPid} was not observed blocked by any of ${holders}`);
}
const req = key => ({ sourceId: 's5-src', requestKey: key, requestSha256: '5'.repeat(64), evidenceKind: 'SYNTHETIC', networks: ['META'] });

test('S5-1 (LO4b, G2): open T2 vs T1 with a reap, a rights version and a retirement - no deadlock, writers wait for T2', async () => {
  const a = await begin('a');
  const stale = await begin('b');                         // expired attempt that T1 will reap (row 4)
  await asOwner(c.admin, x => x.query(
    `UPDATE si.collection_runs SET lease_expires_at = clock_timestamp() + interval '200 milliseconds' WHERE run_id = $1`, [stale.run_id]));
  await sleep(400);

  const t2 = await session('si_collector', '5s'), t2Pid = await pid(t2);
  const t1 = await session('si_collector', '2s');         // would fail with 55P03 if T1 had to wait for T2
  const rights = await session('si_rights_admin', '10s'), rightsPid = await pid(rights);
  const retire = await session('si_rights_admin', '10s'), retirePid = await pid(retire);

  await t2.query('BEGIN');
  const done = (await t2.query('SELECT * FROM si.si_complete_run($1::uuid, $2::uuid)', [a.run_id, a.lease_token])).rows[0];
  assert.equal(done.outcome, 'COMPLETED');

  const next = await t1Preflight(t1, req('b'));            // advisory -> KEY SHARE -> reap -> insert, while T2 holds SHARE
  assert.deepEqual([next.outcome, next.attempt], ['RUNNING', 2]);

  const v2 = waiter(recordRights(rights, 's5-src', { effective_from_sql: `clock_timestamp() + interval '1 day'` }));
  const ret = waiter(retire.query(`UPDATE si.sources SET retired_at = clock_timestamp() + interval '30 days' WHERE source_id = 's5-src'`));
  // Each writer waits for T2 directly or queues behind the other writer already waiting on the
  // same source row (PostgreSQL tuple-lock queueing); neither proceeds until T2 ends.
  await waitBlockedByAny(rightsPid, [t2Pid, retirePid]);
  await waitBlockedByAny(retirePid, [t2Pid, rightsPid]);
  const before = (await c.admin.query(`SELECT count(*)::int AS n FROM si.rights_versions WHERE source_id = 's5-src'`)).rows[0].n;
  assert.equal(before, 1, 'no rights version committed while T2 is open (G2)');
  assert.equal((await c.admin.query(`SELECT retired_at FROM si.sources WHERE source_id = 's5-src'`)).rows[0].retired_at, null,
    'no retirement committed while T2 is open (G2)');
  await holderCommit(assert, t2, t2Pid);
  assert.equal((await expectWaiterOk(assert, v2)).version, 2);
  await expectWaiterOk(assert, ret);

  const rows = (await c.admin.query(`SELECT request_key, attempt, status, outcome_code, retention_state, publish_control_seq
                                       FROM si.collection_runs WHERE source_id = 's5-src' ORDER BY request_key, attempt`)).rows;
  assert.deepEqual(rows.map(r => [r.request_key, r.attempt, r.status, r.outcome_code]),
    [['a', 1, 'COMPLETED', null], ['b', 1, 'FAILED', 'LEASE_EXPIRED'], ['b', 2, 'RUNNING', null]]);
  const receipt = (await c.admin.query(`SELECT r.rights_version_id = v.rights_version_id AS v1
                                          FROM si.publication_receipts r JOIN si.rights_versions v ON v.source_id = r.source_id AND v.version = 1
                                         WHERE r.run_id = $1`, [a.run_id])).rows[0];
  assert.equal(receipt.v1, true, 'the receipt names the version T2 decided under, not the later one');
});

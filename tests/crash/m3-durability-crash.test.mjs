// B-002 M3-AUD-03 (migration 0010): crash-durable read intent. Real disposable PostgreSQL 16 (compose), synthetic
// sources only. No evidence may be released on an intent whose commit is not yet flushed to WAL on disk.
//
// Fixtures a product path cannot perform (labelled where used):
//   - the test superuser widens the WAL writer interval (ALTER SYSTEM wal_writer_delay = '10s', reset afterwards)
//     so that an asynchronously committed intent deterministically stays unflushed;
//   - the test kills one backend with SIGKILL inside the disposable compose container, which makes the
//     postmaster run crash recovery (everything not yet written from the WAL buffers is lost); compose runs
//     fsync = off, which does not matter for a PostgreSQL crash (written WAL is in the OS) but means an OS or
//     power failure is NOT exercised here;
//   - mutated or instrumented copies of the read function in a disposable database.
// This file restarts the server (crash recovery). It is run on its own (CI step "Crash durability"):
//   node tests/db/run.mjs tests/crash/m3-durability-crash.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { asOwner, connect, control, pid, settle } from '../db/helpers.mjs';
import { readEvidence, revokeReader } from '../../dist/persistence/reader.js';
import { provisionReaders, fresh, ready, READ, intent, asyncIntent, outcome, crash, writerDelay, intentExists, releaseThenCrash,
         fnText, mutate, READ_FN, TARGET, WAIT, PAUSE_AT, withPause, assertGate } from '../db/durability-fixtures.mjs';

test.before(provisionReaders);

// ------------------------------------------------------------------------------------------------
test('AUD-12a: async-commit crash durability — no released page ever loses its intent', async t => {
  const x = await fresh(t);
  const { src } = await ready(x);
  await writerDelay('10s');
  let wide;
  try { wide = await releaseThenCrash(x, src); } finally { await writerDelay(null); }
  assert.deepEqual([wide.released, wide.outcome], [false, 'SI_READ_INTENT_NOT_DURABLE'], 'unflushed intent: nothing released');
  const attempts = [];
  for (let i = 0; i < 4; i++) attempts.push(await releaseThenCrash(x, src));       // default WAL writer: the read waits for the flush
  console.log(`# AUD-12a 10 s writer: ${wide.outcome}, intent ${wide.survived ? 'kept' : 'lost (nothing released)'}; default writer: ${attempts.map(a => `${a.outcome}/${a.survived ? 'kept' : 'LOST'}`).join(', ')}`);
  assert.ok(attempts.every(a => !a.released || a.survived), 'every released page kept its intent through the crash');
  assert.ok(attempts.some(a => a.released), 'with the default WAL writer the async intent is flushed and the read proceeds');
  // A synchronous intent survives the crash too.
  const s = await connect({ user: 'si_reader_alice', database: x.db }), r = await connect({ user: 'si_reader_alice', database: x.db });
  const id = await intent(s, src); const rp = await pid(r);
  await r.query('BEGIN'); const got = await r.query(READ, [src, id, null, 100]);
  await crash(rp);
  assert.equal(got.rows.length, 2);
  assert.equal(await intentExists(x.db, id), true);
});

// Negative-control mutants of the 0010 read detected through a real crash.
/** Detected = rows were released and the intent did not survive the crash (unflushed intent, 10 s WAL writer). */
async function scnCrash(x) {
  const { src } = await ready(x);
  await writerDelay('10s');
  try { for (let i = 0; i < 2; i++) { const r = await releaseThenCrash(x, src); if (r.released && !r.survived) return true; } return false; }
  finally { await writerDelay(null); }
}
/** Detected = the WAL target is taken before the commit is observed: a commit that lands in between is released unflushed. */
async function scnOrder(x) {
  const { src } = await ready(x);
  await writerDelay('10s');
  try {
    const a = await connect({ user: 'si_reader_alice', database: x.db }), r = await connect({ user: 'si_reader_alice', database: x.db });
    await a.query('BEGIN');
    const id = await intent(a, src);
    await a.query('SET LOCAL synchronous_commit = off');
    await x.admin.query('INSERT INTO public.flushme VALUES (1)');                 // flush the intent row's WAL: only its commit record will be unflushed
    const rp = await pid(r);
    await r.query(`SET si.test_pause = '0.8'`);
    await r.query('BEGIN');
    const pending = settle(r.query(READ, [src, id, null, 100]));
    await sleep(300);
    await a.query('COMMIT');                                                      // commits (asynchronously) during the reader's pause
    const got = await pending;
    await crash(rp);
    await a.end().catch(() => {}); await r.end().catch(() => {});
    return got.status === 'ok' && got.value.rows.length > 0 && !(await intentExists(x.db, id));
  } finally { await writerDelay(null); }
}
const MUTANTS = [
  { name: 'durability wait removed', scenario: scnCrash, sql: mutate(READ_FN, WAIT, '  WHILE false LOOP') },
  { name: 'timeout fails open', scenario: scnCrash,
    sql: mutate(READ_FN, `      RAISE EXCEPTION 'SI_READ_INTENT_NOT_DURABLE: the read intent is not yet durable; start a new read' USING ERRCODE = 'object_not_in_prerequisite_state';`, '      EXIT;') },
  { name: 'target weakened to the flush position', scenario: scnCrash,
    sql: mutate(READ_FN, TARGET, '  target := pg_current_wal_flush_lsn();') },
  { name: 'target taken before the commit is observed', scenario: scnOrder, pause: true,
    sql: withPause(mutate(mutate(READ_FN, `${TARGET}\n`, ''), PAUSE_AT, `${TARGET}\n${PAUSE_AT}`)) }
];
for (const m of MUTANTS) {
  test(`AUD-DM (${m.name}): the baseline passes the scenario and the targeted mutant is detected`, async t => {
    const bx = await fresh(t, 'm3durb');
    if (m.pause) await asOwner(bx.admin, a => a.query(withPause(READ_FN)));
    await assertGate(bx.admin, m.pause ? 'instrumented' : 'active');   // the baseline runs the 0017 gate
    const base = await m.scenario(bx);
    const x = await fresh(t, 'm3durm');
    await asOwner(x.admin, a => a.query(m.sql));
    const killed = await m.scenario(x);
    console.log(`# AUD-DM ${m.name}: baseline ${base ? 'DETECTED (unexpected)' : 'clean'}, mutant ${killed ? 'KILLED' : 'SURVIVED'}`);
    assert.equal(base, false, `${m.name}: the unmutated code passes`);
    assert.equal(killed, true, `${m.name}: the mutant is detected`);
  });
}

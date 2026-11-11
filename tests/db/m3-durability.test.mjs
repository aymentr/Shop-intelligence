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
// The crash-based tests (AUD-12a and four mutants) are in tests/crash/m3-durability-crash.test.mjs, a separate CI step,
// so that crash recovery and its aftermath (autovacuum, checkpoint) never overlap the regular suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { asOwner, connect, control, pid, settle } from './helpers.mjs';
import { readEvidence, revokeReader } from './../../dist/persistence/reader.js';
import { MIG10, provisionReaders, fresh, ready, READ, intent, asyncIntent, outcome, crash, writerDelay, intentExists, releaseThenCrash,
         fnText, mutate, READ_FN, WAIT, PAUSE_AT, withPause } from './durability-fixtures.mjs';

test.before(provisionReaders);

test('AUD-12b: flush timeout and uncertainty fail closed; a timed-out intent stays on record and reads once flushed', async t => {
  const x = await fresh(t);
  const { src } = await ready(x);
  const a = await x.c('si_reader_alice');
  await writerDelay('10s');
  try {
    const id = await asyncIntent(a, src);
    const t0 = performance.now();
    const r = await settle(a.query(READ, [src, id, null, 100]));
    const waited = performance.now() - t0;
    assert.equal(outcome(r), 'SI_READ_INTENT_NOT_DURABLE');
    assert.equal(r.code, '55000');
    assert.ok(waited >= 1000 && waited < 1800, `bounded wait (${waited.toFixed(0)} ms)`);
    const lib = await readEvidence(a, src, { intentId: id, limit: 100 }).catch(e => e);
    assert.deepEqual([lib.code, lib.retryable], ['INTENT_NOT_DURABLE', false], 'library: a fixed code; start a new read');
    assert.equal((await x.admin.query('SELECT state FROM si.read_intents WHERE intent_id = $1', [id])).rows[0].state, 'OPEN', 'the request stays on record');
    await x.admin.query('INSERT INTO public.flushme VALUES (1)');             // a synchronous write commit flushes the intent
    assert.equal((await a.query(READ, [src, id, null, 100])).rows.length, 2, 'once durable, the same intent reads');
  } finally { await writerDelay(null); }
  // Uncertainty: ids whose transaction cannot be established are refused with a fixed code, never a raw error.
  const real = await intent(a, src);
  const future = `00000000fffffff0${real.replace(/-/g, '').slice(16)}`;      // a transaction id far in the future
  const random = '9f1c2b3a-4d5e-4f60-8a7b-1c2d3e4f5a6b';                      // high bit set, foreign layout
  for (const bad of [future, random, '00000000-0000-0000-0000-000000000000']) {
    const r = await settle(a.query(READ, [src, bad, null, 100]));
    assert.deepEqual([r.code, outcome(r)], ['42501', 'SI_READ_INTENT_INVALID'], bad);
  }
  // An id whose transaction id is real and committed but belongs to another row is refused.
  const other = await intent(a, src);
  const forged = `${real.replace(/-/g, '').slice(0, 16)}${other.replace(/-/g, '').slice(16)}`;
  assert.equal(outcome(await settle(a.query(READ, [src, forged, null, 100]))), 'SI_READ_INTENT_INVALID');
});

test('AUD-12c: the commit is observed before the WAL target is taken (concurrent creating transaction)', async t => {
  const x = await fresh(t);
  const { src } = await ready(x);
  const a = await x.c('si_reader_alice'), b = await x.c('si_reader_alice');
  // The id is known before its transaction commits (another session of the same login): refused, never released.
  await a.query('BEGIN');
  const id = await intent(a, src);
  const early = await settle(b.query(READ, [src, id, null, 100]));
  await a.query('COMMIT');
  assert.equal(outcome(early), 'SI_READ_INTENT_UNCOMMITTED');
  assert.equal((await b.query(READ, [src, id, null, 100])).rows.length, 2, 'after the (synchronous) commit it reads');
});

// ------------------------------------------------------------------------------------------------
test('AUD-13a: ordinary reads, explicit transactions and savepoints', async t => {
  const x = await fresh(t);
  const { src } = await ready(x, 3);
  const a = await x.c('si_reader_alice');
  const times = [];
  for (let i = 0; i < 50; i++) { const t0 = performance.now(); const p = await readEvidence(a, src); times.push(performance.now() - t0); assert.equal(p.records.length, 3); }
  times.sort((p, q) => p - q);
  console.log(`# AUD-13a ordinary two-step reads: median ${times[25].toFixed(1)} ms, max ${times[49].toFixed(1)} ms (50 reads, no refusal)`);
  assert.ok(times[49] < 500, 'ordinary synchronous reads do not wait for the gate');
  // Inside an explicit transaction and a savepoint, a committed intent reads; one created in the transaction does not.
  const id = await intent(a, src);
  await a.query('BEGIN'); await a.query('SAVEPOINT s');
  assert.equal((await a.query(READ, [src, id, null, 100])).rows.length, 3);
  await a.query('ROLLBACK TO s');
  const own = await intent(a, src);
  await a.query('RELEASE s');
  assert.equal(outcome(await settle(a.query(READ, [src, own, null, 100]))), 'SI_READ_INTENT_UNCOMMITTED');
  await a.query('ROLLBACK');
  // An asynchronous read session is refused (its own commit would not be durable either).
  const id2 = await intent(a, src);
  await a.query('SET synchronous_commit = off');
  assert.equal(outcome(await settle(a.query(READ, [src, id2, null, 100]))), 'SI_READ_UNSAFE_SESSION');
  await a.query('RESET synchronous_commit');
  assert.equal((await a.query(READ, [src, id2, null, 100])).rows.length, 3, 'the same intent reads from a safe session');
});

test('AUD-13b: concurrent transactions — an unrelated open writer fails closed then a new read succeeds; one intent, one release', async t => {
  const x = await fresh(t);
  const { src } = await ready(x);
  const a = await x.c('si_reader_alice'), w = await x.c();
  const id = await intent(a, src);
  await w.query('BEGIN'); await w.query('INSERT INTO public.flushme SELECT generate_series(1, 20)');   // WAL after the intent, unflushed
  const r1 = await settle(a.query(READ, [src, id, null, 100]));
  const fresh2 = await readEvidence(a, src);                                   // a new intent commits synchronously: it flushes
  await w.query('ROLLBACK');
  console.log(`# AUD-13b with an unrelated open writer: ${outcome(r1)}; a new read: ${fresh2.records.length} records`);
  assert.ok(['SI_READ_INTENT_NOT_DURABLE', 'ok:2'].includes(outcome(r1)), 'fails closed unless something flushed meanwhile');
  assert.equal(fresh2.records.length, 2);
  // Racing readers on one intent still release exactly once.
  const id2 = await intent(a, src);
  const racers = await Promise.all(Array.from({ length: 6 }, () => x.c('si_reader_alice')));
  const res = await Promise.all(racers.map(c => settle(c.query(READ, [src, id2, null, 100]))));
  assert.equal(res.filter(r => r.status === 'ok').length, 1);
});

test('AUD-13c: cancellation, revocation and retention expiry while the gate waits; emergency controls are not blocked', async t => {
  const x = await fresh(t);
  const c1 = await ready(x), c2 = await ready(x), c3 = await ready(x);
  const a = await x.c('si_reader_alice');
  const ap = await pid(a);
  await writerDelay('10s');
  try {
    // Cancellation during the wait: nothing released, the request stays OPEN.
    const id = await asyncIntent(a, c1.src);
    const p = settle(a.query(READ, [c1.src, id, null, 100]));
    await sleep(300);
    await x.admin.query('SELECT pg_cancel_backend($1)', [ap]);
    const r = await p;
    assert.equal(r.code, '57014');
    assert.equal((await x.admin.query('SELECT state FROM si.read_intents WHERE intent_id = $1', [id])).rows[0].state, 'OPEN');
    // A waiting read holds no lock: SUSPEND and revocation complete at once. The waiting read never releases
    // rows (it times out, or passes once the controls' own synchronous commits flush and then sees SUSPEND).
    const id2b = await intent(a, c2.src);                                      // taken before the revocation (and before id2, so it cannot flush id2)
    const id2 = await asyncIntent(a, c2.src);
    const waiting = settle(a.query(READ, [c2.src, id2, null, 100]));
    await sleep(200);
    const waits = [];
    for (const fn of [() => control(x.ra, c2.src, 'SUSPEND'), () => revokeReader(x.ra, 'si_reader_alice', c2.src, 'revoked while the gate waits')]) {
      const s = performance.now(); await fn(); waits.push(performance.now() - s);
    }
    const w = await waiting;
    console.log(`# AUD-13c control / revocation while a read waits in the durability gate: ${waits.map(v => v.toFixed(0)).join(' / ')} ms; the waiting read: ${outcome(w)}`);
    assert.ok(Math.max(...waits) < 300, 'emergency controls are not blocked by the gate');
    assert.ok(['SI_READ_INTENT_NOT_DURABLE', 'ok:0', 'SI_READ_NOT_AUTHORIZED'].includes(outcome(w)), 'the waiting read released nothing');
    await x.admin.query('INSERT INTO public.flushme VALUES (1)');             // flush (the 10 s writer fixture is still active)
    assert.equal(outcome(await settle(a.query(READ, [c2.src, id2b, null, 100]))), 'SI_READ_NOT_AUTHORIZED', 'revocation is enforced after the gate');
  } finally { await writerDelay(null); }
  // Retention expiry between intent and read: empty page.
  const id3 = await intent(a, c3.src);
  await x.admin.query('BEGIN'); await x.admin.query('SET LOCAL session_replication_role = replica');
  await x.admin.query(`UPDATE si.collection_runs SET retain_until = clock_timestamp() - interval '1 minute' WHERE run_id = $1`, [c3.run.run_id]);
  await x.admin.query('COMMIT');
  assert.equal((await a.query(READ, [c3.src, id3, null, 100])).rows.length, 0);
});

// Negative-control mutants of the 0010 read that do not need a crash.
async function scnSession(x) {                                                   // detected = an asynchronous read session is served
  const { src } = await ready(x);
  const a = await x.c('si_reader_alice');
  const id = await intent(a, src);
  await a.query('SET synchronous_commit = off');
  return outcome(await settle(a.query(READ, [src, id, null, 100]))).startsWith('ok');
}
async function scnUncertain(x) {                                                 // detected = a foreign transaction id raises a raw error
  const { src } = await ready(x);
  const a = await x.c('si_reader_alice');
  const r = await settle(a.query(READ, [src, '00000000-ffff-fff0-8000-000000000000', null, 100]));
  return outcome(r) !== 'SI_READ_INTENT_INVALID';
}
const MUTANTS = [
  { name: 'read-session synchronous_commit check removed', scenario: scnSession,
    sql: mutate(READ_FN, `CASE WHEN current_setting('synchronous_commit') = 'off' THEN 'synchronous_commit' END`, 'NULL') },
  { name: 'uncertain transaction id not mapped to a fixed code', scenario: scnUncertain,
    sql: mutate(READ_FN, `  EXCEPTION WHEN OTHERS THEN`, `  EXCEPTION WHEN division_by_zero THEN`) }
];
for (const m of MUTANTS) {
  test(`AUD-DM (${m.name}): the baseline passes the scenario and the targeted mutant is detected`, async t => {
    const bx = await fresh(t, 'm3durb');
    if (m.pause) await asOwner(bx.admin, a => a.query(withPause(READ_FN)));
    const base = await m.scenario(bx);
    const x = await fresh(t, 'm3durm');
    await asOwner(x.admin, a => a.query(m.sql));
    const killed = await m.scenario(x);
    console.log(`# AUD-DM ${m.name}: baseline ${base ? 'DETECTED (unexpected)' : 'clean'}, mutant ${killed ? 'KILLED' : 'SURVIVED'}`);
    assert.equal(base, false, `${m.name}: the unmutated code passes`);
    assert.equal(killed, true, `${m.name}: the mutant is detected`);
  });
}

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
// Runs in the isolated durability CI step (with tests/crash/m3-durability-crash.test.mjs): AUD-12b and AUD-13c
// widen the WAL writer interval (superuser fixture). Since M4-P1.1 (D2) the fixture returns only once the requested
// writer behaviour is measured (writerDelay in tests/db/durability-fixtures.mjs), so a test that follows a restore,
// such as AUD-13a after AUD-12b, starts with the default writer verifiably back; AUD-FX checks exactly that.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { asOwner, connect, control, pid, settle } from '../db/helpers.mjs';
import { readEvidence, revokeReader } from '../../dist/persistence/reader.js';
import { provisionReaders, fresh, ready, READ, intent, asyncIntent, outcome, crash, writerDelay, intentExists, releaseThenCrash,
         fnText, mutate, READ_FN, TARGET, WAIT, PAUSE_AT, withPause, strayWalFlushMs, warm, assertGate } from '../db/durability-fixtures.mjs';

test.before(provisionReaders);

// ------------------------------------------------------------------------------------------------
// M4-P1.2 (R3): direct measurement of the durability gate instead of a wall-clock bound.
const MIG09 = readFileSync(new URL('../../db/migrations/0009_read_audit.up.sql', import.meta.url), 'utf8');
const BEGIN_FN = fnText(MIG09, 'CREATE FUNCTION si.si_begin_read', 'END $begin_read$;').replace(/^CREATE FUNCTION/, 'CREATE OR REPLACE FUNCTION');
/** The production read with ONE added statement: a NOTICE reporting the gate's target, the flush position when the
 *  target was taken, and the time spent in the wait loop. Everything else is the ACTIVE text (0017), byte for byte. */
const GATE_FN = mutate(mutate(mutate(READ_FN,
  '  deadline timestamptz;\n', '  deadline timestamptz;\n  gate_f0 pg_lsn;\n  gate_t0 timestamptz;\n  gate_n int := 0;\n'),
  `${TARGET}\n`, `${TARGET}\n  gate_f0 := pg_current_wal_flush_lsn();\n`),
  '  deadline := clock_timestamp() + interval \'1 second\';\n', '  gate_t0 := clock_timestamp();\n  deadline := clock_timestamp() + interval \'1 second\';\n')
  .replace('    PERFORM pg_sleep(0.005);\n  END LOOP;\n', "    gate_n := gate_n + 1;\n    PERFORM pg_sleep(0.005);\n  END LOOP;\n  RAISE NOTICE 'SI_GATE %|%|%|%', target, gate_f0, gate_n, round(extract(epoch FROM clock_timestamp() - gate_t0) * 1000, 3);\n");
/**
 * n two-step reads, single attempt each (no retry hides anything). For each read: the flush position observed right
 * after its intent committed (`f`), and, from the WAL itself (pg_walinspect), the end of that intent's COMMIT record.
 * With the instrumented copy installed, also the gate's own report (target, flush at target, wait in ms).
 */
async function measuredReads(x, a, src, n, records, { strayAfterIntent = false } = {}) {
  await x.admin.query('CREATE EXTENSION IF NOT EXISTS pg_walinspect');
  const notices = [];
  const onNotice = m => { if (/^SI_GATE /.test(m.message)) notices.push(m.message.slice(8).split('|')); };
  a.on('notice', onNotice);
  const start = (await x.admin.query('SELECT pg_current_wal_insert_lsn() AS l')).rows[0].l;
  const reads = [];
  try {
    for (let i = 0; i < n; i++) {
      const id = await intent(a, src);                                          // si_begin_read in autocommit: a synchronous commit
      const f = (await x.admin.query('SELECT pg_current_wal_flush_lsn() AS f')).rows[0].f;
      if (strayAfterIntent) {                                                   // unrelated WAL after the intent, left to the WAL writer
        await x.admin.query('BEGIN'); await x.admin.query('SET LOCAL synchronous_commit = off');
        await x.admin.query('INSERT INTO public.flushme VALUES (2)'); await x.admin.query('COMMIT');
      }
      const before = notices.length;
      const t0 = performance.now(); const r = await settle(a.query(READ, [src, id, null, 100])); const ms = performance.now() - t0;
      reads.push({ id, f, ms, outcome: outcome(r), gate: notices.length > before ? notices[notices.length - 1] : null });
    }
  } finally { a.off('notice', onNotice); }
  await x.admin.query('INSERT INTO public.flushme VALUES (0)');                // a synchronous commit: everything above is now flushed
  const q = await x.admin.query(`                                               -- (pg_walinspect reads flushed WAL only; the measurements were taken before)
    WITH c AS (SELECT xid::text AS xid, end_lsn FROM pg_get_wal_records_info($1::pg_lsn, pg_current_wal_flush_lsn())
                WHERE resource_manager = 'Transaction' AND record_type LIKE 'COMMIT%'),
         r AS (SELECT * FROM unnest($2::uuid[], $3::pg_lsn[], $4::pg_lsn[], $5::pg_lsn[]) AS u(id, f, target, f0))
    SELECT r.id::text, c.end_lsn IS NOT NULL AS found, r.f >= c.end_lsn AS durable_before_read,
           CASE WHEN r.f0 IS NULL THEN NULL ELSE r.f0 >= c.end_lsn END AS durable_at_gate,
           CASE WHEN r.target IS NULL THEN NULL ELSE r.target >= c.end_lsn END AS target_covers_intent,
           CASE WHEN r.target IS NULL THEN NULL ELSE r.f0 < r.target END AS unflushed_at_target
      FROM r JOIN si.read_intents i ON i.intent_id = r.id
      LEFT JOIN c ON c.xid = (i.created_xid::text::bigint % 4294967296)::text`,
    [start, reads.map(r => r.id), reads.map(r => r.f), reads.map(r => r.gate?.[0] ?? null), reads.map(r => r.gate?.[1] ?? null)]);
  const byId = new Map(q.rows.map(r => [r.id, r]));
  for (const r of reads) Object.assign(r, byId.get(r.id), { waitLoops: r.gate ? Number(r.gate[2]) : null, gateMs: r.gate ? Number(r.gate[3]) : null });
  return reads;
}
/** AUD-13a's property, strictly: every read's own intent was durable before the read started and (with the copy) at the
 *  gate; the gate's target covers the intent; every outcome is a release or a fail-closed refusal, never another error. */
function assertGateNeverWaitsForOwnIntent(reads, records, label) {
  for (const r of reads) {
    assert.equal(r.found, true, `${label}: the intent's COMMIT record is in the WAL`);
    assert.equal(r.durable_before_read, true, `${label}: the read's own intent was durable before the read (${JSON.stringify(r)})`);
    if (r.gate) {
      assert.equal(r.durable_at_gate, true, `${label}: own intent durable when the gate took its target`);
      assert.equal(r.target_covers_intent, true, `${label}: the gate's target covers the intent's commit`);
      // (one direction only: the flush can advance between taking the target and the loop's first check)
      if (r.waitLoops > 0) assert.equal(r.unflushed_at_target, true, `${label}: the gate waits only while WAL beyond the read's own (durable) commit is unflushed`);
    }
    assert.ok([`ok:${records}`, 'SI_READ_INTENT_NOT_DURABLE'].includes(r.outcome), `${label}: ${r.outcome}`);
  }
}

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
  await writerDelay(null);                                                    // required environment: the default writer, verified
  const x = await fresh(t);
  const { src } = await ready(x);
  await warm(x, src);                                                         // single-attempt reads below: absorb first-touch pruning
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
// AUD-FX (M4-P1.1, D2): the writer fixture establishes what it claims, both ways, under adverse timing (no pause at
// all between the restore and the next reads), repeatedly. Ordinary reads right after each restore never wait.
test('AUD-FX: the WAL-writer fixture is verified both ways; reads right after a restore do not wait in the gate', async t => {
  const x = await fresh(t);
  const { src } = await ready(x, 3);
  await warm(x, src);
  const a = await x.c('si_reader_alice');
  const k = await connect();
  t.after(() => k.end().catch(() => {}));
  const worst = [];
  for (let cycle = 0; cycle < 3; cycle++) {
    await writerDelay('10s');
    try {
      assert.ok(await strayWalFlushMs(k, 500) >= 500, 'widened: stray WAL stays unflushed');
      const id = await asyncIntent(a, src);
      assert.equal(outcome(await settle(a.query(READ, [src, id, null, 100]))), 'SI_READ_INTENT_NOT_DURABLE', 'widened: an asynchronous intent fails closed');
    } finally { await writerDelay(null); }
    const r = await measuredReads(x, a, src, 20, 3);                         // no pause at all after the restore
    assertGateNeverWaitsForOwnIntent(r, 3, `cycle ${cycle}: right after the verified restore`);
    worst.push(`own intent durable ${r.filter(z => z.durable_before_read).length}/20, refused ${r.filter(z => z.outcome !== 'ok:3').length}, max ${Math.max(...r.map(z => z.ms)).toFixed(1)} ms`);
  }
  console.log(`# AUD-FX ordinary reads right after each verified restore: ${worst.join(' / ')}`);
});

test('AUD-13a: ordinary reads, explicit transactions and savepoints', async t => {
  await writerDelay(null);                                                    // required environment: the default writer, verified
  const x = await fresh(t);
  const { src } = await ready(x, 3);
  await warm(x, src);                                                         // absorb first-touch pruning of the fresh database
  const a = await x.c('si_reader_alice');
  // M4-P1.2 (R3): measure the gate directly. (1) The production function: for each of 50 single-attempt reads, the
  // read's own intent commit (located in the WAL) was flushed before the read started, so the gate cannot wait for it.
  const prod = await measuredReads(x, a, src, 50, 3);
  assertGateNeverWaitsForOwnIntent(prod, 3, 'production gate');
  // (2) A copy of the production function that differs by one NOTICE reports the gate's own view: the flush position at
  // target capture covers the read's own commit on every read, and any wait is for WAL beyond it (unrelated).
  await asOwner(x.admin, k => k.query(GATE_FN));
  await warm(x, src);                     // replacing a function leaves dead pg_proc tuples: absorb their first-touch pruning (R4)
  const inst = await measuredReads(x, a, src, 50, 3);
  assert.equal(inst.filter(r => r.gate).length, inst.filter(r => r.outcome === 'ok:3').length, 'every released read reported its gate');
  assertGateNeverWaitsForOwnIntent(inst, 3, 'instrumented gate');
  // (3) M4-P1.2-ACCEPT-01 follow-up: exercise the wait branch deterministically. After each read's intent has committed
  // (synchronously, so it is durable), another session commits ASYNCHRONOUSLY: unrelated WAL beyond the read's own commit
  // that only the WAL writer flushes. The gate must wait for it (never for the read's own intent) and then release.
  const stray = await measuredReads(x, a, src, 5, 3, { strayAfterIntent: true });
  assertGateNeverWaitsForOwnIntent(stray, 3, 'instrumented gate with unrelated unflushed WAL');
  const strayWaited = stray.filter(r => r.gate && r.waitLoops > 0);
  assert.ok(strayWaited.length >= 1, `the wait branch is exercised: ${JSON.stringify(stray.map(r => [r.outcome, r.waitLoops, r.unflushed_at_target]))}`);
  for (const r of strayWaited) assert.equal(r.unflushed_at_target, true, 'every wait was for WAL beyond the read\'s own durable commit');
  await asOwner(x.admin, k => k.query(READ_FN));                               // restore the ACTIVE production function (0017)
  await assertGate(x.admin, 'active');
  await warm(x, src);                                                          // and again before the single-attempt reads below
  // Refusal bound (follow-up): ordinary single-attempt reads after the warm-up may be refused fail-closed only rarely;
  // a partial liveness regression (e.g. 30 % refusals) fails here. 0 of 1,500 such reads were refused when measured.
  const prodRefused = prod.filter(r => r.outcome !== 'ok:3').length;
  assert.ok(prodRefused <= 2, `at most 2 of 50 ordinary production reads refused fail-closed (got ${prodRefused})`);
  assert.ok(inst.filter(r => r.outcome !== 'ok:3').length <= 2, 'at most 2 of 50 instrumented reads refused fail-closed');
  const ms = prod.map(r => r.ms).sort((p, q) => p - q), waited = inst.filter(r => r.gate && r.waitLoops > 0);
  const instRefused = inst.filter(r => r.outcome !== 'ok:3').length;
  console.log(`# AUD-13a production: ${prod.length} reads, own intent durable before the read on ${prod.filter(r => r.durable_before_read).length}, ` +
              `refused (fail closed) ${prod.filter(r => r.outcome !== 'ok:3').length}, median ${ms[25].toFixed(1)} ms, max ${ms[49].toFixed(1)} ms; ` +
              `instrumented gate (${inst.length} reads, ${instRefused} refused fail-closed): own commit durable at target ${inst.filter(r => r.durable_at_gate).length}/${inst.filter(r => r.gate).length}, ` +
              `gate waited on ${waited.length} (max ${Math.max(0, ...waited.map(r => r.gateMs)).toFixed(1)} ms, each for WAL beyond the read's own commit); ` +
              `with unrelated async WAL: waited on ${strayWaited.length}/${stray.length} (max ${Math.max(0, ...strayWaited.map(r => r.gateMs)).toFixed(1)} ms)`);
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
async function scnAsyncIntentCommit(x) {                                        // detected = a read starts with its own intent not durable
  const { src } = await ready(x);
  await warm(x, src);
  const a = await x.c('si_reader_alice');
  await writerDelay('10s');                                                       // deterministic: nothing else flushes an async commit
  try { const r = await measuredReads(x, a, src, 5, 2); return !r.every(z => z.durable_before_read); }
  finally { await writerDelay(null); }
}
const MUTANTS = [
  { name: 'read-session synchronous_commit check removed', scenario: scnSession,
    sql: mutate(READ_FN, `CASE WHEN current_setting('synchronous_commit') = 'off' THEN 'synchronous_commit' END`, 'NULL') },
  { name: 'uncertain transaction id not mapped to a fixed code', scenario: scnUncertain,
    sql: mutate(READ_FN, `  EXCEPTION WHEN OTHERS THEN`, `  EXCEPTION WHEN division_by_zero THEN`) },
  { name: 'intent committed asynchronously (AUD-13a measurement, M4-P1.2 R3)', scenario: scnAsyncIntentCommit,
    sql: mutate(BEGIN_FN, '  INSERT INTO si.read_intents', "  PERFORM set_config('synchronous_commit', 'off', true);\n  INSERT INTO si.read_intents") }
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

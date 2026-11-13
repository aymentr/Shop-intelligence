// B-002 M3-R35 (migration 0017): the corrected gate never releases on unflushed WAL, at or near a page boundary, and a
// release at a boundary survives crash recovery. The WAL writer interval is widened to 10 s by the VERIFIED writer
// fixture, so WAL a test leaves unflushed stays unflushed while the gate decides (1 s). Restarts PostgreSQL (crash job):
//   node tests/db/run.mjs tests/crash/m3-r35-durability.test.mjs
//
//   R35-U1  an unflushed record mid-page after the intent                      -> refused (fail closed)
//   R35-U2  an unflushed record ending exactly on a page boundary              -> refused (the normalized target, the
//           boundary, is not flushed)
//   R35-U3  a boundary flushed by a commit, then a small unflushed record      -> refused (an over-broad normalization
//           would release it)
//   R35-C1  a durable intent at a flushed boundary is released inside an open transaction, the reader is killed, the
//           cluster recovers: the intent exists (release implies durability)
//   R35-C2  an ASYNCHRONOUSLY committed intent whose commit is not even written: refused, and lost in the crash; the
//           wait-skipped mutant releases rows for it and loses it (S13)
//   R35-C3  an asynchronous intent on a page completed by a boundary record: written but not flushed -> refused (the
//           gate requires the flush, which also covers an OS crash; this cluster runs fsync = off)
//   R35-N   negative controls weakening durability (wait skipped; target floored to its page; small offsets normalized)
//           are each detected by exactly the scenario built for them.
// A scenario counts only if the unflushed WAL is still unflushed after the read (an unrelated flush, e.g. an autovacuum
// commit, voids it and it is rebuilt); a background flush can never produce a pass or a kill.
import test from 'node:test';
import assert from 'node:assert/strict';
import { asOwner, connect, pid, settle } from '../db/helpers.mjs';
import { fresh, ready, intent, asyncIntent, READ, outcome, provisionReaders, warm, writerDelay, crash, intentExists, mutate } from '../db/durability-fixtures.mjs';
import { str, lsn, positions, stray, layout, NEW_READ } from '../db/wal-boundary.mjs';

test.before(async () => { await provisionReaders(); await writerDelay('10s'); });
test.after(() => writerDelay(null));

const TARGET = '  target := si.si_durability_target(pg_current_wal_insert_lsn());              -- 0017 (R-35): header bytes excluded';
const FLOOR = "  target := '0/0'::pg_lsn + ((pg_current_wal_insert_lsn() - '0/0'::pg_lsn) - ((pg_current_wal_insert_lsn() - '0/0'::pg_lsn) % 8192));";
const SMALL = "  target := CASE WHEN (pg_current_wal_insert_lsn() - '0/0'::pg_lsn) % 8192 < 512\n" +
              "                 THEN '0/0'::pg_lsn + ((pg_current_wal_insert_lsn() - '0/0'::pg_lsn) - ((pg_current_wal_insert_lsn() - '0/0'::pg_lsn) % 8192))\n" +
              "                 ELSE pg_current_wal_insert_lsn() END;";
export const MUTANTS = {
  'wait skipped': mutate(NEW_READ, '  WHILE pg_current_wal_flush_lsn() < target LOOP', '  WHILE false AND pg_current_wal_flush_lsn() < target LOOP'),
  'target floored to its page': mutate(NEW_READ, TARGET, FLOOR),
  'small page offsets normalized': mutate(NEW_READ, TARGET, SMALL)
};

async function setup(t, mutantSql) {
  const x = await fresh(t, 'r35c');
  const { src } = await ready(x, 2);
  await warm(x, src);
  if (mutantSql) await asOwner(x.admin, a => a.query(mutantSql));
  const alice = await x.c('si_reader_alice');
  await settle(alice.query(READ, [src, '00000000-0000-0000-0000-000000000000', null, 100]));
  return { x, src, alice };
}
/** Unflushed scenarios: returns the read's outcome, rebuilding the scenario while unrelated WAL flushes void it. */
async function unflushed(t, kind, mutantSql) {
  const { x, src, alice } = await setup(t, mutantSql);
  for (let attempt = 1; attempt <= 6; attempt++) {
    const id = await intent(alice, src);                                       // synchronous: the intent itself is durable
    let mark;
    if (kind === 'U1') { await stray(x.admin, 0); mark = (await positions(x.admin)).insert; }
    if (kind === 'U2') { const p = await layout(x.admin, 'page', 'no'); mark = p.end; }
    if (kind === 'U3') { await layout(x.admin, 'page', 'commit'); await stray(x.admin, 0); mark = (await positions(x.admin)).insert; }
    const before = await positions(x.admin);
    // Inside an open transaction: a release commits nothing (so the read itself flushes nothing); rolled back after.
    await alice.query('BEGIN');
    const r = await settle(alice.query(READ, [src, id, null, 100]));
    const after = await positions(x.admin);
    await alice.query('ROLLBACK');
    if (after.flush >= mark) continue;                                         // flushed meanwhile: void, rebuild
    return { outcome: outcome(r), attempts: attempt, insert: str(before.insert), flush: str(before.flush) };
  }
  throw new Error(`${kind}: unrelated WAL flushes voided every attempt`);
}

test('R35-U1..U3: the 0017 gate refuses unflushed WAL mid-page, at a boundary and right after a flushed boundary', async t => {
  for (const kind of ['U1', 'U2', 'U3']) {
    const r = await unflushed(t, kind);
    console.log(`# R35-${kind} 0017: ${r.outcome} (insert ${r.insert}, flush ${r.flush}, ${r.attempts} attempt(s))`);
    assert.equal(r.outcome, 'SI_READ_INTENT_NOT_DURABLE', `${kind}: fail closed`);
  }
});

for (const [name, sql, kill] of [['wait skipped', MUTANTS['wait skipped'], ['U1', 'U2', 'U3']],
                                 ['target floored to its page', MUTANTS['target floored to its page'], ['U3']],
                                 ['small page offsets normalized', MUTANTS['small page offsets normalized'], ['U3']]]) {
  test(`R35-N (${name}): the weakened gate releases unflushed WAL in exactly its scenario(s); the 0017 gate does not`, async t => {
    for (const kind of kill) {
      const base = await unflushed(t, kind);
      const mut = await unflushed(t, kind, sql);
      console.log(`# R35-N ${name} ${kind}: 0017 ${base.outcome}, mutant ${mut.outcome}`);
      assert.equal(base.outcome, 'SI_READ_INTENT_NOT_DURABLE');
      assert.equal(mut.outcome, 'ok:2', `${name}: killed for the intended reason (released on unflushed WAL)`);
    }
  });
}

/** Releases (or not) inside an open transaction, kills the reader's backend, waits for recovery. */
async function readThenCrash(x, src, id) {
  const r = await connect({ user: 'si_reader_alice', database: x.db });
  const rp = await pid(r);
  await r.query('BEGIN');
  const got = await settle(r.query(READ, [src, id, null, 100]));
  await crash(rp);
  await r.end().catch(() => {});
  return { released: got.status === 'ok' && got.value.rows.length > 0, outcome: outcome(got), survived: await intentExists(x.db, id) };
}

test('R35-C1: a durable intent released at a flushed page boundary survives crash recovery', async t => {
  const results = [];
  for (let i = 0; i < 3; i++) {
    const { x, src, alice } = await setup(t);
    const id = await intent(alice, src);
    const p = await layout(x.admin, 'page', 'commit');                       // flushed exactly to the boundary
    const res = await readThenCrash(x, src, id);
    results.push(`${res.outcome}/survived:${res.survived} (insert ${str(p.insert)} flush ${str(p.flush)})`);
    assert.deepEqual([res.released, res.survived], [true, true]);
  }
  console.log(`# R35-C1 ${results.join('; ')}`);
});

const writeLsn = async x => lsn((await x.admin.query('SELECT pg_current_wal_lsn()::text AS w')).rows[0].w);

// An asynchronously committed intent whose commit record is not even WRITTEN when the cluster crashes (an unfinished WAL
// page): the 0017 gate refuses it and it is lost in recovery; the wait-skipped mutant releases rows for it and then
// loses it (S13). Each attempt is verified (write position before the commit end); otherwise void.
test('R35-C2: an unwritten asynchronous intent is refused and lost; the wait-skipped mutant releases it and loses it', async t => {
  const run = async mutantSql => {
    for (let attempt = 1; attempt <= 6; attempt++) {
      const { x, src } = await setup(t, mutantSql);
      const a = await connect({ user: 'si_reader_alice', database: x.db });
      const id = await asyncIntent(a, src);
      await a.end();
      const end = (await positions(x.admin)).insert;
      if ((await writeLsn(x)) >= end) continue;
      const res = await readThenCrash(x, src, id);
      if (res.survived && !res.released) continue;                            // written meanwhile: void
      return res;
    }
    throw new Error('R35-C2: every attempt was voided');
  };
  const base = await run(null), mut = await run(MUTANTS['wait skipped']);
  console.log(`# R35-C2 0017: ${base.outcome} released:${base.released} survived:${base.survived}; wait-skipped mutant: ${mut.outcome} released:${mut.released} survived:${mut.survived}`);
  assert.deepEqual([base.released, base.survived], [false, false], 'nothing released for an intent that was never durable');
  assert.deepEqual([mut.released, mut.survived], [true, false], 'the mutant releases rows whose request record is lost (S13)');
});

// The boundary variant: the asynchronous intent's page is completed by a record ending on the boundary, so the page
// is WRITTEN (it survives a PostgreSQL crash with this test cluster's fsync = off) but not FLUSHED. The gate requires
// the flush (the stronger, OS-crash-safe condition): refused. Release always implies survival.
test('R35-C3: an asynchronous intent on a page completed by a boundary record is refused (written, not flushed)', async t => {
  const results = [];
  for (let i = 0; i < 3; i++) {
    const { x, src } = await setup(t);
    const a = await connect({ user: 'si_reader_alice', database: x.db });
    const id = await asyncIntent(a, src);
    await a.end();
    const p = await layout(x.admin, 'page', 'no');
    const w = await writeLsn(x);
    const res = await readThenCrash(x, src, id);
    results.push(`${res.outcome} released:${res.released} survived:${res.survived} (write ${str(w)}, flush ${str(p.flush)}, insert ${str(p.insert)})`);
    assert.equal(res.released, false, 'not released: the boundary is not flushed');
    assert.ok(!res.released || res.survived, 'release implies durability');
  }
  console.log(`# R35-C3 ${results.join('; ')}`);
});

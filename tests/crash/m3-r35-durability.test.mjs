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
//   R35-C3  an intent whose OWN commit is verifiably unflushed (WAL writer stopped, flush <= the position before its
//           commit, before and after the read) while the WAL ends on a page boundary: refused, nothing consumed; the
//           crash outcome is recorded per fsync mode, not asserted
//   R35-N   negative controls weakening durability (wait skipped; target floored to its page; small offsets normalized)
//           are each detected by exactly the scenario built for them.
// A scenario counts only if the unflushed WAL is still unflushed after the read (an unrelated flush, e.g. an autovacuum
// commit, voids it and it is rebuilt); a background flush can never produce a pass or a kill.
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { asOwner, connect, pid, settle } from '../db/helpers.mjs';
import { fresh, ready, intent, asyncIntent, READ, outcome, provisionReaders, warm, writerDelay, crash, intentExists, mutate } from '../db/durability-fixtures.mjs';
import { str, lsn, positions, stray, layout, NEW_READ } from '../db/wal-boundary.mjs';

const REPO = fileURLToPath(new URL('../../', import.meta.url));

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

// R35-C3 (M3-R35.1, C1): the intent's OWN commit is unflushed while the WAL ends on a page boundary. Preconditions are
// established and verified, never assumed or retried; if one cannot be established the test FAILS (no void, no retry):
//   - the WAL writer process is stopped (SIGSTOP, verified in /proc) and autovacuum is off (verified), after a
//     CHECKPOINT: nothing in the cluster flushes WAL unless a session commits synchronously, which this test does not;
//   - L = pg_current_wal_insert_lsn() read by the intent's own session inside its transaction just before its
//     asynchronous COMMIT: the commit record starts at or after L, so flush <= L proves the commit is NOT flushed;
//   - a non-transactional record then ends exactly on a page boundary (insert = boundary + 24);
//   - flush <= L before the read and again after the refusal (flush only grows: it held throughout);
//   - the intent stays OPEN and no access-log row exists.
// After the checks, the reader's backend is killed. Whether the intent survives recovery depends on whether its WAL
// reached the OS (fsync = off, or a process kill that leaves the page cache): RECORDED per fsync mode, never asserted
// as durability (release, not survival, is what the gate controls).
const sh = args => execFileSync('docker', ['compose', 'exec', '-T', 'db', ...args], { cwd: REPO, encoding: 'utf8' });
async function walWriter(admin) { return Number((await admin.query(`SELECT pid FROM pg_stat_activity WHERE backend_type = 'walwriter'`)).rows[0].pid); }
const procState = p => sh(['sh', '-c', `cut -d' ' -f3 /proc/${p}/stat`]).trim();
async function autovacuum(admin, on) {
  await admin.query(on ? 'ALTER SYSTEM RESET autovacuum' : 'ALTER SYSTEM SET autovacuum = off');
  await admin.query('SELECT pg_reload_conf()');
  for (let i = 0; i < 200; i++) {
    const k = await connect();
    try { if ((await k.query(`SELECT current_setting('autovacuum') AS v`)).rows[0].v === (on ? 'on' : 'off')) return; } finally { await k.end(); }
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error('fixture: autovacuum setting not in force');
}

test('R35-C3: an intent whose own commit is unflushed, with WAL ending on a page boundary, is refused and nothing is consumed', async t => {
  const fsync = await (async () => { const k = await connect(); try { return (await k.query(`SELECT current_setting('fsync') AS f`)).rows[0].f; } finally { await k.end(); } })();
  const results = [];
  for (let i = 0; i < 3; i++) {
    const { x, src, alice } = await setup(t);
    await layout(x.admin, 'page', 'writer');                                  // calibrates the layout fixture (flushes) before the scenario
    const a = await x.c('si_reader_alice');
    const r = await connect({ user: 'si_reader_alice', database: x.db });
    await settle(r.query(READ, [src, '00000000-0000-0000-0000-000000000000', null, 100]));  // warm the reading session
    const rp = await pid(r);
    await autovacuum(x.admin, false);
    await x.admin.query('CHECKPOINT');
    const ww = await walWriter(x.admin);
    sh(['kill', '-STOP', String(ww)]);
    let stopped = true;
    try {
      assert.equal(procState(ww), 'T', 'fixture: the WAL writer is stopped');
      await a.query('BEGIN');
      const id = (await a.query('SELECT si.si_begin_read($1, NULL, 100) AS id', [src])).rows[0].id;
      await a.query('SET LOCAL synchronous_commit = off');
      const L = lsn((await a.query('SELECT pg_current_wal_insert_lsn()::text AS l')).rows[0].l);
      await a.query('COMMIT');
      const U = (await positions(x.admin)).insert;
      const p0 = await positions(x.admin);
      if (!(p0.flush <= L)) assert.fail(`fixture precondition not established: the intent's commit is flushed (flush ${str(p0.flush)} > L ${str(L)})`);
      const lay = await layout(x.admin, 'page', 'no');
      const p1 = await positions(x.admin);
      if (!(p1.flush <= L && p1.insert % 8192n === 24n)) assert.fail(`fixture precondition not established before the read: flush ${str(p1.flush)}, L ${str(L)}, insert ${str(p1.insert)}`);
      await r.query('BEGIN');
      const got = await settle(r.query(READ, [src, id, null, 100]));
      const p2 = await positions(x.admin);
      const audit = (await x.admin.query(`SELECT i.state, (SELECT count(*)::int FROM si.reader_access_log l WHERE l.intent_id = i.intent_id) AS logged
                                            FROM si.read_intents i WHERE i.intent_id = $1`, [id])).rows[0];
      if (!(p2.flush <= L)) assert.fail(`fixture precondition broken during the read: flush ${str(p2.flush)} > L ${str(L)}`);
      assert.equal(outcome(got), 'SI_READ_INTENT_NOT_DURABLE', 'refused: the intent is not durable');
      assert.deepEqual(audit, { state: 'OPEN', logged: 0 }, 'nothing consumed, nothing logged');
      await crash(rp);                                                         // also ends the stopped WAL writer
      stopped = false;
      await r.end().catch(() => {}); await a.end().catch(() => {});
      const survived = await intentExists(x.db, id);
      results.push(`refused; L ${str(L)} < commit end <= U ${str(U)}; flush ${str(p2.flush)} (before ${str(p1.flush)}); boundary ${str(lay.end)}, insert ${str(p1.insert)}; after the crash (fsync=${fsync}): intent ${survived ? 'survived' : 'lost'}`);
    } finally {
      if (stopped) { try { sh(['kill', '-CONT', String(ww)]); } catch { /* gone */ } }
      const k = await connect(); try { await autovacuum(k, true); } finally { await k.end(); }
    }
  }
  console.log(`# R35-C3 (fsync=${fsync})\n# ${results.join('\n# ')}`);
});

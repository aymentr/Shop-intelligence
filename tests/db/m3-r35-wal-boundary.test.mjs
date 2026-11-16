// B-002 M3-R35 (migration 0017): the durability gate at WAL page and segment boundaries. Real PostgreSQL 16, synthetic
// sources; WAL layouts built and verified by tests/db/wal-boundary.mjs (superuser fixtures, WAL writer flushing).
//
// The defect: a committed intent whose WAL is entirely flushed was refused (SI_READ_INTENT_NOT_DURABLE after the
// 1 s wait) when the last WAL record ended exactly on a page boundary: pg_current_wal_insert_lsn() is then the first
// usable byte of the next page (boundary + 24; segment start + 40), past the flush pointer (the boundary), and nothing
// can be flushed into the empty page. Every read below is ONE attempt (no retry), on a warmed session, so the gate's
// decision is observed directly.
//   R35-1  the target function: exactly the two header positions are normalized, nothing else
//   R35-2  si_read_evidence (gate copy 1): page boundary, 8 bytes before it, a record crossing it, segment boundary
//   R35-3  si_claim_read_intent (gate copy 2, via si_read_source_availability): the same layouts
//   R35-4  intent states at a boundary: rolled back, uncommitted, replayed, concurrent readers
//   R35-M  the old-target mutant (the 0010/0011 comparison) refuses the durable boundary intents deterministically
//   M4-P3.1-CLOSE-02 (CI #140: R35-M failed twice, an old-gate release after 31 / 75 ms counted as an escape):
//   R35-0  the observed copies of the old gate differ from it only by one decision NOTICE (target, flush at release)
//   R35-V1 positive control: a FOREIGN synchronous commit during the old gate's wait releases it within 100 ms; the
//          evidence oracle classifies it VOID (flush >= target at the decision: WAL after the boundary was flushed by
//          another backend), where the previous elapsed-time rule (void only after >= 100 ms) counted an escape
//   R35-V2 negative control: a gate that releases WITHOUT waiting (flush < target at the decision) is classified ESCAPE,
//          so the oracle still fails the test for the unsafe behavior
// Unflushed WAL, crash recovery and the negative controls that weaken durability: tests/crash/m3-r35-durability.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { asOwner, connect, settle } from './helpers.mjs';
import { fresh, ready, intent, READ, outcome, provisionReaders, warm } from './durability-fixtures.mjs';
import { availabilityCursor } from '../../dist/persistence/intelligence.js';
import { BLK, SEG, SHORT_PHD, LONG_PHD, lsn, str, layout, OLD_READ, OLD_CLAIM, OLD_READ_OBS, OLD_CLAIM_OBS, DECISION_NOTICE, decisionOf, walSince } from './wal-boundary.mjs';

const AVAIL = 'SELECT * FROM si.si_read_source_availability($1, $2)';

test.before(provisionReaders);
const target = async (x, insert) => lsn((await x.admin.query('SELECT si.si_durability_target($1::pg_lsn)::text AS t', [str(insert)])).rows[0].t);

/** One gated call at a verified layout; returns the observation. */
async function atLayout(x, kind, call, prep) {
  const id = await call.intent();
  if (prep) await prep();
  const p = await layout(x.admin, kind);
  const t = await target(x, p.insert);
  const t0 = performance.now();
  const r = await settle(call.read(id));
  return { kind, id, insert: p.insert, flush: p.flush, target: t, outcome: call.outcome(r), ms: performance.now() - t0 };
}
const fmt = o => `${o.kind}: insert ${str(o.insert)} (page +${o.insert % BLK}, segment +${o.insert % SEG}) flush ${str(o.flush)} target ${str(o.target)} -> ${o.outcome} (${o.ms.toFixed(0)} ms)`;
const evidenceCall = (alice, src) => ({ intent: () => intent(alice, src), read: id => alice.query(READ, [src, id, null, 100]), outcome });
const availabilityCall = (alice, src) => ({
  intent: async () => (await alice.query('SELECT si.si_begin_read($1, $2, 1) AS id', [src, availabilityCursor(src)])).rows[0].id,
  read: id => alice.query(AVAIL, [src, id]),
  outcome: r => (r.status === 'ok' ? `ok:${r.value.rows[0].available}` : (String(r.message).match(/^SI_[A-Z_]+/)?.[0] ?? r.code)) });
async function setup(t) {
  const x = await fresh(t, 'r35');
  const { src } = await ready(x, 2);
  await warm(x, src);                                                         // first-access WAL on a new database
  const alice = await x.c('si_reader_alice');
  await settle(alice.query(READ, [src, '00000000-0000-0000-0000-000000000000', null, 100]));   // warm this session
  return { x, src, alice };
}

// ------------------------------------------------------------------------------------------------
test('R35-1: the target is normalized at exactly the two page-header positions, and nowhere else', async t => {
  const x = await fresh(t, 'r35');
  const S = n => str(n), at = async n => S(await target(x, n));
  const seg = 2n * SEG, page = seg + 5n * BLK;
  const cases = [
    [seg + LONG_PHD, seg, 'segment start + 40 -> segment start'],
    [page + SHORT_PHD, page, 'page start + 24 -> page start'],
    [seg + SHORT_PHD, seg + SHORT_PHD, 'first page of a segment, + 24 (inside the long header): unchanged'],
    [page + LONG_PHD, page + LONG_PHD, 'other page, + 40 (a record end): unchanged'],
    [page + 32n, page + 32n, 'record end 8 bytes after a short header: unchanged'],
    [page + 16n, page + 16n, 'inside a header (never an insert position): unchanged'],
    [page, page, 'a page start (a flush/end position): unchanged'],
    [page - 8n, page - 8n, '8 bytes before a page start: unchanged'],
    [seg + BLK + SHORT_PHD, seg + BLK, 'second page of a segment + 24 -> its start'],
    [seg - BLK + SHORT_PHD, seg - BLK, 'last page of a segment + 24 -> its start'],
    [SEG * 4096n + LONG_PHD, SEG * 4096n, 'a high segment (above 4 GB): segment start'],
    [0n + LONG_PHD, 0n, 'the very first segment']
  ];
  for (const [inp, want, label] of cases) assert.equal(await at(inp), S(want), label);
  assert.equal((await x.admin.query('SELECT si.si_durability_target(NULL) AS t')).rows[0].t, null, 'STRICT');
  const geometry = (await x.admin.query('SELECT max_data_alignment, wal_block_size, bytes_per_wal_segment FROM pg_control_init()')).rows[0];
  assert.deepEqual([geometry.max_data_alignment, BigInt(geometry.wal_block_size), BigInt(geometry.bytes_per_wal_segment)], [8, BLK, SEG]);
});

test('R35-2: si_read_evidence releases a durable intent at a page boundary, before it, across it and at a segment boundary', async t => {
  const { x, src, alice } = await setup(t);
  const results = [];
  for (const kind of ['page', 'before', 'cross', 'segment', 'page', 'segment']) results.push(await atLayout(x, kind, evidenceCall(alice, src)));
  console.log(`# R35-2 si_read_evidence\n# ${results.map(fmt).join('\n# ')}`);
  for (const o of results) {
    assert.equal(o.outcome, 'ok:2', fmt(o));
    assert.ok(o.flush >= o.target, 'released only with the target flushed');
    if (o.kind === 'page') assert.deepEqual([o.insert % BLK, o.target], [SHORT_PHD, o.insert - SHORT_PHD], 'the verified page-boundary layout');
    if (o.kind === 'segment') assert.deepEqual([o.insert % SEG, o.target], [LONG_PHD, o.insert - LONG_PHD], 'the verified segment-boundary layout');
    if (o.kind === 'before' || o.kind === 'cross') assert.equal(o.target, o.insert, 'no adjustment off the boundary');
  }
});

test('R35-3: si_claim_read_intent (availability, status, search, history) releases the same layouts', async t => {
  const { x, src, alice } = await setup(t);
  const results = [];
  for (const kind of ['page', 'before', 'cross', 'segment']) results.push(await atLayout(x, kind, availabilityCall(alice, src)));
  console.log(`# R35-3 si_claim_read_intent\n# ${results.map(fmt).join('\n# ')}`);
  for (const o of results) assert.equal(o.outcome, 'ok:true', fmt(o));
});

test('R35-4: at a boundary, rolled-back, uncommitted and replayed intents are still refused; concurrent readers each read once', async t => {
  const { x, src, alice } = await setup(t);
  // Rolled back: the id names an aborted transaction.
  await alice.query('BEGIN');
  const rolled = await intent(alice, src);
  await alice.query('ROLLBACK');
  await layout(x.admin, 'page');
  assert.equal(outcome(await settle(alice.query(READ, [src, rolled, null, 100]))), 'SI_READ_INTENT_INVALID');
  // Uncommitted: created in another session's open transaction.
  const other = await x.c('si_reader_alice');
  await other.query('BEGIN');
  const open = await intent(other, src);
  await layout(x.admin, 'page');
  assert.equal(outcome(await settle(alice.query(READ, [src, open, null, 100]))), 'SI_READ_INTENT_UNCOMMITTED');
  await other.query('ROLLBACK');
  // Replayed: consumed once at a boundary, then refused at the next one.
  const once = await intent(alice, src);
  await layout(x.admin, 'page');
  assert.equal(outcome(await settle(alice.query(READ, [src, once, null, 100]))), 'ok:2');
  await layout(x.admin, 'segment');
  assert.equal(outcome(await settle(alice.query(READ, [src, once, null, 100]))), 'SI_READ_INTENT_USED');
  // Concurrent readers: four sessions, four intents, one boundary; each releases once, each intent is consumed once.
  const readers = [];
  for (let i = 0; i < 4; i++) { const c = await x.c('si_reader_alice'); await settle(c.query(READ, [src, '00000000-0000-0000-0000-000000000000', null, 100])); readers.push({ c, id: await intent(c, src) }); }
  await layout(x.admin, 'page');
  const got = await Promise.all(readers.map(r => settle(r.c.query(READ, [src, r.id, null, 100]))));
  assert.deepEqual(got.map(outcome), ['ok:2', 'ok:2', 'ok:2', 'ok:2']);
  const audit = (await x.admin.query(`SELECT count(*) FILTER (WHERE i.state = 'CONSUMED')::int AS consumed,
      (SELECT count(*)::int FROM si.reader_access_log l WHERE l.intent_id = ANY ($1::uuid[])) AS logged
      FROM si.read_intents i WHERE i.intent_id = ANY ($1::uuid[])`, [readers.map(r => r.id)])).rows[0];
  assert.deepEqual(audit, { consumed: 4, logged: 4 });
  const again = await Promise.all(readers.map(r => settle(r.c.query(READ, [src, r.id, null, 100]))));
  assert.deepEqual(again.map(outcome), Array(4).fill('SI_READ_INTENT_USED'));
});

// ------------------------------------------------------------------------------------------------
// The old-target mutant: the original comparison (0010 / 0011 text) in place of the 0017 gate.
// CLOSE-02 oracle. With the old comparison (flush < target, target = the insert position), a release at a verified
// boundary REQUIRES that WAL after the boundary was flushed during the wait: by another backend (a commit, the
// background writer's RUNNING_XACTS record, autovacuum) or by the reader's own heap access (pruning). Such a release
// says nothing about the gate and is VOID: the case is rebuilt (at most 5 times, each void logged with the WAL records
// found after the boundary). The gate's own decision inputs (NOTICE of the observed copy) decide it: a release with
// flush >= target is void; a release with flush < target is an ESCAPE and is counted (the test then fails).
const classify = (o, notices) => {
  if (!o.outcome.startsWith('ok')) return 'REFUSED';
  const d = decisionOf(notices);
  return d && d.flush >= d.target ? 'VOID' : 'ESCAPE';
};
async function observed(x, kind, call, alice) {
  const notices = []; const on = n => notices.push(n.message); alice.on('notice', on);
  try {
    const o = await atLayout(x, kind, call, () => x.admin.query('VACUUM si.read_intents'));   // no dead intents left to prune
    return { ...o, cls: classify(o, notices), decision: decisionOf(notices) };
  } finally { alice.off('notice', on); }
}
test('R35-0: the observed copies of the old gate differ from it by exactly one decision NOTICE', () => {
  assert.equal(OLD_READ_OBS.replace(DECISION_NOTICE, ''), OLD_READ);
  assert.equal(OLD_CLAIM_OBS.replace(DECISION_NOTICE, ''), OLD_CLAIM);
  assert.equal(OLD_READ_OBS.split(DECISION_NOTICE).length, 2); assert.equal(OLD_CLAIM_OBS.split(DECISION_NOTICE).length, 2);
});
test('R35-M: the old-target mutant refuses durable intents at page and segment boundaries (deterministic); the 0017 gate releases them', async t => {
  const rows = [];
  for (const [label, sql] of [['0017', null], ['old target (0010/0011)', [OLD_READ_OBS, OLD_CLAIM_OBS]]]) {
    const { x, src, alice } = await setup(t);
    if (sql) {
      for (const s of sql) await asOwner(x.admin, a => a.query(s));
      await settle(alice.query(READ, [src, '00000000-0000-0000-0000-000000000000', null, 100]));   // first call of the replaced gate: before any layout
    }
    const once = async (kind, call) => {
      for (let v = 0; ; v++) {
        const o = await observed(x, kind, call, alice);
        if (!(sql && kind !== 'before' && o.cls === 'VOID') || v >= 5) return o;
        const w = await walSince(x.admin, o.insert);
        console.log(`# R35-M void ${v + 1} (flush ${str(o.decision.flush)} >= target ${str(o.decision.target)} at the decision; WAL after the boundary: ${w.slice(0, 4).map(r => `${r.rm}/${r.rt}/xid ${r.xid}`).join(', ')}): ${fmt(o)}`);
      }
    };
    const res = [];
    for (const kind of ['page', 'segment', 'page', 'segment', 'before']) res.push(await once(kind, evidenceCall(alice, src)));
    for (const kind of ['page', 'segment']) res.push({ ...(await once(kind, availabilityCall(alice, src))), kind: `${kind} (claim)` });
    rows.push([label, res]);
    console.log(`# R35-M ${label}\n# ${res.map(o => `${fmt(o)}${sql && o.kind !== 'before' ? ` [${o.cls}]` : ''}`).join('\n# ')}`);
  }
  const [prod, old] = rows.map(r => r[1]);
  assert.deepEqual(prod.map(o => o.outcome), ['ok:2', 'ok:2', 'ok:2', 'ok:2', 'ok:2', 'ok:true', 'ok:true']);
  assert.deepEqual(old.map(o => o.outcome), ['SI_READ_INTENT_NOT_DURABLE', 'SI_READ_INTENT_NOT_DURABLE', 'SI_READ_INTENT_NOT_DURABLE',
    'SI_READ_INTENT_NOT_DURABLE', 'ok:2', 'SI_READ_INTENT_NOT_DURABLE', 'SI_READ_INTENT_NOT_DURABLE'], 'killed for the intended reason');
  assert.deepEqual(old.filter(o => o.kind !== 'before').map(o => o.cls), Array(6).fill('REFUSED'), 'every boundary case refused (no escape, voids rebuilt)');
  for (const o of [...prod, ...old]) {                                       // every observation ran on its verified layout
    if (o.kind.startsWith('page')) assert.equal(o.insert % BLK, SHORT_PHD, fmt(o));
    if (o.kind.startsWith('segment')) assert.equal(o.insert % SEG, LONG_PHD, fmt(o));
    if (o.kind === 'before') assert.equal(o.insert % BLK, BLK - 8n, fmt(o));
  }
  for (const o of old.filter(o => o.outcome === 'SI_READ_INTENT_NOT_DURABLE')) {
    assert.ok(o.ms >= 990, 'refused by the bounded wait, not by another check');
    assert.ok(o.flush < o.insert && o.flush === o.target, 'everything flushed; only the empty page header is "missing"');
  }
});

// ------------------------------------------------------------------------------------------------ CLOSE-02 controls
async function controlSetup(t, gateSql) {
  const { x, src, alice } = await setup(t);
  await asOwner(x.admin, a => a.query(gateSql));
  await settle(alice.query(READ, [src, '00000000-0000-0000-0000-000000000000', null, 100]));
  return { x, src, alice };
}
test('R35-V1: a foreign commit during the old gate\'s wait is classified VOID by evidence (the elapsed-time rule counted it an escape)', async t => {
  const { x, src, alice } = await controlSetup(t, OLD_READ_OBS);
  const bg = await connect({ database: x.db }); t.after(() => bg.end().catch(() => {}));
  const notices = []; alice.on('notice', n => notices.push(n.message));
  const id = await intent(alice, src);
  await x.admin.query('VACUUM si.read_intents');
  const p = await layout(x.admin, 'page');
  const t0 = performance.now();
  const pending = settle(alice.query(READ, [src, id, null, 100]));
  await new Promise(r => setTimeout(r, 15));
  await bg.query('BEGIN'); await bg.query(`SELECT pg_logical_emit_message(true, 'si-r35-foreign', 'x')`); await bg.query('COMMIT');   // foreign synchronous commit
  const r = await pending; const ms = performance.now() - t0;
  const o = { kind: 'page', insert: p.insert, flush: p.flush, target: p.insert, outcome: outcome(r), ms };
  const cls = classify(o, notices), d = decisionOf(notices), w = await walSince(x.admin, p.insert);
  console.log(`# R35-V1 ${o.outcome} after ${ms.toFixed(0)} ms; decision target ${d ? str(d.target) : '-'} flush ${d ? str(d.flush) : '-'}; ${cls}; WAL after the boundary: ${w.slice(0, 4).map(x => `${x.rm}/${x.rt}/xid ${x.xid}`).join(', ')}`);
  assert.equal(o.outcome, 'ok:2', 'the foreign commit released the old gate');
  assert.ok(ms < 100, 'released within 100 ms: the previous rule (void only after >= 100 ms) would have counted an escape');
  assert.equal(d.target, p.insert, 'the gate captured the verified boundary position (the reader wrote nothing before)');
  assert.equal(cls, 'VOID', 'evidence: flush >= target at the decision');
  assert.ok(w.length > 0 && w[0].rm === 'LogicalMessage', 'the first WAL record after the boundary is the foreign message');
});
test('R35-V2: a gate that releases without waiting for the flush is classified ESCAPE (the oracle still kills it)', async t => {
  const NOWAIT = OLD_READ_OBS.replace('  WHILE pg_current_wal_flush_lsn() < target LOOP', '  WHILE false AND pg_current_wal_flush_lsn() < target LOOP');
  assert.notEqual(NOWAIT, OLD_READ_OBS, 'fixture: the wait is removed');
  const { x, src, alice } = await controlSetup(t, NOWAIT);
  const notices = []; alice.on('notice', n => notices.push(n.message));
  const id = await intent(alice, src);
  await x.admin.query('VACUUM si.read_intents');
  const p = await layout(x.admin, 'page');
  const r = await settle(alice.query(READ, [src, id, null, 100]));
  const o = { kind: 'page', insert: p.insert, flush: p.flush, target: p.insert, outcome: outcome(r), ms: 0 };
  const cls = classify(o, notices), d = decisionOf(notices);
  console.log(`# R35-V2 ${o.outcome}; decision target ${str(d.target)} flush ${str(d.flush)}; ${cls}`);
  assert.equal(o.outcome, 'ok:2');
  assert.ok(d.flush < d.target, 'released before the flush reached the target');
  assert.equal(cls, 'ESCAPE');
});

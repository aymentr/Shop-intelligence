// B-002 M4-P1.2 (R4): the first gated requests on databases cloned from an UNVACUUMED template ("cold catalog").
//
// Measured fact (M4-P1.1-ACCEPT-01 and M4-P1.2 Phase 1): on a clone of a template that was migrated but not vacuumed,
// the first single-attempt gated read fails closed with SI_READ_INTENT_NOT_DURABLE on most clones, at migration 0011
// and at 0012 alike (8/8 and 7/8; vacuumed: 0/8 and 0/8). The first catalog and table accesses in the clone prune dead
// tuples left by the migrations; that pruning WAL is inserted before the gate takes its target, and nothing flushes it
// while the idle WAL writer hibernates. This is the production situation after any migration or grant change (R-26).
//
// The regular suite clones a VACUUMED template (tests/db/run.mjs), so that its single-attempt assertions measure what
// they claim. This file keeps the cold case covered: it builds its own unvacuumed template and checks that
//   1. a raw single-attempt read on a cold clone either releases or fails closed (never another error, never a release
//      on a refusal; the refused intent stays OPEN), and the cold condition really occurs (else the scenario is void);
//   2. the library recovers using only its permitted bounded retry (NOT_DURABLE only, at most 3 intents per audited
//      call, every request consumed exactly once), and reports how long the recovery took.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cfg, connect, createSources, dropDatabase, freshDatabase, recordRights, settle } from './helpers.mjs';
import { bootstrapDatabase, provisionReaderPrincipal } from '../../dist/persistence/bootstrap.js';
import { grantReader, NOT_DURABLE_ATTEMPTS } from '../../dist/persistence/reader.js';
import * as INTEL from '../../dist/persistence/intelligence.js';

const CLONES = 6;
test.before(async () => { const a = await connect(); try { await provisionReaderPrincipal(a, 'si_reader_alice', cfg.rolePassword); } finally { await a.end(); } });

async function coldClones(t) {
  const tpl = await freshDatabase(t, 'cold', { migrate: true, fromTemplate: false });     // migrated from scratch, NOT vacuumed
  const names = [];
  for (let i = 0; i < CLONES; i++) {
    const name = tpl.replace(/_test$/, `c${i}_test`);
    const root = await connect();
    try { await root.query(`CREATE DATABASE ${name} TEMPLATE ${tpl}`); } finally { await root.end(); }
    t.after(() => dropDatabase(name));
    const db = await connect({ database: name });
    try { await bootstrapDatabase(db); } finally { await db.end(); }
    names.push(name);
  }
  return names;
}
async function prepare(db) {
  const admin = await connect({ database: db }), ra = await connect({ user: 'si_rights_admin', database: db });
  try { await createSources(admin, ['cold-src'], ['META']); await recordRights(ra, 'cold-src', {}); await grantReader(ra, 'si_reader_alice', 'cold-src', 'cold catalog'); }
  finally { await admin.end(); await ra.end(); }
}
const intents = async db => { const k = await connect({ database: db }); try {
  return (await k.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE state = 'CONSUMED')::int AS consumed FROM si.read_intents`)).rows[0]; } finally { await k.end(); } };

test('COLD-1: a raw single-attempt first read on a cold clone releases or fails closed, and the cold condition occurs', async t => {
  const outcomes = [];
  for (const db of await coldClones(t)) {
    await prepare(db);
    const rd = await connect({ user: 'si_reader_alice', database: db });
    try {
      const id = (await rd.query(`SELECT si.si_begin_read('cold-src', NULL, 10) AS id`)).rows[0].id;
      const r = await settle(rd.query(`SELECT * FROM si.si_read_evidence('cold-src', $1, NULL, 10)`, [id]));
      const o = r.status === 'ok' ? `ok:${r.value.rows.length}` : String(r.message).match(/^SI_[A-Z_]+/)?.[0] ?? `SQLSTATE:${r.code}`;
      assert.ok(['ok:0', 'SI_READ_INTENT_NOT_DURABLE'].includes(o), `${db}: ${o}`);
      if (o !== 'ok:0') {
        assert.equal(r.code, '55000');
        const k = await connect({ database: db });
        try { assert.equal((await k.query('SELECT state FROM si.read_intents WHERE intent_id = $1', [id])).rows[0].state, 'OPEN', 'a refused request stays on record, unconsumed'); }
        finally { await k.end(); }
      }
      outcomes.push(o);
    } finally { await rd.end(); }
  }
  console.log(`# COLD-1 first single-attempt gated read on ${CLONES} cold clones: ${outcomes.join(', ')}`);
  assert.ok(outcomes.includes('SI_READ_INTENT_NOT_DURABLE'),
    'the cold-catalog condition was not reproduced on any clone: the scenario did not exercise what it tests');
});

test('COLD-2: the library recovers on cold clones using only its bounded NOT_DURABLE retry', async t => {
  const report = [];
  for (const db of await coldClones(t)) {
    await prepare(db);
    const rd = await connect({ user: 'si_reader_alice', database: db });
    try {
      const t0 = performance.now();
      const h = await INTEL.advertiserHistory(rd, 'cold-src', 'Northwind Synthetic');     // M4-P2: one server-side page (availability inside)
      const ms = performance.now() - t0;
      assert.deepEqual([h.observations.length, h.availability.state], [0, 'AVAILABLE']);
      const c = await intents(db);
      assert.equal(c.consumed, 1, 'one audited request, consumed exactly once');
      assert.ok(c.n - c.consumed <= NOT_DURABLE_ATTEMPTS - 1, `refused attempts within the bound: ${c.n - c.consumed}`);
      report.push(`${c.n - c.consumed} refused/${Math.round(ms)} ms`);
    } finally { await rd.end(); }
  }
  console.log(`# COLD-2 library history on ${CLONES} cold clones (refused attempts / latency): ${report.join(', ')}`);
});

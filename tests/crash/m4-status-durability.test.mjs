// B-002 M4-P1, INT-19: the reader source status (migration 0011) and, since M4-P1.1, the reader source availability
// (migration 0012) carry the 0010 crash-durability gate and the session checks. Uses the verified wal_writer_delay
// fixture (superuser; tests/db/durability-fixtures.mjs writerDelay), in the isolated durability CI step:
//   node tests/db/run.mjs tests/crash/m4-status-durability.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { cfg, connect, createSources, freshDatabase, recordRights, rejects, roles } from '../db/helpers.mjs';
import { provisionReaderPrincipal } from '../../dist/persistence/bootstrap.js';
import { grantReader } from '../../dist/persistence/reader.js';
import * as INTEL from '../../dist/persistence/intelligence.js';
import { writerDelay } from '../db/durability-fixtures.mjs';

test.before(async () => { const a = await connect(); try { await provisionReaderPrincipal(a, 'si_reader_alice', cfg.rolePassword); } finally { await a.end(); } });
const DAY = 86400000;
const day = k => new Date(Date.UTC(2026, 9, 1) + k * DAY);
const period = (a, b) => ({ from: day(a), to: day(b) });

test('INT-19: the status and availability functions carry the crash-durability gate and the session checks', async t => {
  const db = await freshDatabase(t, 'm4dur');
  const x = await roles(t, db, ['admin', 'si_rights_admin']);
  const src = 'm4-dur-1';
  await createSources(x.admin, [src], ['META']); await recordRights(x.si_rights_admin, src, {});
  await grantReader(x.si_rights_admin, 'si_reader_alice', src, 'm4 durability');
  const alice = await connect({ user: 'si_reader_alice', database: db });
  t.after(() => alice.end().catch(() => {}));
  const p = period(0, 10);
  const asyncIntent = async cursor => {
    await alice.query('BEGIN');
    const id = (await alice.query('SELECT si.si_begin_read($1, $2, 1) AS id', [src, cursor])).rows[0].id;
    await alice.query('SET LOCAL synchronous_commit = off');
    await alice.query('COMMIT');
    return id;
  };
  await writerDelay('10s');
  try {
    const sid = await asyncIntent(INTEL.statusCursor(src, p));
    await rejects(assert, alice.query('SELECT * FROM si.si_read_source_status($1, $2, $3, $4)', [src, sid, p.from, p.to]), { code: '55000', message: /^SI_READ_INTENT_NOT_DURABLE/ });
    const aid = await asyncIntent(INTEL.availabilityCursor(src));
    await rejects(assert, alice.query('SELECT * FROM si.si_read_source_availability($1, $2)', [src, aid]), { code: '55000', message: /^SI_READ_INTENT_NOT_DURABLE/ });
  } finally { await writerDelay(null); }
  await alice.query('SET synchronous_commit = off');
  await rejects(assert, alice.query('SELECT * FROM si.si_read_source_status($1, gen_random_uuid(), $2, $3)', [src, p.from, p.to]), { code: '55000', message: /^SI_READ_UNSAFE_SESSION: synchronous_commit$/ });
  await rejects(assert, alice.query('SELECT * FROM si.si_read_source_availability($1, gen_random_uuid())', [src]), { code: '55000', message: /^SI_READ_UNSAFE_SESSION: synchronous_commit$/ });
  await alice.query('RESET synchronous_commit');
  // Restored environment, verified by the fixture: ordinary audited requests do not wait in the gate.
  const a = await INTEL.sourceAvailability(alice, src);
  assert.deepEqual([a.available, a.reasons], [true, []]);
});

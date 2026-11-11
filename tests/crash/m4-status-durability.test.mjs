// B-002 M4-P1, INT-19: the reader source status (migration 0011) carries the 0010 crash-durability gate and the
// session checks. Uses the wal_writer_delay fixture (superuser), so it runs in the isolated durability CI step after
// the regular suite (the WAL writer can keep the long interval briefly after a reset, which would make unrelated
// later reads fail closed):  node tests/db/run.mjs tests/crash/m4-status-durability.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { cfg, connect, createSources, freshDatabase, recordRights, rejects, roles } from '../db/helpers.mjs';
import { provisionReaderPrincipal } from '../../dist/persistence/bootstrap.js';
import { grantReader } from '../../dist/persistence/reader.js';
import * as INTEL from '../../dist/persistence/intelligence.js';

test.before(async () => { const a = await connect(); try { await provisionReaderPrincipal(a, 'si_reader_alice', cfg.rolePassword); } finally { await a.end(); } });
const DAY = 86400000;
const day = k => new Date(Date.UTC(2026, 9, 1) + k * DAY);
const period = (a, b) => ({ from: day(a), to: day(b) });

test('INT-19: the status function carries the crash-durability gate and the session checks', async t => {
  const db = await freshDatabase(t, 'm4dur');
  const x = await roles(t, db, ['admin', 'si_rights_admin']);
  const src = 'm4-dur-1';
  await createSources(x.admin, [src], ['META']); await recordRights(x.si_rights_admin, src, {});
  await grantReader(x.si_rights_admin, 'si_reader_alice', src, 'm4 durability');
  const alice = await connect({ user: 'si_reader_alice', database: db });
  t.after(() => alice.end().catch(() => {}));
  const p = period(0, 10);
  const k = await connect();
  try { await k.query(`ALTER SYSTEM SET wal_writer_delay = '10s'`); await k.query('SELECT pg_reload_conf()'); } finally { await k.end(); }
  try {
    await new Promise(r => setTimeout(r, 300));
    await alice.query('BEGIN');
    const id = (await alice.query('SELECT si.si_begin_read($1, $2, 1) AS id', [src, INTEL.statusCursor(src, p)])).rows[0].id;
    await alice.query('SET LOCAL synchronous_commit = off');
    await alice.query('COMMIT');
    await rejects(assert, alice.query('SELECT * FROM si.si_read_source_status($1, $2, $3, $4)', [src, id, p.from, p.to]), { code: '55000', message: /^SI_READ_INTENT_NOT_DURABLE/ });
  } finally { const k2 = await connect(); await k2.query('ALTER SYSTEM RESET wal_writer_delay'); await k2.query('SELECT pg_reload_conf()'); await k2.end(); }
  await alice.query('SET synchronous_commit = off');
  await rejects(assert, alice.query('SELECT * FROM si.si_read_source_status($1, gen_random_uuid(), $2, $3)', [src, p.from, p.to]), { code: '55000', message: /^SI_READ_UNSAFE_SESSION: synchronous_commit$/ });
  await alice.query('RESET synchronous_commit');
});

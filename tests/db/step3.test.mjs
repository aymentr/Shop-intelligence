// B-002 Step 3 slice 1: no-delete/no-truncate guard, real disposable PostgreSQL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { asOwner, createSources, freshDatabase, recordRights, rejects, roles } from './helpers.mjs';

const cleanups = [];
const scope = { after: fn => cleanups.push(fn) };
let db, c;
test.before(async () => {
  db = await freshDatabase(scope, 'step3');
  c = await roles(scope, db, ['admin', 'si_rights_admin', 'si_collector']);
  await createSources(c.admin, ['step3-source']);
  await recordRights(c.si_rights_admin, 'step3-source');
});
test.after(async () => { for (const fn of cleanups.reverse()) await fn(); });

test('S3-1: DELETE and TRUNCATE are rejected even for the owner, without losing the run', async () => {
  const result = await c.si_collector.query(
    'SELECT * FROM si.si_begin_run($1,$2,$3,$4,$5::text[])',
    ['step3-source', 'step3-key', 'a'.repeat(64), 'SYNTHETIC', ['META']]
  );
  const runId = result.rows[0].run_id;
  assert.equal(result.rows[0].outcome, 'RUNNING');

  await rejects(assert, asOwner(c.admin, x =>
    x.query('DELETE FROM si.collection_runs WHERE run_id = $1', [runId])),
  { code: '23514', message: /SI_RUN_DELETE_FORBIDDEN/ });

  await rejects(assert, asOwner(c.admin, x =>
    x.query('TRUNCATE si.collection_runs CASCADE')),
  { code: '23514', message: /SI_RUN_DELETE_FORBIDDEN/ });

  const count = await c.admin.query('SELECT count(*)::int AS n FROM si.collection_runs WHERE run_id = $1', [runId]);
  assert.equal(count.rows[0].n, 1);
});

test('S3-2: deletion trigger runs as invoker; collector has no direct DELETE', async () => {
  const r = await c.admin.query(`
    SELECT p.prosecdef AS is_definer
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'si' AND p.proname = 'trg_runs_no_delete'`);
  assert.equal(r.rows[0]?.is_definer, false);
  const perms = await c.admin.query(
    "SELECT pg_catalog.has_table_privilege('si_collector', 'si.collection_runs', 'DELETE') AS can_delete");
  assert.equal(perms.rows[0].can_delete, false);
});

// B-002 Step 3 slice 1: no-delete/no-truncate guard, real disposable PostgreSQL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { asOwner, createSources, freshDatabase, recordRights, rejects, roles } from './helpers.mjs';
import { heartbeatRun, failRun } from '../../dist/persistence/runs.js';

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

test('S3-3: run identity cannot change, and a terminal failure freezes counters', async () => {
  const started = await c.si_collector.query(
    'SELECT * FROM si.si_begin_run($1,$2,$3,$4,$5::text[])',
    ['step3-source', 'step3-transition', 'b'.repeat(64), 'SYNTHETIC', ['META']]
  );
  const id = started.rows[0].run_id;
  await rejects(assert, asOwner(c.admin, x =>
    x.query("UPDATE si.collection_runs SET request_sha256 = $2 WHERE run_id = $1", [id, 'c'.repeat(64)])),
  { code: '23514', message: /SI_RUN_IDENTITY_IMMUTABLE/ });

  await asOwner(c.admin, x =>
    x.query("UPDATE si.collection_runs SET status = 'FAILED', outcome_code = 'SOURCE_ERROR' WHERE run_id = $1", [id]));
  const row = (await c.admin.query('SELECT status, finished_at, lease_token FROM si.collection_runs WHERE run_id = $1', [id])).rows[0];
  assert.equal(row.status, 'FAILED');
  assert.ok(row.finished_at);
  assert.equal(row.lease_token, null);

  await rejects(assert, asOwner(c.admin, x =>
    x.query('UPDATE si.collection_runs SET received_count = 1 WHERE run_id = $1', [id])),
  { code: '23514', message: /SI_RUN_TERMINAL_IMMUTABLE/ });
});

test('S3-4: transition trigger is SECURITY INVOKER, and oversized heartbeat is rejected', async () => {
  const cat = (await c.admin.query(`
    SELECT prosecdef FROM pg_catalog.pg_proc
    WHERE pronamespace = 'si'::regnamespace AND proname = 'trg_runs_transition'`)).rows[0];
  assert.equal(cat.prosecdef, false);
  const started = await c.si_collector.query(
    'SELECT * FROM si.si_begin_run($1,$2,$3,$4,$5::text[])',
    ['step3-source', 'step3-heartbeat', 'd'.repeat(64), 'SYNTHETIC', ['META']]
  );
  await rejects(assert, asOwner(c.admin, x =>
    x.query("UPDATE si.collection_runs SET lease_expires_at = clock_timestamp() + interval '20 minutes' WHERE run_id = $1", [started.rows[0].run_id])),
  { code: '23514', message: /SI_RUN_INVALID_HEARTBEAT/ });
});

test('S3-5: heartbeat requires a live matching token; failure is terminal and idempotent', async () => {
  const started = (await c.si_collector.query(
    'SELECT * FROM si.si_begin_run($1,$2,$3,$4,$5::text[])',
    ['step3-source', 'step3-ops', 'e'.repeat(64), 'SYNTHETIC', ['META']]
  )).rows[0];
  const id = started.run_id, token = started.lease_token;
  assert.equal(await heartbeatRun(c.si_collector, id, '00000000-0000-0000-0000-000000000000'), false);
  assert.equal(await heartbeatRun(c.si_collector, id, token), true);
  assert.equal(await failRun(c.si_collector, id, token, 'SOURCE_ERROR'), true);
  assert.equal(await failRun(c.si_collector, id, token, 'SOURCE_ERROR'), false);
  assert.equal(await heartbeatRun(c.si_collector, id, token), false);
  const row = (await c.admin.query(
    'SELECT status, outcome_code, finished_at, lease_token FROM si.collection_runs WHERE run_id = $1', [id])).rows[0];
  assert.equal(row.status, 'FAILED');
  assert.equal(row.outcome_code, 'SOURCE_ERROR');
  assert.ok(row.finished_at);
  assert.equal(row.lease_token, null);
});

test('S3-6: expired token cannot be renewed or used to fail with an unrelated code', async () => {
  const started = (await c.si_collector.query(
    'SELECT * FROM si.si_begin_run($1,$2,$3,$4,$5::text[])',
    ['step3-source', 'step3-expired', 'f'.repeat(64), 'SYNTHETIC', ['META']]
  )).rows[0];
  const id = started.run_id, token = started.lease_token;
  await asOwner(c.admin, x => x.query(
    "UPDATE si.collection_runs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE run_id = $1", [id]));
  assert.equal(await heartbeatRun(c.si_collector, id, token), false);
  assert.equal(await failRun(c.si_collector, id, token, 'SOURCE_ERROR'), false);
  assert.equal(await failRun(c.si_collector, id, token, 'LEASE_EXPIRED'), true);
  assert.equal((await c.admin.query('SELECT outcome_code FROM si.collection_runs WHERE run_id = $1', [id])).rows[0].outcome_code, 'LEASE_EXPIRED');
});

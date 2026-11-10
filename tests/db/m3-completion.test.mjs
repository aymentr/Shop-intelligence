// B-002 Milestone 3 part 2A (migration 0004): secure completion hardening. Real disposable PostgreSQL.
// The counts-based T2 is gone; si_complete_run(uuid, uuid, jsonb) completes EMPTY runs only, derives
// every count, and refuses a scoped run whose bound fixture is not the empty array.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { asOwner, connect, control, createSources, freshDatabase, recordRights, rejects, roles } from './helpers.mjs';
import { fixtureSha256, requestSha256 } from '../../dist/persistence/request-hash.js';
import { completeRun } from '../../dist/persistence/runs.js';

const CHECK = '23514';
const cleanups = [];
const scope = { after: fn => cleanups.push(fn) };
let db, c, n = 0;
test.before(async () => {
  db = await freshDatabase(scope, 'm3comp');
  c = await roles(scope, db, ['admin', 'si_rights_admin', 'si_collector']);
});
test.after(async () => { for (const fn of cleanups.reverse()) await fn(); });

async function source(networks = ['META']) {
  const id = `cp-${++n}`;
  await createSources(c.admin, [id], networks);
  await recordRights(c.si_rights_admin, id);
  return id;
}
const ROW = id => ({ network: 'META', nativeAdId: id, advertiserName: 'Synthetic Co', countries: ['FR'],
  seenAt: '2026-01-01T00:00:00.000Z', sourceUrl: 'https://example.test/a' });
async function scoped(src, rows) {
  const fx = fixtureSha256(rows), key = `ck${++n}`;
  const sha = requestSha256({ adapterId: src, evidenceKind: 'SYNTHETIC', networks: ['META'], fixtureSha256: fx });
  const r = (await c.si_collector.query('SELECT * FROM si.si_begin_run_scoped($1,$2,$3,$4,$5::text[],$6)', [src, key, sha, 'SYNTHETIC', ['META'], fx])).rows[0];
  return { ...r, key, sha, fx, src };
}
const plain = async src => (await c.si_collector.query("SELECT * FROM si.si_begin_run($1,$2,repeat('a',64),'SYNTHETIC','{META}')", [src, `cl${++n}`])).rows[0];
const T2 = 'SELECT * FROM si.si_complete_run($1::uuid, $2::uuid, $3::jsonb)';
async function rawT2(run, rows = [], token = run.lease_token, x = c.si_collector) {
  await x.query('BEGIN');
  try { const r = (await x.query(T2, [run.run_id, token, JSON.stringify(rows)])).rows[0]; await x.query('COMMIT'); return r; }
  catch (e) { await x.query('ROLLBACK').catch(() => {}); throw e; }
}
const row = async id => (await c.admin.query(`SELECT r.status, r.outcome_code, r.retention_state, r.received_count, r.published_count,
  r.duplicate_count, r.conflict_count, r.suppressed_count, r.lease_token,
  (SELECT count(*)::int FROM si.publication_receipts p WHERE p.run_id = r.run_id) AS receipts
  FROM si.collection_runs r WHERE r.run_id = $1`, [id])).rows[0];
async function untouched(run) {
  const r = await row(run.run_id);
  assert.deepEqual([r.status, r.receipts, r.lease_token], ['RUNNING', 0, run.lease_token], 'nothing written');
}

test('CP-1: a scoped run bound to the empty fixture completes EMPTY with database-derived zero counts', async () => {
  const run = await scoped(await source(), []);
  const out = await rawT2(run, []);
  assert.deepEqual([out.outcome, out.retention_state, out.received_count, out.published_count, out.duplicate_count, out.conflict_count],
    ['COMPLETED', 'EMPTY', 0, 0, 0, 0]);
  const r = await row(run.run_id);
  assert.deepEqual([r.status, r.retention_state, r.received_count, r.published_count, r.duplicate_count, r.conflict_count, r.suppressed_count, r.receipts],
    ['COMPLETED', 'EMPTY', 0, 0, 0, 0, 0, 1]);
  const again = (await c.si_collector.query('SELECT * FROM si.si_begin_run_scoped($1,$2,$3,$4,$5::text[],$6)',
    [run.src, run.key, run.sha, 'SYNTHETIC', ['META'], run.fx])).rows[0];
  assert.deepEqual([again.outcome, again.run_id], ['ALREADY_COMPLETED', run.run_id], 'v1 retry semantics unchanged');
});

test('CP-2: a scoped run bound to a non-empty fixture cannot complete EMPTY (loophole closed); the library fails it', async () => {
  const run = await scoped(await source(), [ROW('1')]);
  await rejects(assert, rawT2(run, []), { code: CHECK, message: /^SI_T2_VALIDATION_FAILED/ });
  await untouched(run);
  assert.deepEqual(await completeRun(c.si_collector, run.run_id, run.lease_token), { outcome: 'FAILED', code: 'VALIDATION_FAILED', failRecorded: true });
  const r = await row(run.run_id);
  assert.deepEqual([r.status, r.outcome_code, r.receipts], ['FAILED', 'VALIDATION_FAILED', 0]);
});

test('CP-3: a legacy unscoped run completes EMPTY as in Milestone 2', async () => {
  const run = await plain(await source());
  assert.equal((await completeRun(c.si_collector, run.run_id, run.lease_token)).outcome, 'COMPLETED');
  assert.deepEqual([(await row(run.run_id)).retention_state, (await row(run.run_id)).receipts], ['EMPTY', 1]);
});

test('CP-4: malformed or oversized payloads are refused before any lock; non-empty payloads need a matching scope; nothing is written', async () => {
  const src = await source();
  const sc = await scoped(src, [ROW('1')]), lg = await plain(src);
  for (const run of [sc, lg]) {
    for (const raw of ['{}', 'null', '"[]"', '0']) {
      await rejects(assert, c.si_collector.query(T2, [run.run_id, run.lease_token, raw]), { code: '22023', message: /^SI_BAD_ARGUMENT/ });
    }
    await rejects(assert, c.si_collector.query('SELECT * FROM si.si_complete_run($1::uuid, $2::uuid, NULL::jsonb)', [run.run_id, run.lease_token]),
      { code: '22023' });
    await rejects(assert, rawT2(run, Array.from({ length: 501 }, (_, i) => ROW(String(i)))), { code: '22023', message: /^SI_BAD_ARGUMENT/ });
    await untouched(run);
  }
  // migration 0005: non-empty payloads are accepted only for a scoped run and only when they match its fixture
  await rejects(assert, rawT2(lg, [ROW('1')]), { code: CHECK, message: /^SI_T2_VALIDATION_FAILED/ });       // REQUEST_SCOPE_MISSING
  await rejects(assert, rawT2(sc, [ROW('2')]), { code: CHECK, message: /^SI_T2_VALIDATION_FAILED/ });       // REQUEST_HASH_MISMATCH
  await untouched(lg); await untouched(sc);
  // shape and bounds are refused before any lock: no wait on a source held FOR UPDATE elsewhere
  await c.admin.query('BEGIN');
  try {
    await c.admin.query('SELECT 1 FROM si.sources WHERE source_id = $1 FOR UPDATE', [src]);
    const x = await connect({ user: 'si_collector', database: db }); cleanups.push(() => x.end());
    await x.query(`SET lock_timeout = '500ms'`);
    await rejects(assert, x.query(T2, [sc.run_id, sc.lease_token, '{}']), { code: '22023' });
  } finally { await c.admin.query('ROLLBACK'); }
});

test('CP-5: wrong lease token and expired lease (scoped run)', async () => {
  const run = await scoped(await source(), []);
  await rejects(assert, rawT2(run, [], '00000000-0000-0000-0000-000000000000'), { code: CHECK, message: /^SI_T2_NOT_OWNER/ });
  assert.deepEqual(await completeRun(c.si_collector, run.run_id, '00000000-0000-0000-0000-000000000000'), { outcome: 'NOT_OWNER' });
  await asOwner(c.admin, x => x.query(`UPDATE si.collection_runs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE run_id = $1`, [run.run_id]));
  await rejects(assert, rawT2(run, []), { code: CHECK, message: /^SI_T2_LEASE_EXPIRED/ });
  assert.deepEqual(await completeRun(c.si_collector, run.run_id, run.lease_token), { outcome: 'FAILED', code: 'LEASE_EXPIRED', failRecorded: true });
});

test('CP-6: authority checks are unchanged and precede the scope check (suspended, retired, changed, terminated)', async () => {
  const cases = [
    ['SOURCE_SUSPENDED', s => control(c.si_rights_admin, s, 'SUSPEND')],
    ['RIGHTS_TERMINATED', s => control(c.si_rights_admin, s, 'TERMINATE_RETENTION')],
    ['SOURCE_RETIRED', s => c.si_rights_admin.query(`UPDATE si.sources SET retired_at = clock_timestamp() + interval '30 seconds' WHERE source_id = $1`, [s])],
    ['RIGHTS_CHANGED', s => recordRights(c.si_rights_admin, s)],
    ['RIGHTS_EXPIRING', s => recordRights(c.si_rights_admin, s, { effective_from_sql: `clock_timestamp() + interval '30 seconds'` })]
  ];
  for (const [code, change] of cases) {
    for (const fixtureRows of [[], [ROW('1')]]) {                                   // honest and lying fixtures
      const src = await source();
      const run = await scoped(src, fixtureRows);
      await change(src);
      await rejects(assert, rawT2(run, []), { code: CHECK, message: new RegExp(`^SI_T2_${code}:`) });
      await untouched(run);
      assert.deepEqual(await completeRun(c.si_collector, run.run_id, run.lease_token), { outcome: 'FAILED', code, failRecorded: true });
    }
  }
});

test('CP-7: a refusal at COMMIT rolls back the receipt and the completion', async () => {
  const src = await source();
  const run = await scoped(src, []);
  await recordRights(c.si_rights_admin, src, { effective_from_sql: `clock_timestamp() + interval '61500 milliseconds'` });
  const x = await connect({ user: 'si_collector', database: db }); cleanups.push(() => x.end());
  await x.query('BEGIN');
  assert.equal((await x.query(T2, [run.run_id, run.lease_token, '[]'])).rows[0].outcome, 'COMPLETED');
  await sleep(2000);
  await rejects(assert, x.query('COMMIT'), { code: CHECK, message: /^SI_T2_RIGHTS_EXPIRING/ });
  await untouched(run);
  // owner bypass of T2: completing a scoped run directly still fails the commit-time check (no receipt)
  const run2 = await scoped(await source(), [ROW('1')]);
  assert.equal(run2.outcome, 'RUNNING');
  await rejects(assert, asOwner(c.admin, y => y.query(`UPDATE si.collection_runs SET status = 'COMPLETED', finished_at = clock_timestamp(),
    rights_checked_at = clock_timestamp(), retention_state = 'EMPTY', publish_control_seq = start_control_seq, lease_token = NULL WHERE run_id = $1`, [run2.run_id])),
  { code: CHECK, message: /^SI_T2_/ });
});

test('CP-8: exactly one T2 overload; no collector-supplied counts; catalog and privileges', async () => {
  const procs = (await c.admin.query(`SELECT p.oid::regprocedure::text AS sig, p.prosecdef, p.proconfig, p.proargnames,
      coalesce((SELECT array_agg(a.grantee::regrole::text ORDER BY 1) FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner), '{}') AS grantees,
      EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public_exec, pg_get_userbyid(p.proowner) AS owner
    FROM pg_proc p WHERE p.proname = 'si_complete_run'`)).rows;
  assert.equal(procs.length, 1);
  const p = procs[0];
  assert.deepEqual([p.sig, p.prosecdef, p.proconfig, p.grantees, p.public_exec, p.owner],
    ['si.si_complete_run(uuid,uuid,jsonb)', true, ['search_path=pg_catalog, pg_temp'], ['si_collector'], false, 'si_owner']);
  assert.deepEqual(p.proargnames.filter(a => a.startsWith('p_')), ['p_run_id', 'p_lease_token', 'p_rows'], 'no count parameters');
  assert.deepEqual(p.proargnames.filter(a => !a.startsWith('p_')), ['outcome', 'run_id', 'retention_state', 'publish_control_seq', 'finished_at',
    'received_count', 'published_count', 'duplicate_count', 'conflict_count'], 'returns status and counts only, never content');
  const run = await plain(await source());
  for (const sql of ['SELECT * FROM si.si_complete_run($1::uuid, $2::uuid, 0, 0, 0, 0)', 'SELECT * FROM si.si_complete_run($1::uuid, $2::uuid, 0)']) {
    await rejects(assert, c.si_collector.query(sql, [run.run_id, run.lease_token]), { code: '42883' });
  }
  for (const role of ['si_rights_admin', 'si_retention', 'si_monitor']) {
    const x = await connect({ user: role, database: db }); cleanups.push(() => x.end());
    await rejects(assert, x.query(T2, [run.run_id, run.lease_token, '[]']), { code: '42501' });
  }
  await c.si_collector.query('SET search_path = public, pg_temp');
  assert.equal((await c.si_collector.query("SELECT outcome FROM si.si_complete_run($1::uuid, $2::uuid)", [run.run_id, run.lease_token])).rows[0].outcome,
    'COMPLETED', 'hostile search_path; the 2-argument call defaults to the empty payload');
  await c.si_collector.query('RESET search_path');
});

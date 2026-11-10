// B-002 Milestone 3 part 1 (migration 0003): request-scope foundation, FD7 option C.
// docs/b002-m3-design.md section 4.2. Real disposable PostgreSQL; synthetic data only.
// Covers M3-T07 and the scope-binding parts of M3-T08 that exist without non-empty T2.
import test from 'node:test';
import assert from 'node:assert/strict';
import { asOwner, connect, control, createSources, expectWaiterError, freshDatabase, holderCommit, lift, pid, recordRights, rejects, roles,
         waitUntilBlocked, waiter } from './helpers.mjs';
import { fixtureSha256, requestSha256 } from '../../dist/persistence/request-hash.js';
import { completeRun, t1PreflightScoped, T1Refused } from '../../dist/persistence/runs.js';

const cleanups = [];
const scope = { after: fn => cleanups.push(fn) };
let db, c, n = 0;
test.before(async () => {
  db = await freshDatabase(scope, 'm3scope');
  c = await roles(scope, db, ['admin', 'si_rights_admin', 'si_collector']);
  await createSources(c.admin, ['sc-a', 'sc-b'], ['META', 'TIKTOK']);
  await createSources(c.admin, ['sc-meta'], ['META']);
  for (const s of ['sc-a', 'sc-b', 'sc-meta']) await recordRights(c.si_rights_admin, s);
});
test.after(async () => { for (const fn of cleanups.reverse()) await fn(); });

const ROW = (id, network = 'META', extra = {}) => ({ network, nativeAdId: id, advertiserName: 'Synthetic Co', countries: ['FR'],
  seenAt: '2026-01-01T00:00:00.000Z', sourceUrl: 'https://example.test/a', ...extra });
/** A v1-consistent scoped request, computed with the unchanged request-hash.ts. */
function req(source, rows, networks = ['META'], ek = 'SYNTHETIC') {
  const fx = fixtureSha256(rows);
  return { source, key: `sk${++n}`, fx, networks, ek, rows,
           sha: requestSha256({ adapterId: source, evidenceKind: ek, networks, fixtureSha256: fx }) };
}
const FIELDS = ['source', 'key', 'sha', 'ek', 'networks', 'fx'];
const scoped = (x, r, o = {}) => x.query('SELECT * FROM si.si_begin_run_scoped($1, $2, $3, $4, $5::text[], $6)',
  FIELDS.map(f => (f in o ? o[f] : r[f]))).then(q => q.rows[0]);
const plainT1 = (x, r, networks = r.networks) => x.query('SELECT * FROM si.si_begin_run($1, $2, $3, $4, $5::text[])',
  [r.source, r.key, r.sha, r.ek, networks]).then(q => q.rows[0]);
const scopeOf = async id => (await c.admin.query(
  'SELECT source_id, evidence_kind, networks, fixture_sha256, hash_version FROM si.run_request_scope WHERE run_id = $1', [id])).rows[0];
const runsFor = async key => (await c.admin.query('SELECT count(*)::int AS n FROM si.collection_runs WHERE request_key = $1', [key])).rows[0].n;
const scopeCount = async () => (await c.admin.query('SELECT count(*)::int AS n FROM si.run_request_scope')).rows[0].n;
const sqlFixture = async rows => (await c.admin.query('SELECT si.si_fixture_sha256_v1($1::jsonb) AS h', [JSON.stringify(rows)])).rows[0].h;
const expire = id => asOwner(c.admin, x => x.query(
  `UPDATE si.collection_runs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE run_id = $1`, [id]));
const insertScopeAsOwner = (runId, o = {}) => asOwner(c.admin, async x => {
  if (o.marker) await x.query(`SELECT set_config('si.scope_binding', $1, true)`, [o.marker]);
  return x.query(`INSERT INTO si.run_request_scope (run_id, source_id, evidence_kind, networks, fixture_sha256, hash_version)
                  VALUES ($1, $2, 'SYNTHETIC', $3::text[], $4, 1)`, [runId, o.source ?? 'sc-a', o.networks ?? ['META'], 'c'.repeat(64)]);
});

test('SC-1 (v1 parity): SQL request and fixture hashes equal request-hash.ts; unreproducible inputs fail closed', async () => {
  const corpus = [
    [], [ROW('1')], [ROW('1'), ROW('2', 'TIKTOK')], [{ b: 'x', a: ['y', 'z'], c: null, d: true, e: false }],
    [{ t: 'Café' }], [{ t: 'Café' }], [{ t: 'quote " backslash \\ slash /' }],
    [{ t: 'ctl \u0001\u0008\t\n\f\r\u001f\u007f' }], [{ t: 'line   para  ' }],
    [{ t: 'emoji 😀 cjk 漢字 rtl عربى' }], [{ nested: { z: { y: [[], {}] } } }], [{ '': 'empty key' }], [ROW('1'), ROW('1')]
  ];
  for (const rows of corpus) assert.equal(await sqlFixture(rows), fixtureSha256(rows), JSON.stringify(rows).slice(0, 60));
  for (const bad of [[{ 'Kéy': 'non-ASCII key' }], [{ n: 1 }], [ROW('1', 'META', { score: 0.5 })]]) {
    await rejects(assert, sqlFixture(bad), { code: '22023', message: /^SI_INVALID_SHAPE/ });
  }
  for (const [adapterId, networks, evidenceKind] of [['sc-a', ['META'], 'SYNTHETIC'], ['sc-b', ['TIKTOK', 'META'], 'SYNTHETIC'],
                                                     ['x-y-z', ['OTHER', 'GOOGLE', 'META', 'PINTEREST', 'TIKTOK'], 'LICENSED']]) {
    const fx = fixtureSha256([ROW('p')]);
    const sql = (await c.admin.query('SELECT si.si_request_sha256_v1($1, $2, $3::text[], $4) AS h', [adapterId, evidenceKind, networks, fx])).rows[0].h;
    assert.equal(sql, requestSha256({ adapterId, evidenceKind, networks, fixtureSha256: fx }), adapterId);
  }
});

test('SC-2 (M3-T07a): the scope records exactly the network array passed to the unchanged si_begin_run', async () => {
  const r = req('sc-a', [ROW('1'), ROW('2', 'TIKTOK')], ['TIKTOK', 'META']);
  const out = await scoped(c.si_collector, r);
  assert.equal(out.outcome, 'RUNNING');
  assert.deepEqual(await scopeOf(out.run_id),
    { source_id: 'sc-a', evidence_kind: 'SYNTHETIC', networks: ['META', 'TIKTOK'], fixture_sha256: r.fx, hash_version: 1 });
  assert.equal(r.fx, await sqlFixture(r.rows), 'the scope is bound to these rows');
  const run = (await c.admin.query('SELECT request_sha256, lease_token FROM si.collection_runs WHERE run_id = $1', [out.run_id])).rows[0];
  assert.deepEqual([run.request_sha256, run.lease_token], [r.sha, out.lease_token], 'the scope belongs to the run T1 returned');
  assert.equal((await c.si_collector.query(`SELECT current_setting('si.scope_binding', true) AS m`)).rows[0].m, '', 'binding marker cleared');
});

test('SC-3 (M3-T07b): inputs not bound by the hash, and malformed inputs, are refused before T1 with no attempt consumed', async () => {
  const r = req('sc-a', [ROW('1')], ['META']);
  const before = await scopeCount();
  for (const o of [{ networks: ['META', 'TIKTOK'] }, { networks: ['TIKTOK'] }, { fx: fixtureSha256([ROW('2')]) },
                   { source: 'sc-b' }, { ek: 'LICENSED' }, { sha: 'f'.repeat(64) }]) {
    await rejects(assert, scoped(c.si_collector, r, o), { code: '22023', message: /^SI_REQUEST_HASH_MISMATCH/ });
  }
  for (const o of [{ networks: ['META', 'META'] }, { networks: [] }, { networks: ['meta'] }, { networks: [null] },
                   { networks: [['META']] }, { networks: null }, { fx: 'zz' }, { fx: null }, { ek: 'synthetic' }, { ek: null },
                   { ek: "SYNTHETIC'; --" }, { sha: 'nothex' }, { source: null }]) {
    await rejects(assert, scoped(c.si_collector, r, o), { code: '22023', message: /^SI_BAD_ARGUMENT/ });
  }
  assert.equal(await runsFor(r.key), 0, 'no attempt consumed');
  assert.equal(await scopeCount(), before, 'no scope written');
});

test('SC-4 (M3-T07c): T1 decisions are unchanged; only a newly created RUNNING attempt gets a scope', async () => {
  const wide = req('sc-meta', [ROW('1')], ['META', 'TIKTOK']);
  const out = await scoped(c.si_collector, wide);
  assert.deepEqual([out.outcome, out.outcome_code], ['REJECTED', 'NETWORK_SCOPE_MISMATCH']);
  assert.equal(await scopeOf(out.run_id), undefined);
  await createSources(c.admin, ['sc-norights']);
  const nr = await scoped(c.si_collector, req('sc-norights', [ROW('1')]));
  assert.deepEqual([nr.outcome, nr.outcome_code], ['REJECTED', 'NO_RIGHTS']);
  assert.equal(await scopeOf(nr.run_id), undefined);
  // ALREADY_COMPLETED returns the existing run and never attaches a scope to it
  const legacy = req('sc-a', [ROW('done')]);
  const first = await plainT1(c.si_collector, legacy);
  assert.equal((await completeRun(c.si_collector, first.run_id, first.lease_token)).outcome, 'COMPLETED');
  const again = await scoped(c.si_collector, legacy);
  assert.deepEqual([again.outcome, again.run_id], ['ALREADY_COMPLETED', first.run_id]);
  assert.equal(await scopeOf(first.run_id), undefined, 'no scope attached to an existing run');
});

test('SC-5 (M3-T07d): a suspended source records nothing; a LIFT restores scoped T1', async () => {
  await createSources(c.admin, ['sc-susp']); await recordRights(c.si_rights_admin, 'sc-susp');
  await control(c.si_rights_admin, 'sc-susp', 'SUSPEND');
  const r = req('sc-susp', [ROW('1')]);
  await rejects(assert, scoped(c.si_collector, r), { code: '23514', message: /^SI_SOURCE_SUSPENDED/ });
  assert.equal(await runsFor(r.key), 0);
  await lift(c.si_rights_admin, 'sc-susp');
  const out = await scoped(c.si_collector, r);
  assert.deepEqual([out.outcome, out.attempt], ['RUNNING', 1], 'the refused call consumed no attempt');
  assert.ok(await scopeOf(out.run_id));
});

test('SC-6 (M3-T07e): no application-role access; immutable for the owner; no direct or second attachment', async () => {
  const r = req('sc-a', [ROW('1')]);
  const out = await scoped(c.si_collector, r);
  for (const role of ['si_collector', 'si_rights_admin', 'si_retention', 'si_monitor']) {
    for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      assert.equal((await c.admin.query('SELECT has_table_privilege($1, $2, $3) AS h', [role, 'si.run_request_scope', p])).rows[0].h, false, `${role} ${p}`);
    }
  }
  // the collector cannot forge the binding marker into a write: it has no privilege at all
  await c.si_collector.query('BEGIN');
  await c.si_collector.query(`SELECT set_config('si.scope_binding', $1, true)`, [out.run_id]);
  await rejects(assert, c.si_collector.query(`INSERT INTO si.run_request_scope (run_id, source_id, evidence_kind, networks, fixture_sha256, hash_version)
    VALUES ($1, 'sc-a', 'SYNTHETIC', '{TIKTOK}', $2, 1)`, [out.run_id, 'd'.repeat(64)]), { code: '42501' });
  await c.si_collector.query('ROLLBACK');
  for (const sql of ['UPDATE si.run_request_scope SET networks = \'{TIKTOK}\'', 'DELETE FROM si.run_request_scope', 'SELECT * FROM si.run_request_scope']) {
    await rejects(assert, c.si_collector.query(sql), { code: '42501' });
  }
  // owner: immutable
  for (const sql of [`UPDATE si.run_request_scope SET networks = '{TIKTOK}' WHERE run_id = '${out.run_id}'`,
                     `DELETE FROM si.run_request_scope WHERE run_id = '${out.run_id}'`, 'TRUNCATE si.run_request_scope']) {
    await rejects(assert, asOwner(c.admin, x => x.query(sql)), { code: '23514', message: /^SI_SCOPE_IMMUTABLE/ });
  }
  // owner: a direct INSERT is refused, so a scope cannot be attached to an existing unscoped run
  const legacy = await plainT1(c.si_collector, req('sc-a', [ROW('x')]));
  await rejects(assert, insertScopeAsOwner(legacy.run_id), { code: '42501', message: /^SI_SCOPE_BIND_FORBIDDEN/ });
  // even an owner forging the marker cannot add a second scope or bind across sources or to a finished run
  await rejects(assert, insertScopeAsOwner(out.run_id, { marker: out.run_id }), { code: '23505' });
  await rejects(assert, insertScopeAsOwner(legacy.run_id, { marker: legacy.run_id, source: 'sc-b' }), { code: '23503' });
  const done = await plainT1(c.si_collector, req('sc-a', [ROW('y')]));
  await completeRun(c.si_collector, done.run_id, done.lease_token);
  await rejects(assert, insertScopeAsOwner(done.run_id, { marker: done.run_id }), { code: '42501', message: /not a RUNNING attempt/ });
  await rejects(assert, insertScopeAsOwner(legacy.run_id, { marker: legacy.run_id, networks: ['TIKTOK', 'META'] }), { code: '22023' });
  assert.equal(await scopeOf(legacy.run_id), undefined);
});

test('SC-7 (M3-T07f): retries keep v1 semantics — a live attempt is refused, an expired one is replaced with a new scope', async () => {
  const r = req('sc-a', [ROW('1')]);
  const a1 = await scoped(c.si_collector, r);
  await rejects(assert, scoped(c.si_collector, r), { code: '23514', message: /^SI_RUN_IN_PROGRESS/ });
  await expire(a1.run_id);
  const a2 = await scoped(c.si_collector, r);
  assert.deepEqual([a2.outcome, a2.attempt], ['RUNNING', 2]);
  assert.ok(await scopeOf(a2.run_id));
  const a1row = (await c.admin.query('SELECT status, outcome_code FROM si.collection_runs WHERE run_id = $1', [a1.run_id])).rows[0];
  assert.deepEqual(a1row, { status: 'FAILED', outcome_code: 'LEASE_EXPIRED' }, 'T1 row 4 reaped the expired attempt');
});

test('SC-8 (M3-T07g): legacy plain-T1 keys keep their v1 hash and record no scope; EMPTY completion is unchanged; a scoped retry reuses the key', async () => {
  const r = req('sc-a', [ROW('1')]);
  const legacy = await plainT1(c.si_collector, r);
  assert.equal(legacy.outcome, 'RUNNING');
  assert.equal(await scopeOf(legacy.run_id), undefined, 'plain T1 records no scope');
  await expire(legacy.run_id);
  const retry = await scoped(c.si_collector, r);
  assert.deepEqual([retry.outcome, retry.attempt], ['RUNNING', 2], 'no IDEMPOTENCY_KEY_REUSED: the v1 hash is identical');
  const other = { ...req('sc-a', [ROW('9')]), key: r.key };
  await rejects(assert, scoped(c.si_collector, other), { code: '23514', message: /^SI_IDEMPOTENCY_KEY_REUSED/ });
  const emptyLegacy = await plainT1(c.si_collector, req('sc-a', [ROW('e')]));
  assert.equal((await completeRun(c.si_collector, emptyLegacy.run_id, emptyLegacy.lease_token)).outcome, 'COMPLETED', 'EMPTY completion unchanged');
});

test('SC-9 (M3-T07h, M3-T08 scope parts): divergent networks cannot be smuggled; each scope binds only its own request', async () => {
  const r = req('sc-a', [ROW('1', 'TIKTOK')], ['META', 'TIKTOK']);
  const run = await plainT1(c.si_collector, r, ['META']);              // hash claims META+TIKTOK, T1 checked META
  assert.equal(await scopeOf(run.run_id), undefined, 'plain T1 never creates a scope');
  const writers = (await c.admin.query(`SELECT proname FROM pg_proc WHERE pronamespace = 'si'::regnamespace
                                          AND prosrc ILIKE '%INSERT INTO si.run_request_scope%'`)).rows.map(x => x.proname);
  assert.deepEqual(writers, ['si_begin_run_scoped'], 'the scoped T1 is the only routine that writes scopes');
  const ra = req('sc-a', [ROW('1'), ROW('2')]), rb = req('sc-b', [ROW('1', 'TIKTOK')], ['TIKTOK']);
  const a = await scoped(c.si_collector, ra), b = await scoped(c.si_collector, rb);
  const sa = await scopeOf(a.run_id), sb = await scopeOf(b.run_id);
  assert.equal(sa.fixture_sha256, await sqlFixture(ra.rows));
  for (const rows of [rb.rows, [ra.rows[1], ra.rows[0]], [ra.rows[0]], [ra.rows[0], { ...ra.rows[1], title: 'x' }]]) {
    assert.notEqual(await sqlFixture(rows), sa.fixture_sha256, 'other, reordered, truncated or modified rows do not match');
  }
  assert.deepEqual([sa.source_id, sb.source_id, sb.networks], ['sc-a', 'sc-b', ['TIKTOK']]);
});

test('SC-10: the scoped T1 is atomic under autocommit — a failing scope insert leaves no attempt', async () => {
  await asOwner(c.admin, x => x.query(`
    CREATE FUNCTION si.test_scope_fail() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
    AS $$ BEGIN RAISE EXCEPTION 'TEST_SCOPE_INSERT_FAILURE'; END $$;
    CREATE TRIGGER test_scope_fail BEFORE INSERT ON si.run_request_scope FOR EACH ROW EXECUTE FUNCTION si.test_scope_fail();`));
  try {
    const r = req('sc-a', [ROW('1')]);
    await rejects(assert, scoped(c.si_collector, r), { message: /TEST_SCOPE_INSERT_FAILURE/ });          // autocommit
    assert.equal(await runsFor(r.key), 0, 'the T1 insert rolled back with the failed scope insert');
    await rejects(assert, t1PreflightScoped(c.si_collector, { sourceId: r.source, requestKey: r.key, requestSha256: r.sha,
      evidenceKind: r.ek, networks: r.networks, fixtureSha256: r.fx }), { message: /TEST_SCOPE_INSERT_FAILURE/ });   // library transaction
    assert.equal(await runsFor(r.key), 0);
  } finally {
    await asOwner(c.admin, x => x.query('DROP TRIGGER test_scope_fail ON si.run_request_scope; DROP FUNCTION si.test_scope_fail();'));
  }
  const ok = await scoped(c.si_collector, req('sc-a', [ROW('1')]));
  assert.equal(ok.outcome, 'RUNNING', 'normal operation resumes');
});

test('SC-11: the scoped T1 works inside a savepoint (no transaction-ID heuristics)', async () => {
  const r = req('sc-a', [ROW('1')]);
  await c.si_collector.query('BEGIN');
  await c.si_collector.query('SAVEPOINT s');
  const out = await scoped(c.si_collector, r);
  await c.si_collector.query('RELEASE SAVEPOINT s');
  await c.si_collector.query('COMMIT');
  assert.ok(await scopeOf(out.run_id));
  const rolled = req('sc-a', [ROW('2')]);
  await c.si_collector.query('BEGIN');
  await c.si_collector.query('SAVEPOINT s');
  await scoped(c.si_collector, rolled);
  await c.si_collector.query('ROLLBACK TO SAVEPOINT s');
  await c.si_collector.query('COMMIT');
  assert.equal(await runsFor(rolled.key), 0, 'a rolled-back savepoint removes the attempt and its scope together');
});

test('SC-12: concurrent scoped T1 calls on one key serialize; one run, one scope', async () => {
  const r = req('sc-a', [ROW('1')]);
  const s1 = await connect({ user: 'si_collector', database: db }), s2 = await connect({ user: 'si_collector', database: db });
  cleanups.push(() => s1.end(), () => s2.end());
  const p1 = await pid(s1), p2 = await pid(s2);
  await s1.query('BEGIN');
  const first = await scoped(s1, r);
  await s2.query('BEGIN');
  const second = waiter(scoped(s2, r));
  await waitUntilBlocked(c.admin, p2, p1);
  await holderCommit(assert, s1, p1);
  await expectWaiterError(assert, second, { code: '23514', message: /^SI_RUN_IN_PROGRESS/ });
  await s2.query('ROLLBACK');
  assert.equal(await runsFor(r.key), 1);
  assert.ok(await scopeOf(first.run_id));
});

test('SC-13: hostile search_path, privilege boundary and catalog contract', async () => {
  await c.si_collector.query('SET search_path = public, pg_temp');
  assert.equal((await scoped(c.si_collector, req('sc-a', [ROW('1')]))).outcome, 'RUNNING');
  await c.si_collector.query('RESET search_path');
  for (const role of ['si_rights_admin', 'si_retention', 'si_monitor']) {
    const x = await connect({ user: role, database: db }); cleanups.push(() => x.end());
    await rejects(assert, scoped(x, req('sc-a', [ROW('1')])), { code: '42501' });
  }
  for (const f of ["si.si_canonical_json_v1('[]')", "si.si_fixture_sha256_v1('[]')", "si.si_request_sha256_v1('a', 'B', '{META}', 'c')"]) {
    await rejects(assert, c.si_collector.query(`SELECT ${f}`), { code: '42501' });
  }
  const cat = (await c.admin.query(`
    SELECT p.proname, p.prosecdef, p.proconfig,
           coalesce((SELECT array_agg(a.grantee::regrole::text ORDER BY 1) FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner), '{}') AS grantees
      FROM pg_proc p WHERE p.pronamespace = 'si'::regnamespace
       AND p.proname IN ('si_begin_run_scoped', 'si_canonical_json_v1', 'si_fixture_sha256_v1', 'si_request_sha256_v1',
                         'trg_run_scope_insert', 'trg_run_scope_append_only', 'si_begin_run') ORDER BY 1`)).rows;
  assert.deepEqual(cat.map(f => [f.proname, f.prosecdef, f.grantees]), [
    ['si_begin_run', true, ['si_collector']],
    ['si_begin_run_scoped', true, ['si_collector']],
    ['si_canonical_json_v1', false, []],
    ['si_fixture_sha256_v1', false, []],
    ['si_request_sha256_v1', false, []],
    ['trg_run_scope_append_only', false, []],
    ['trg_run_scope_insert', false, []]
  ]);
  for (const f of cat) assert.deepEqual(f.proconfig, ['search_path=pg_catalog, pg_temp'], f.proname);
});

test('SC-14 (library): t1PreflightScoped sends one transaction and maps the hash refusal to a typed error', async () => {
  const r = req('sc-a', [ROW('1')]);
  const sent = [];
  const spy = { query: (sql, params) => { sent.push(sql.split('(')[0].trim()); return c.si_collector.query(sql, params); } };
  const out = await t1PreflightScoped(spy, { sourceId: r.source, requestKey: r.key, requestSha256: r.sha,
    evidenceKind: r.ek, networks: r.networks, fixtureSha256: r.fx });
  assert.equal(out.outcome, 'RUNNING');
  assert.deepEqual(sent, ['BEGIN', 'SELECT * FROM si.si_begin_run_scoped', 'COMMIT']);
  assert.ok(await scopeOf(out.runId));
  const err = await rejects(assert, t1PreflightScoped(c.si_collector, { sourceId: r.source, requestKey: `${r.key}-x`,
    requestSha256: r.sha, evidenceKind: r.ek, networks: ['TIKTOK'], fixtureSha256: r.fx }));
  assert.ok(err instanceof T1Refused);
  assert.equal(err.code, 'REQUEST_HASH_MISMATCH');
});

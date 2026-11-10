// B-002 Milestone 3 part 3B (migration 0007): verified commit authorization and the fail-closed
// readability predicate. Real disposable PostgreSQL 16, synthetic sources only. No evidence is read.
//
// Fixtures that a product path cannot perform (each is labelled where used):
//   - superuser time travel / identity disturbance under session_replication_role = replica (skips
//     every trigger for one statement): the superuser is outside the trust boundary by design;
//   - replacing a single-purpose seam function (si.si_commit_ts, si.si_verification_max_xid_age) in
//     a disposable database, to simulate truncated commit timestamps or an over-age transaction id.
// Real-deadline cases (commit after expiry, IMMEDIATE bypass, RT-15) run in the slow CI job
// (tests/slow/m3-deadline.test.mjs); disabled commit timestamps in tests/slow/commit-ts-off.sh.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { asOwner, cfg, connect, control, createSources, freshDatabase, lift, pid, recordRights, rejects, roles, schemaFingerprint, settle,
         waitUntilBlocked } from './helpers.mjs';
import { migrateDown, migrateUp } from '../../dist/persistence/migrate.js';
import { fixtureSha256, requestSha256 } from '../../dist/persistence/request-hash.js';
import { verifyReceipts, verificationStatus, verificationFailures, VerificationFailed, MAX_VERIFY_RUNS } from '../../dist/persistence/verification.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const MIG2 = readFileSync(new URL('../../db/migrations/0002_runs.up.sql', import.meta.url), 'utf8');
const MIG7 = readFileSync(new URL('../../db/migrations/0007_receipt_verification.up.sql', import.meta.url), 'utf8');
const CHECK = '23514';
const ROLES = ['admin', 'si_rights_admin', 'si_collector', 'si_retention', 'si_monitor'];
let n = 0;

async function fresh(t, prefix = 'm3ver', { upTo } = {}) {
  let db;
  if (upTo) {
    db = await freshDatabase(t, prefix, { migrate: false });
    const a = await connect({ database: db });
    try { await migrateUp(a, { to: upTo }); } finally { await a.end(); }
  } else db = await freshDatabase(t, prefix);
  const x = await roles(t, db, ROLES);
  const extra = [];
  t.after(async () => { for (const e of extra) await e.end().catch(() => {}); });
  Object.defineProperty(x, 'db', { value: db, enumerable: false });
  Object.defineProperty(x, 'connect', { enumerable: false, value: async user => { const k = await connect({ user, database: db }); extra.push(k); return k; } });
  return x;
}
const canary = () => `CANARY${randomBytes(8).toString('hex')}`;
const ROW = (id, o = {}) => ({ network: 'META', nativeAdId: id, advertiserName: 'Synthetic Co', countries: ['DE'],
  seenAt: '2026-01-01T00:00:00.000Z', sourceUrl: 'https://example.test/a', ...o });
async function source(x, { networks = ['META', 'TIKTOK'], rights = {} } = {}) {
  const id = `vr-${++n}`;
  await createSources(x.admin, [id], networks);
  await recordRights(x.si_rights_admin, id, rights);
  return id;
}
const T2 = 'SELECT * FROM si.si_complete_run($1::uuid, $2::uuid, $3::jsonb)';
async function begin(x, src, rows, c = x.si_collector) {
  const networks = [...new Set(rows.map(r => r.network))].sort();
  const fx = fixtureSha256(rows), sha = requestSha256({ adapterId: src, evidenceKind: 'SYNTHETIC', networks: networks.length ? networks : ['META'], fixtureSha256: fx });
  const r = (await c.query('SELECT * FROM si.si_begin_run_scoped($1,$2,$3,$4,$5::text[],$6)',
    [src, `vk${++n}`, sha, 'SYNTHETIC', networks.length ? networks : ['META'], fx])).rows[0];
  assert.equal(r.outcome, 'RUNNING');
  return r;
}
async function collect(x, src, rows, { savepoint = false, c = x.si_collector } = {}) {
  const run = await begin(x, src, rows, c);
  await c.query('BEGIN');
  try {
    if (savepoint) { await c.query('SELECT 1 FROM si.sources LIMIT 1'); await c.query('SAVEPOINT s1'); }
    const r = (await c.query(T2, [run.run_id, run.lease_token, JSON.stringify(rows)])).rows[0];
    const xid = (await c.query('SELECT (pg_current_xact_id()::text::bigint % 4294967296) AS x')).rows[0].x;
    if (savepoint) await c.query('RELEASE SAVEPOINT s1');
    await c.query('COMMIT');
    return { ...run, ...r, topXid: Number(xid) };
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
}
const verify = async (x, limit = 100, who = x.si_monitor) => (await who.query('SELECT * FROM si.si_verify_receipts($1)', [limit])).rows[0];
const counts = v => [v.outcome, v.verified, v.valid, v.invalid, v.unverifiable];
const row = async (x, id) => (await x.admin.query('SELECT * FROM si.receipt_verifications WHERE run_id = $1', [id])).rows[0];
const readable = async (x, id) => (await x.admin.query('SELECT si.si_evidence_readable($1) AS r', [id])).rows[0].r;
/** Superuser-only fixture (see header): runs one statement with every trigger skipped. */
async function replica(x, sql, params) {
  await x.admin.query('BEGIN');
  try {
    await x.admin.query('SET LOCAL session_replication_role = replica');
    await x.admin.query(sql, params);
    await x.admin.query('COMMIT');
  } catch (e) { await x.admin.query('ROLLBACK').catch(() => {}); throw e; }
}
/** Seam replacement in a disposable database (see header). */
const seam = (x, sql) => asOwner(x.admin, a => a.query(sql));
const SEAM_COMMIT_TS = body => `CREATE OR REPLACE FUNCTION si.si_commit_ts(p_xid xid) RETURNS timestamptz
  LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$ ${body} $$`;
function cli(db, user, args) {
  const url = `postgresql://${user}:${encodeURIComponent(cfg.rolePassword)}@${cfg.host}:${cfg.port}/${db}`;
  const r = spawnSync(process.execPath, ['dist/persistence/cli.js', 'verification', ...args],
    { cwd: REPO, encoding: 'utf8', env: { ...process.env, SI_DATABASE_URL: url, SI_PRODUCTION: '' } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
function fnText(mig, startMarker, endMarker) {
  const s = mig.indexOf(startMarker);
  assert.ok(s >= 0, `marker ${startMarker}`);
  return mig.slice(s, mig.indexOf(endMarker, s) + endMarker.length).replace(/^CREATE FUNCTION/, 'CREATE OR REPLACE FUNCTION');
}
function mutate(text, from, to) {
  assert.equal(text.split(from).length, 2, `exactly one mutation anchor: ${from.slice(0, 60)}`);
  return text.replace(from, to);
}
const VERDICT_FN = fnText(MIG7, 'CREATE FUNCTION si.si_receipt_verdict', 'END $receipt_verdict$;');
const INSERT_FN = fnText(MIG7, 'CREATE FUNCTION si.trg_verification_insert', 'END $verification_insert$;');
const VERIFY_FN = fnText(MIG7, 'CREATE FUNCTION si.si_verify_receipts', 'END $verify_receipts$;');
const READABLE_FN = fnText(MIG7, 'CREATE FUNCTION si.si_evidence_readable', '$evidence_readable$;\n');
const GUARD_0002 = fnText(MIG2, 'CREATE FUNCTION si.trg_receipts_guard()', 'END $receipt_guard$;');

// ------------------------------------------------------------------------------------------------
test('VR-1: a normal completion is VALID; identity and commit time come from PostgreSQL; idempotent', async t => {
  const x = await fresh(t);
  const src = await source(x);
  const run = await collect(x, src, Array.from({ length: 50 }, (_, i) => ROW(`v1-${i}`)));
  assert.deepEqual(counts(await verify(x)), ['VERIFIED', 1, 1, 0, 0]);
  const v = await row(x, run.run_id);
  assert.deepEqual([v.verdict, v.reason, v.verified_by, Number(v.commit_xid)], ['VALID', 'COMMITTED_IN_WINDOW', 'si_monitor', run.topXid]);
  const truth = (await x.admin.query(`SELECT p.xmin::text AS x, pg_xact_commit_timestamp(p.xmin) = v.commit_ts AS same_ts,
      v.window_start = rv.effective_from AS start_ok, v.window_end = 'infinity'::timestamptz AS end_ok, v.commit_ts >= r.finished_at AS after_t2
    FROM si.receipt_verifications v JOIN si.publication_receipts p USING (run_id) JOIN si.collection_runs r USING (run_id)
    JOIN si.rights_versions rv ON rv.rights_version_id = r.rights_version_id WHERE v.run_id = $1`, [run.run_id])).rows[0];
  assert.deepEqual(truth, { x: String(run.topXid), same_ts: true, start_ok: true, end_ok: true, after_t2: true });
  assert.equal(await readable(x, run.run_id), true, 'VALID + current authorization: the (ungranted) predicate is true');
  assert.deepEqual(counts(await verify(x)), ['NOTHING_PENDING', 0, 0, 0, 0], 'idempotent');
  const empty = await collect(x, src, []);
  assert.deepEqual(counts(await verify(x)), ['NOTHING_PENDING', 0, 0, 0, 0], 'EMPTY runs carry no evidence and are not verified');
  assert.equal(await row(x, empty.run_id), undefined);
  assert.equal(await readable(x, empty.run_id), false);
  const st = await verificationStatus(x.si_monitor);
  assert.deepEqual([st.pending, st.valid, st.invalid, st.unverifiable, st.lagExceeded, st.xidAgeWarning], [0, 1, 0, 0, false, false]);
});

test('VR-4: rights revoked or terminated during completion: the commit precedes the change (VALID), the predicate is false', async t => {
  const x = await fresh(t);
  const out = [];
  for (const kind of ['REVOKE', 'TERMINATE']) {
    const src = await source(x);
    const rows = [ROW(`v4-${kind}`)];
    const run = await begin(x, src, rows);
    const col = await x.connect('si_collector'), ra = await x.connect('si_rights_admin');
    const [cp, rap] = [await pid(col), await pid(ra)];
    await col.query('BEGIN');
    await col.query(T2, [run.run_id, run.lease_token, JSON.stringify(rows)]);
    const w = settle(kind === 'REVOKE' ? recordRights(ra, src, { retain: 'DENIED', change_reason: 'revoked during completion' })
                                       : control(ra, src, 'TERMINATE_RETENTION'));
    await waitUntilBlocked(x.admin, rap, cp);
    await col.query('COMMIT');
    assert.equal((await w).status, 'ok');
    out.push({ kind, run });
  }
  assert.deepEqual(counts(await verify(x)), ['VERIFIED', 2, 2, 0, 0]);
  for (const { kind, run } of out) {
    const c = (await x.admin.query(`SELECT v.verdict, v.commit_ts < v.window_end AS before_end, v.window_end <> 'infinity' AS bounded
      FROM si.receipt_verifications v WHERE v.run_id = $1`, [run.run_id])).rows[0];
    assert.deepEqual(c, { verdict: 'VALID', before_end: true, bounded: true }, `${kind}: window ends at the change, after the commit`);
    assert.equal(await readable(x, run.run_id), false, `${kind}: current authorization is gone`);
  }
});

test('VR-5: a completion inside a savepoint is identified by its subtransaction id and is VALID', async t => {
  const x = await fresh(t);
  const run = await collect(x, await source(x), [ROW('v5-a'), ROW('v5-b')], { savepoint: true });
  assert.deepEqual(counts(await verify(x)), ['VERIFIED', 1, 1, 0, 0]);
  const v = await row(x, run.run_id);
  assert.notEqual(Number(v.commit_xid), run.topXid, 'the evidence carries the subtransaction id');
  const same = (await x.admin.query(`SELECT pg_xact_commit_timestamp($1::text::xid) = v.commit_ts AS s FROM si.receipt_verifications v
                                      WHERE v.run_id = $2`, [String(run.topXid), run.run_id])).rows[0].s;
  assert.equal(same, true, 'its commit time is the top-level commit time');
});

test('VR-6: a changed receipt xmin or split observation identity is UNVERIFIABLE (owner updates are refused)', async t => {
  const x = await fresh(t);
  const src = await source(x);
  const a = await collect(x, src, [ROW('v6-a')]), b = await collect(x, src, [ROW('v6-b1'), ROW('v6-b2')]);
  await rejects(assert, asOwner(x.admin, c => c.query('UPDATE si.publication_receipts SET receipt_at = receipt_at WHERE run_id = $1', [a.run_id])),
    { code: CHECK, message: /^SI_RECEIPT_IMMUTABLE/ });
  // Superuser fixture: disturb the identity witnesses.
  await replica(x, 'UPDATE si.publication_receipts SET receipt_at = receipt_at WHERE run_id = $1', [a.run_id]);
  await replica(x, `UPDATE si.observations SET title = 'x' WHERE run_id = $1 AND ordinal = 1`, [b.run_id]);
  assert.deepEqual(counts(await verify(x)), ['VERIFIED', 2, 0, 0, 2]);
  for (const r of [a, b]) {
    const v = await row(x, r.run_id);
    assert.deepEqual([v.verdict, v.reason, v.commit_ts, v.commit_xid], ['UNVERIFIABLE', 'IDENTITY_MISMATCH', null, null]);
    assert.equal(await readable(x, r.run_id), false);
  }
});

test('VR-7: missing or truncated commit timestamps, over-age transaction ids and clock inconsistency are UNVERIFIABLE', async t => {
  const x = await fresh(t);
  const src = await source(x);
  const cases = [
    ['NO_COMMIT_TIMESTAMP', SEAM_COMMIT_TS('SELECT NULL::timestamptz')],
    ['CLOCK_INCONSISTENT', SEAM_COMMIT_TS(`SELECT (SELECT r.finished_at FROM si.collection_runs r JOIN si.publication_receipts p ON p.run_id = r.run_id
                                            WHERE p.xmin = p_xid) - interval '1 millisecond'`)],
    ['XID_TOO_OLD', `CREATE OR REPLACE FUNCTION si.si_verification_max_xid_age() RETURNS bigint LANGUAGE sql IMMUTABLE
                     SET search_path = pg_catalog, pg_temp AS $$ SELECT 0::bigint $$`]];
  for (const [reason, sql] of cases) {
    const run = await collect(x, src, [ROW(`v7-${reason}`)]);
    await seam(x, sql);
    assert.deepEqual(counts(await verify(x)), ['VERIFIED', 1, 0, 0, 1], reason);
    const v = await row(x, run.run_id);
    assert.deepEqual([v.verdict, v.reason], ['UNVERIFIABLE', reason]);
    assert.equal(await readable(x, run.run_id), false);
    await seam(x, fnText(MIG7, reason === 'XID_TOO_OLD' ? 'CREATE FUNCTION si.si_verification_max_xid_age' : 'CREATE FUNCTION si.si_commit_ts',
                         reason === 'XID_TOO_OLD' ? '$$ SELECT 100000000::bigint $$;' : 'pg_xact_commit_timestamp(p_xid) $$;'));
  }
  // Special transaction ids (frozen / bootstrap) never identify a completion; the real lookup returns NULL.
  const special = (await x.admin.query(`SELECT si.si_commit_ts('2'::xid) AS f, si.si_commit_ts('1'::xid) AS b`)).rows[0];
  assert.deepEqual(special, { f: null, b: null });
});

test('VR-8: verification fields are never taken from a caller; records and receipts cannot be fabricated or changed', async t => {
  const x = await fresh(t);
  const src = await source(x);
  const run = await collect(x, src, [ROW('v8-a')]);
  await replica(x, 'UPDATE si.publication_receipts SET receipt_at = receipt_at WHERE run_id = $1', [run.run_id]);   // makes it UNVERIFIABLE
  await asOwner(x.admin, c => c.query(`INSERT INTO si.receipt_verifications (run_id, source_id, rights_version_id, verdict, reason, commit_xid,
      commit_ts, window_start, window_end, verified_at, verified_by)
    VALUES ($1, $2, $3, 'VALID', 'COMMITTED_IN_WINDOW', 12345, '2000-01-02', '2000-01-01', 'infinity', '2000-01-03', 'forged')`,
    [run.run_id, src, run.rights_version_id]));
  const v = await row(x, run.run_id);
  assert.deepEqual([v.verdict, v.reason, v.commit_xid, v.verified_by], ['UNVERIFIABLE', 'IDENTITY_MISMATCH', null, 'si_bootstrap'],
    'the database recomputed every field');
  for (const sql of [`UPDATE si.receipt_verifications SET verdict = 'VALID', reason = 'COMMITTED_IN_WINDOW'`,
                     'DELETE FROM si.receipt_verifications', 'TRUNCATE si.receipt_verifications', 'TRUNCATE si.verification_failures']) {
    await rejects(assert, asOwner(x.admin, c => c.query(sql)), { code: CHECK, message: /^SI_VERIFICATION_IMMUTABLE/ });
  }
  const other = await collect(x, src, [ROW('v8-b')]);
  for (const sql of [`UPDATE si.publication_receipts SET commit_ts = '2000-01-01', within_validity = true WHERE run_id = $1`,
                     'UPDATE si.publication_receipts SET within_validity = true WHERE run_id = $1',
                     'DELETE FROM si.publication_receipts WHERE run_id = $1']) {
    await rejects(assert, asOwner(x.admin, c => c.query(sql, [other.run_id])), { code: CHECK, message: /^SI_RECEIPT_IMMUTABLE/ });
  }
  for (const role of ['si_collector', 'si_rights_admin', 'si_retention', 'si_monitor']) {
    await rejects(assert, x[role].query('INSERT INTO si.receipt_verifications (run_id) VALUES ($1)', [other.run_id]), { code: '42501' });
    await rejects(assert, x[role].query('UPDATE si.publication_receipts SET commit_ts = now()'), { code: '42501' });
  }
  const emptyRun = (await collect(x, src, [])).run_id;
  await rejects(assert, asOwner(x.admin, c => c.query('INSERT INTO si.receipt_verifications (run_id) VALUES ($1)', [emptyRun])),
    { code: CHECK, message: /^SI_VERIFY_NOT_APPLICABLE/ });
});

test('VR-9: repeated and concurrent verifiers record each run exactly once', async t => {
  const x = await fresh(t);
  const src = await source(x);
  for (let i = 0; i < 6; i++) await collect(x, src, [ROW(`v9-${i}`)]);
  const A = await x.connect('si_monitor'), B = await x.connect('si_monitor');
  const [ap, bp] = [await pid(A), await pid(B)];
  await A.query('BEGIN'); await B.query('BEGIN');
  const ra = (await A.query('SELECT * FROM si.si_verify_receipts(100)')).rows[0];
  const pb = settle(B.query('SELECT * FROM si.si_verify_receipts(100)'));
  await waitUntilBlocked(x.admin, bp, ap);                                   // B waits for A's uncommitted records
  await A.query('COMMIT');
  const rb = await pb;
  await B.query('COMMIT');
  assert.equal(rb.status, 'ok', rb.message);
  assert.equal(ra.verified + rb.value.rows[0].verified, 6, 'each run once');
  assert.equal((await x.admin.query('SELECT count(*)::int AS n FROM si.receipt_verifications')).rows[0].n, 6);
  assert.deepEqual(counts(await verify(x)), ['NOTHING_PENDING', 0, 0, 0, 0]);
});

test('VR-10: evidence purged before verification is UNVERIFIABLE (NO_EVIDENCE); historical evidence verifies after upgrade', async t => {
  const x = await fresh(t);
  const src = await source(x);
  const run = await collect(x, src, [ROW('v10-a')]);
  await control(x.si_rights_admin, src, 'TERMINATE_RETENTION');
  assert.equal((await x.si_retention.query('SELECT * FROM si.si_purge_due(10)')).rows[0].outcome, 'PURGED');
  assert.deepEqual(counts(await verify(x)), ['VERIFIED', 1, 0, 0, 1]);
  assert.deepEqual([(await row(x, run.run_id)).verdict, (await row(x, run.run_id)).reason], ['UNVERIFIABLE', 'NO_EVIDENCE']);
  // Historical: evidence committed under 0006, verified after 0007 is applied.
  const h = await fresh(t, 'm3verh', { upTo: 6 });
  const hrun = await collect(h, await source(h), [ROW('v10-h')]);
  assert.deepEqual(await migrateUp(h.admin), [7]);
  assert.deepEqual(counts(await verify(h)), ['VERIFIED', 1, 1, 0, 0]);
  assert.equal((await row(h, hrun.run_id)).verdict, 'VALID');
});

test('VR-11: the readability predicate needs VALID AND current authorization; it is false for every other state', async t => {
  const x = await fresh(t);
  const mk = async (o = {}) => { const src = await source(x, o); return { src, run: await collect(x, src, [ROW(`v11-${++n}`)]) }; };
  const ok = await mk(), suspended = await mk(), terminated = await mk(), retired = await mk(), revoked = await mk(), narrowed = await mk(),
        expired = await mk(), pending = await mk(), unverifiable = await mk();
  await replica(x, 'UPDATE si.publication_receipts SET receipt_at = receipt_at WHERE run_id = $1', [unverifiable.run.run_id]);
  assert.equal(await readable(x, pending.run.run_id), false, 'no verdict yet');
  // verify everything except "pending": verify, then add pending's run afterwards
  assert.deepEqual(counts(await verify(x)), ['VERIFIED', 9, 8, 0, 1]);
  const late = await mk();
  await control(x.si_rights_admin, suspended.src, 'SUSPEND');
  await control(x.si_rights_admin, terminated.src, 'TERMINATE_RETENTION');
  await x.si_rights_admin.query('UPDATE si.sources SET retired_at = clock_timestamp() WHERE source_id = $1', [retired.src]);
  await recordRights(x.si_rights_admin, revoked.src, { retain: 'DENIED' });
  await asOwner(x.admin, c => c.query(`UPDATE si.sources SET supported_networks = '{TIKTOK}' WHERE source_id = $1`, [narrowed.src]));
  await replica(x, `UPDATE si.collection_runs SET retain_until = clock_timestamp() - interval '1 minute' WHERE run_id = $1`, [expired.run.run_id]);
  const want = { ok: true, suspended: false, terminated: false, retired: false, revoked: false, narrowed: false, expired: false,
                 unverifiable: false, late: false };
  const got = {};
  for (const [k, v] of Object.entries({ ok, suspended, terminated, retired, revoked, narrowed, expired, unverifiable, late })) got[k] = await readable(x, v.run.run_id);
  assert.deepEqual(got, want);
  for (const k of ['suspended', 'terminated', 'retired', 'revoked', 'narrowed', 'expired']) {
    assert.equal((await row(x, { ok, suspended, terminated, retired, revoked, narrowed, expired }[k].run.run_id)).verdict, 'VALID',
      `${k}: the stored verdict stays VALID — current authorization decides`);
  }
  await lift(x.si_rights_admin, suspended.src);
  assert.equal(await readable(x, suspended.run.run_id), true, 'after LIFT the suspended source is authorized again');
  assert.equal(await readable(x, '00000000-0000-0000-0000-000000000000'), false, 'unknown run');
});

test('VR-13: only si_monitor verifies; nobody reads verification tables or evidence; the predicate is granted to no role', async t => {
  const x = await fresh(t);
  const run = await collect(x, await source(x), [ROW('v13')]);
  for (const role of ['si_collector', 'si_rights_admin', 'si_retention']) {
    for (const sql of ['SELECT * FROM si.si_verify_receipts(10)', 'SELECT * FROM si.si_verification_status()',
                       'SELECT * FROM si.si_verification_failures(5)', `SELECT si.si_record_verification_failure('INTERNAL', NULL)`]) {
      await rejects(assert, x[role].query(sql), { code: '42501' });
    }
  }
  for (const role of ['si_collector', 'si_rights_admin', 'si_retention', 'si_monitor']) {
    for (const sql of ['SELECT 1 FROM si.receipt_verifications', 'SELECT 1 FROM si.verification_failures', 'SELECT 1 FROM si.observations',
                       'SELECT 1 FROM si.ads', `SELECT si.si_evidence_readable('${run.run_id}')`, `SELECT * FROM si.si_receipt_verdict('${run.run_id}')`,
                       `SELECT si.si_commit_ts('3'::xid)`]) {
      await rejects(assert, x[role].query(sql), { code: '42501' });
    }
  }
  for (const bad of [0, 501, null]) await rejects(assert, verify(x, bad), { code: '22023' });
  await rejects(assert, x.si_monitor.query(`SELECT si.si_record_verification_failure('FREE TEXT', NULL)`), { code: '22023' });
  await rejects(assert, verifyReceipts(x.si_monitor, MAX_VERIFY_RUNS + 1), { message: /^VERIFICATION_FAILED: BAD_ARGUMENT$/ });
  assert.deepEqual(counts(await verify(x)), ['VERIFIED', 1, 1, 0, 0]);
});

test('VR-14: content-free status: pending, verdict counts, lag target, xid-age warning, failures; CLI', async t => {
  const x = await fresh(t);
  const mark = canary();
  const src = await source(x);
  const run = await collect(x, src, [ROW(mark, { advertiserName: mark })]);
  let st = await verificationStatus(x.si_monitor);
  assert.deepEqual([st.pending, st.lagTargetSeconds, st.lagExceeded, st.xidAgeWarning], [1, 60, false, false]);
  await replica(x, `UPDATE si.collection_runs SET finished_at = finished_at - interval '2 minutes' WHERE run_id = $1`, [run.run_id]);
  st = await verificationStatus(x.si_monitor);
  assert.equal(st.lagExceeded, true, 'older than the 60 s lag target');
  assert.ok(st.oldestPendingAgeSeconds >= 120);
  await seam(x, `CREATE OR REPLACE FUNCTION si.si_verification_max_xid_age() RETURNS bigint LANGUAGE sql IMMUTABLE
                 SET search_path = pg_catalog, pg_temp AS $$ SELECT 1::bigint $$`);
  assert.equal((await verificationStatus(x.si_monitor)).xidAgeWarning, true, 'pending identity is approaching the age limit');
  const status = cli(x.db, 'si_monitor', ['status']);
  assert.equal(status.status, 2, 'lag or xid-age warning exits 2');
  await x.si_monitor.query(`SET default_transaction_isolation = 'repeatable read'`);
  const err = await rejects(assert, verifyReceipts(x.si_monitor, 10));
  assert.ok(err instanceof VerificationFailed);
  assert.deepEqual([err.message, err.code, err.sqlstate, err.recorded], ['VERIFICATION_FAILED: ISOLATION', 'ISOLATION', '25000', true]);
  await x.si_monitor.query('RESET default_transaction_isolation');
  const fails = await verificationFailures(x.si_monitor, 10);
  assert.deepEqual(fails.map(f => [f.code, f.sqlstate, f.recordedBy]), [['ISOLATION', '25000', 'si_monitor']]);
  assert.equal((await verificationStatus(x.si_monitor)).failures24h, 1);
  await seam(x, fnText(MIG7, 'CREATE FUNCTION si.si_verification_max_xid_age', '$$ SELECT 100000000::bigint $$;'));
  const runOut = cli(x.db, 'si_monitor', ['run']);
  assert.equal(runOut.status, 0, runOut.stderr);
  assert.deepEqual(JSON.parse(runOut.stdout), { outcome: 'VERIFIED', verified: 1, valid: 1, invalid: 0, unverifiable: 0 });
  const denied = cli(x.db, 'si_collector', ['run']);
  assert.equal(denied.stderr.trim(), 'VERIFICATION_FAILED code=PRIVILEGE sqlstate=42501 recorded=false');
  const texts = [status.stdout, status.stderr, runOut.stdout, runOut.stderr, denied.stdout, denied.stderr,
    JSON.stringify(await verificationStatus(x.si_monitor)), JSON.stringify(fails),
    JSON.stringify((await x.admin.query('SELECT * FROM si.receipt_verifications')).rows)];
  assert.ok(!texts.some(s => s.includes(mark)), 'no evidence content in status, CLI output or verification records');
});

test('VR-15 (gates): batch timing; verification never blocks emergency controls or completions', async t => {
  const x = await fresh(t);
  const srcs = [await source(x), await source(x)];
  for (let i = 0; i < 100; i++) await collect(x, srcs[i % 2], [ROW(`v15-${i}`)]);
  const mon = await x.connect('si_monitor'), ra = await x.connect('si_rights_admin');
  const [mp, rap] = [await pid(mon), await pid(ra)];
  await mon.query('BEGIN');
  const t0 = performance.now();
  const r = (await mon.query('SELECT * FROM si.si_verify_receipts(100)')).rows[0];
  const batchMs = performance.now() - t0;
  assert.deepEqual([r.verified, r.valid], [100, 100]);
  // The verifier's transaction is still open: SUSPEND, TERMINATE and a completion on the same sources must not wait for it.
  const timed = async p => { const s = performance.now(); await p; return performance.now() - s; };
  const waits = [await timed(control(ra, srcs[0], 'SUSPEND')), await timed(control(ra, srcs[1], 'TERMINATE_RETENTION'))];
  const blocked = (await x.admin.query('SELECT $2::int = ANY (pg_blocking_pids($1)) AS b', [rap, mp])).rows[0].b;
  const other = await source(x);
  const ms = await timed(collect(x, other, [ROW('v15-during')]));
  await mon.query('COMMIT');
  console.log(`# VR-15 verify batch of 100 runs: ${batchMs.toFixed(0)} ms; SUSPEND / TERMINATE during an open verification: ${waits.map(w => w.toFixed(0)).join(' / ')} ms; completion: ${ms.toFixed(0)} ms`);
  assert.equal(blocked, false);
  assert.ok(batchMs <= 5000, `batch ${batchMs.toFixed(0)} ms <= 5000 ms`);
  assert.ok(Math.max(...waits) <= 1000, 'emergency controls did not wait for the verifier');
});

test('VR-16: down 0007 with verification data present restores the exact 0006 catalog; up re-applies identically', async t => {
  const x = await fresh(t);
  const run = await collect(x, await source(x), [ROW('v16')]);
  assert.deepEqual(counts(await verify(x)), ['VERIFIED', 1, 1, 0, 0]);
  const at7 = await schemaFingerprint(x.admin);
  const ref = await freshDatabase(t, 'm3ver6', { migrate: false });
  const refc = await connect({ database: ref }); t.after(() => refc.end());
  await migrateUp(refc, { to: 6 });
  assert.deepEqual(await migrateDown(x.admin, { to: 6, allowDestructive: true }), [7]);
  const norm = f => f.replaceAll('"relacl":"{si_owner=arwdDxt/si_owner}"', '"relacl":null');    // equivalent ACL spelling after restore (DR-1)
  assert.equal(norm(await schemaFingerprint(x.admin)), norm(await schemaFingerprint(refc)), 'exact 0006 catalog');
  assert.equal((await x.admin.query('SELECT count(*)::int AS n FROM si.publication_receipts WHERE run_id = $1', [run.run_id])).rows[0].n, 1);
  assert.deepEqual(await migrateUp(x.admin), [7]);
  assert.equal(norm(await schemaFingerprint(x.admin)), norm(at7));
  assert.deepEqual(counts(await verify(x)), ['VERIFIED', 1, 1, 0, 0], 're-verified after the round trip (records were dropped by down)');
});

// ------------------------------------------------------------------------------------------------
// Targeted mutants (fast ones; the window mutant needs a real deadline and runs in the slow job).
async function scnReceiptOnly(x) {               // detected = a disturbed receipt identity is not UNVERIFIABLE
  const run = await collect(x, await source(x), [ROW('m1')]);
  await replica(x, 'UPDATE si.publication_receipts SET receipt_at = receipt_at WHERE run_id = $1', [run.run_id]);
  await verify(x);
  return (await row(x, run.run_id)).verdict !== 'UNVERIFIABLE';
}
async function scnNullTs(x) {
  const run = await collect(x, await source(x), [ROW('m2')]);
  await seam(x, SEAM_COMMIT_TS('SELECT NULL::timestamptz'));
  await verify(x);
  return (await row(x, run.run_id)).verdict !== 'UNVERIFIABLE';
}
async function scnClock(x) {
  const run = await collect(x, await source(x), [ROW('m3')]);
  await seam(x, SEAM_COMMIT_TS(`SELECT (SELECT r.finished_at FROM si.collection_runs r JOIN si.publication_receipts p ON p.run_id = r.run_id
                                  WHERE p.xmin = p_xid) - interval '1 millisecond'`));
  await verify(x);
  return (await row(x, run.run_id)).verdict === 'VALID';
}
async function scnForged(x) {
  const src = await source(x);
  const run = await collect(x, src, [ROW('m4')]);
  await replica(x, 'UPDATE si.publication_receipts SET receipt_at = receipt_at WHERE run_id = $1', [run.run_id]);
  await asOwner(x.admin, c => c.query(`INSERT INTO si.receipt_verifications (run_id, source_id, rights_version_id, verdict, reason, commit_xid,
      commit_ts, window_start, window_end, verified_at, verified_by)
    VALUES ($1, $2, $3, 'VALID', 'COMMITTED_IN_WINDOW', 12345, '2000-01-02', '2000-01-01', 'infinity', '2000-01-03', 'forged')`,
    [run.run_id, src, run.rights_version_id]));
  return (await row(x, run.run_id)).verdict === 'VALID';
}
async function scnLegacyReceipt(x) {
  const run = await collect(x, await source(x), [ROW('m5')]);
  const r = await settle(asOwner(x.admin, c => c.query(`UPDATE si.publication_receipts SET commit_ts = '2000-01-01', within_validity = true
                                                         WHERE run_id = $1`, [run.run_id])));
  return r.status === 'ok';
}
async function scnPredicateVerdict(x) {
  const run = await collect(x, await source(x), [ROW('m6')]);
  await replica(x, 'UPDATE si.publication_receipts SET receipt_at = receipt_at WHERE run_id = $1', [run.run_id]);
  await verify(x);
  return await readable(x, run.run_id);
}
async function scnPredicateCurrent(x) {
  const src = await source(x);
  const run = await collect(x, src, [ROW('m7')]);
  await verify(x);
  await control(x.si_rights_admin, src, 'SUSPEND');
  return await readable(x, run.run_id);
}
async function scnNonblocking(x) {
  const src = await source(x);
  await collect(x, src, [ROW('m8')]);
  const mon = await x.connect('si_monitor'), ra = await x.connect('si_rights_admin');
  const [mp, rap] = [await pid(mon), await pid(ra)];
  await mon.query('BEGIN');
  await mon.query('SELECT * FROM si.si_verify_receipts(10)');
  const w = settle(control(ra, src, 'SUSPEND'));
  let blocked = false;
  for (let i = 0; i < 40 && !blocked; i++) {
    blocked = (await x.admin.query('SELECT $2::int = ANY (pg_blocking_pids($1)) AS b', [rap, mp])).rows[0].b;
    if (!blocked) await new Promise(r => setTimeout(r, 25));
  }
  await mon.query('COMMIT');
  await w;
  return blocked;
}
const MUTANTS = [
  { name: 'identity from the receipt only', scenario: scnReceiptOnly,
    sql: mutate(VERDICT_FN, 'IF obs_k <> 1 OR rx IS NULL OR obs_x IS DISTINCT FROM rx::text OR obs_x::bigint < 3 THEN',
                'IF rx IS NULL THEN') .replace('commit_xid := obs_x::bigint;', 'commit_xid := rx::text::bigint;') },
  { name: 'missing commit timestamp accepted', scenario: scnNullTs,
    sql: mutate(VERDICT_FN, `IF ts IS NULL THEN\n    verdict := 'UNVERIFIABLE'; reason := 'NO_COMMIT_TIMESTAMP'; RETURN NEXT; RETURN;\n  END IF;`,
                `IF ts IS NULL THEN\n    ts := r.finished_at;\n  END IF;`) },
  { name: 'clock-consistency check removed', scenario: scnClock,
    sql: mutate(VERDICT_FN, 'IF ts < r.finished_at OR ts > now_at THEN', 'IF false THEN') },
  { name: 'caller-supplied verification fields trusted', scenario: scnForged,
    sql: mutate(INSERT_FN, 'BEGIN\n  SELECT * INTO d', 'BEGIN\n  IF NEW.verdict IS NOT NULL THEN RETURN NEW; END IF;\n  SELECT * INTO d') },
  { name: 'legacy receipt guard (0002) without the legacy-column constraint', scenario: scnLegacyReceipt,
    sql: `${GUARD_0002};\nALTER TABLE si.publication_receipts DROP CONSTRAINT receipts_legacy_columns_unused` },
  { name: 'predicate ignores the verdict', scenario: scnPredicateVerdict,
    sql: mutate(READABLE_FN, `SELECT rv.verdict = 'VALID'`, 'SELECT true') },
  { name: 'predicate relies on the stored verdict (no current suspension check)', scenario: scnPredicateCurrent,
    sql: mutate(READABLE_FN, '       AND NOT si.si_source_suspended(r.source_id)\n', '') },
  { name: 'verifier takes a source lock', scenario: scnNonblocking,
    sql: mutate(VERIFY_FN, '  IF cands IS NULL THEN', '  PERFORM 1 FROM si.sources s FOR SHARE;\n  IF cands IS NULL THEN') }
];
for (const m of MUTANTS) {
  test(`VR-M (${m.name}): the baseline passes the scenario and the targeted mutant is detected`, async t => {
    const base = await m.scenario(await fresh(t, 'm3vermb'));
    const x = await fresh(t, 'm3vermm');
    await asOwner(x.admin, a => a.query(m.sql));
    const killed = await m.scenario(x);
    console.log(`# VR-M ${m.name}: baseline ${base ? 'DETECTED (unexpected)' : 'clean'}, mutant ${killed ? 'KILLED' : 'SURVIVED'}`);
    assert.equal(base, false, `${m.name}: the unmutated code passes`);
    assert.equal(killed, true, `${m.name}: the mutant is detected`);
  });
}

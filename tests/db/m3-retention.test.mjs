// B-002 Milestone 3 part 3A (migration 0006): retention enforcement and safe purge. Real disposable
// PostgreSQL 16, synthetic sources only.
//
// Fixture time travel: a run's stored deadline (retain_until) is at least one day after completion, so
// tests age it by an UPDATE made by the test SUPERUSER under session_replication_role = replica (which
// skips every trigger for that one statement). No application role, and no code path of the product,
// can do this; it only stands in for the passage of time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { asOwner, cfg, connect, control, createSources, freshDatabase, pid, recordRights, rejects, roles,
         schemaFingerprint, settle, waitUntilBlocked } from './helpers.mjs';
import { migrateDown, migrateUp } from '../../dist/persistence/migrate.js';
import { fixtureSha256, requestSha256 } from '../../dist/persistence/request-hash.js';
import { purgeDue, purgeFailures, retentionStatus, overdueRetention, RetentionFailed, MAX_PURGE_RUNS } from '../../dist/persistence/retention.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const MIG1 = readFileSync(new URL('../../db/migrations/0001_sources_rights.up.sql', import.meta.url), 'utf8');
const MIG5 = readFileSync(new URL('../../db/migrations/0005_evidence.up.sql', import.meta.url), 'utf8');
const MIG6 = readFileSync(new URL('../../db/migrations/0006_retention.up.sql', import.meta.url), 'utf8');
const CHECK = '23514';
const ROLES = ['admin', 'si_rights_admin', 'si_collector', 'si_retention', 'si_monitor'];
const cleanups = [];
const scope = { after: fn => cleanups.push(fn) };
test.after(async () => { for (const fn of cleanups.reverse()) await fn(); });
let n = 0;

/**
 * A fresh database (template at the current schema version) with one connection per role. Everything
 * (connections opened through x.connect included) is closed and dropped when test `t` ends.
 */
async function fresh(t, prefix = 'm3ret') {
  const db = await freshDatabase(t, prefix);
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
  const id = `rt-${++n}`;
  await createSources(x.admin, [id], networks);
  await recordRights(x.si_rights_admin, id, rights);
  return id;
}
const T2 = 'SELECT * FROM si.si_complete_run($1::uuid, $2::uuid, $3::jsonb)';
async function begin(x, src, rows, networks = [...new Set(rows.map(r => r.network))].sort()) {
  const fx = fixtureSha256(rows), key = `rk${++n}`;
  const sha = requestSha256({ adapterId: src, evidenceKind: 'SYNTHETIC', networks: networks.length ? networks : ['META'], fixtureSha256: fx });
  const r = (await x.si_collector.query('SELECT * FROM si.si_begin_run_scoped($1,$2,$3,$4,$5::text[],$6)',
    [src, key, sha, 'SYNTHETIC', networks.length ? networks : ['META'], fx])).rows[0];
  assert.equal(r.outcome, 'RUNNING');
  return r;
}
async function collect(x, src, rows) {
  const run = await begin(x, src, rows);
  await x.si_collector.query('BEGIN');
  try {
    const r = (await x.si_collector.query(T2, [run.run_id, run.lease_token, JSON.stringify(rows)])).rows[0];
    await x.si_collector.query('COMMIT');
    assert.equal(r.outcome, 'COMPLETED');
    return { ...run, ...r };
  } catch (e) { await x.si_collector.query('ROLLBACK').catch(() => {}); throw e; }
}
/** Fixture time travel (superuser only, see the header). */
async function age(x, runIds, ago = '10 minutes') {
  await x.admin.query('BEGIN');
  await x.admin.query('SET LOCAL session_replication_role = replica');
  await x.admin.query(`UPDATE si.collection_runs SET retain_until = clock_timestamp() - $2::interval WHERE run_id = ANY ($1::uuid[])`,
    [[].concat(runIds), ago]);
  await x.admin.query('COMMIT');
}
const purge = async (x, limit = 10, who = x.si_retention) => (await who.query('SELECT * FROM si.si_purge_due($1)', [limit])).rows[0];
const summary = p => [p.outcome, p.purged_source, p.runs_purged, p.observations_purged, p.identities_purged, p.late_runs];
const runState = async (x, id) => (await x.admin.query(`
  SELECT r.status, r.retention_state, r.retain_until, r.first_purged_at, r.purged_at, r.received_count, r.published_count,
         (SELECT count(*)::int FROM si.observations o WHERE o.run_id = r.run_id) AS obs,
         (SELECT count(*)::int FROM si.publication_receipts p WHERE p.run_id = r.run_id) AS receipts
    FROM si.collection_runs r WHERE r.run_id = $1`, [id])).rows[0];
const logOf = async (x, id) => (await x.admin.query('SELECT * FROM si.purge_log WHERE run_id = $1', [id])).rows;
const adsNamed = async (x, ids) => (await x.admin.query('SELECT count(*)::int AS n FROM si.ads WHERE native_ad_id = ANY ($1)', [ids])).rows[0].n;
async function invariants(x) {
  const r = (await x.admin.query(`
    SELECT (SELECT count(*)::int FROM si.collection_runs r WHERE r.retention_state = 'RETAINED'
              AND r.published_count <> (SELECT count(*) FROM si.observations o WHERE o.run_id = r.run_id)) AS retained_mismatch,
           (SELECT count(*)::int FROM si.collection_runs r WHERE r.retention_state = 'PURGED'
              AND EXISTS (SELECT 1 FROM si.observations o WHERE o.run_id = r.run_id)) AS purged_with_evidence,
           (SELECT count(*)::int FROM si.ads a WHERE NOT EXISTS (SELECT 1 FROM si.observations o WHERE o.ad_id = a.ad_id)) AS orphans,
           (SELECT count(*)::int FROM si.collection_runs r WHERE r.status = 'COMPLETED' AND NOT EXISTS
              (SELECT 1 FROM si.publication_receipts p WHERE p.run_id = r.run_id)) AS missing_receipts,
           (SELECT count(*)::int FROM si.collection_runs r WHERE r.retention_state = 'PURGED' AND NOT EXISTS
              (SELECT 1 FROM si.purge_log p WHERE p.run_id = r.run_id)) AS unaudited`)).rows[0];
  assert.deepEqual(r, { retained_mismatch: 0, purged_with_evidence: 0, orphans: 0, missing_receipts: 0, unaudited: 0 }, 'global retention invariants');
}
/** Owner-side manual purge attempts (the only way to exercise the deferred checks in isolation). */
async function ownerPurge(x, run, { deleteObs = true, deleteAds = true, log = true, logRows = null } = {}) {
  return asOwner(x.admin, async a => {
    await a.query(`UPDATE si.collection_runs SET retention_state = 'PURGED' WHERE run_id = $1`, [run.run_id]);
    let ids = [];
    if (deleteObs) ids = (await a.query('DELETE FROM si.observations WHERE run_id = $1 RETURNING ad_id', [run.run_id])).rows.map(o => o.ad_id);
    if (deleteAds && ids.length) await a.query('DELETE FROM si.ads WHERE ad_id = ANY ($1::bigint[])', [ids]);
    if (log) {
      // Built in SQL from the run itself (timestamps keep their microseconds).
      await a.query(`INSERT INTO si.purge_log (batch_id, run_id, source_id, rights_version_id, reason, effective_end, due_by, purged_at,
                       observations_deleted, identities_deleted, late, purged_by)
                     SELECT gen_random_uuid(), r.run_id, r.source_id, r.rights_version_id, 'RETENTION_PERIOD', r.retain_until,
                            r.retain_until + interval '1 hour', r.purged_at, coalesce($2::int, r.published_count), 0,
                            r.purged_at > r.retain_until + interval '1 hour', 'si_bootstrap'
                       FROM si.collection_runs r WHERE r.run_id = $1`, [run.run_id, logRows]);
    }
  });
}
function serverLog() {
  if (process.env.SI_TEST_SERVER_LOG) return readFileSync(process.env.SI_TEST_SERVER_LOG, 'utf8');
  const r = spawnSync('docker', ['compose', 'logs', '--no-color', 'db'], { cwd: REPO, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  if (r.status !== 0) throw new Error('cannot read the PostgreSQL server log: set SI_TEST_SERVER_LOG or run the compose database');
  return `${r.stdout}${r.stderr}`;
}
function cli(db, user, args) {
  const url = `postgresql://${user}:${encodeURIComponent(cfg.rolePassword)}@${cfg.host}:${cfg.port}/${db}`;
  const r = spawnSync(process.execPath, ['dist/persistence/cli.js', 'retention', ...args],
    { cwd: REPO, encoding: 'utf8', env: { ...process.env, SI_DATABASE_URL: url, SI_PRODUCTION: '' } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
/** Function text from a migration, as CREATE OR REPLACE, for targeted mutants. */
function fnText(mig, startMarker, endMarker) {
  const s = mig.indexOf(startMarker);
  assert.ok(s >= 0, `marker ${startMarker}`);
  const e = mig.indexOf(endMarker, s) + endMarker.length;
  return mig.slice(s, e).replace(/^CREATE FUNCTION/, 'CREATE OR REPLACE FUNCTION');
}
function mutate(text, from, to) {
  assert.equal(text.split(from).length, 2, `exactly one mutation anchor: ${from.slice(0, 60)}`);
  return text.replace(from, to);
}
const PURGE_FN = fnText(MIG6, 'CREATE FUNCTION si.si_purge_due', 'END $purge_due$;');
const GUARD_FN = fnText(MIG6, 'CREATE OR REPLACE FUNCTION si.trg_evidence_append_only', 'END $evidence_guard$;');
const PURGE_CHECK_FN = fnText(MIG6, 'CREATE FUNCTION si.trg_runs_purge_check', 'END $run_purge_check$;');
const RETENTION_END_FN = fnText(MIG1, 'CREATE FUNCTION si.si_retention_end(', '\n$$;');
// Instrumented T2 (test only): identical to 0005 except a pause between the identity phase and the
// observation insert, which forces the interleaving a purge without the source lock would race.
const T2_PAUSED = mutate(fnText(MIG5, 'CREATE OR REPLACE FUNCTION si.si_complete_run', 'END $run_complete$;'),
  '      ON CONFLICT DO NOTHING;\n  END LOOP;\n',
  `      ON CONFLICT DO NOTHING;\n  END LOOP;\n  PERFORM pg_sleep(coalesce(nullif(current_setting('si.test_pause', true), ''), '0')::float8);\n`);

// ------------------------------------------------------------------------------------------------
test('RT-1: unexpired evidence cannot be deleted or changed; finished-run retention metadata is immutable', async t => {
  const x = await fresh(t);
  const src = await source(x);
  const run = await collect(x, src, [ROW('r1-a'), ROW('r1-b')]);
  for (const sql of ['DELETE FROM si.observations WHERE run_id = $1', `UPDATE si.observations SET title = 'x' WHERE run_id = $1`,
                     'DELETE FROM si.ads WHERE first_run_id = $1', `UPDATE si.ads SET created_at = now() WHERE first_run_id = $1`]) {
    await rejects(assert, asOwner(x.admin, a => a.query(sql, [run.run_id])), { code: CHECK, message: /^SI_EVIDENCE_IMMUTABLE/ });
  }
  await rejects(assert, x.admin.query('DELETE FROM si.observations WHERE run_id = $1', [run.run_id]), { code: CHECK, message: /^SI_EVIDENCE_IMMUTABLE/ });
  await rejects(assert, asOwner(x.admin, a => a.query('TRUNCATE si.observations')), { code: CHECK, message: /^SI_EVIDENCE_IMMUTABLE/ });
  await rejects(assert, asOwner(x.admin, a => a.query('TRUNCATE si.ads CASCADE')), { code: CHECK, message: /^SI_EVIDENCE_IMMUTABLE/ });
  // RETAINED -> PURGED only after the effective end; every other change of the metadata is refused.
  await rejects(assert, asOwner(x.admin, a => a.query(`UPDATE si.collection_runs SET retention_state = 'PURGED' WHERE run_id = $1`, [run.run_id])),
    { code: CHECK, message: /^SI_RETENTION_NOT_DUE/ });
  for (const set of [`retain_until = retain_until - interval '1 day'`, `retain_until = retain_until + interval '1 day'`,
                     `first_purged_at = clock_timestamp()`, `retention_state = 'PARTIALLY_PURGED', first_purged_at = clock_timestamp()`,
                     `retention_state = 'PURGED', retain_until = clock_timestamp() - interval '1 day'`]) {
    await rejects(assert, asOwner(x.admin, a => a.query(`UPDATE si.collection_runs SET ${set} WHERE run_id = $1`, [run.run_id])),
      { code: CHECK, message: /^SI_RETENTION_IMMUTABLE/ });
  }
  const empty = await collect(x, src, []);
  assert.equal(empty.retention_state, 'EMPTY');
  await rejects(assert, asOwner(x.admin, a => a.query(`UPDATE si.collection_runs SET retention_state = 'PURGED' WHERE run_id = $1`, [empty.run_id])),
    { code: CHECK, message: /^SI_RETENTION_IMMUTABLE/ });
  assert.equal((await purge(x)).outcome, 'NOTHING_DUE');
  const s = await runState(x, run.run_id);
  assert.deepEqual([s.retention_state, s.obs, s.first_purged_at, s.purged_at], ['RETAINED', 2, null, null]);
  assert.equal(await adsNamed(x, ['r1-a', 'r1-b']), 2);
  await invariants(x);
});

test('RT-2: expired evidence is purged through the authorized routine, audited and final', async t => {
  const x = await fresh(t);
  const src = await source(x);
  const run = await collect(x, src, [ROW('r2-a'), ROW('r2-b', { network: 'TIKTOK' }), ROW('r2-a')]);
  assert.deepEqual([run.received_count, run.published_count, run.duplicate_count], [3, 2, 1]);
  await age(x, run.run_id, '10 minutes');
  const before = await runState(x, run.run_id);
  const p = await purge(x);
  assert.deepEqual(summary(p), ['PURGED', src, 1, 2, 2, 0]);
  const s = await runState(x, run.run_id);
  assert.deepEqual([s.status, s.retention_state, s.obs, s.receipts, s.received_count, s.published_count],
    ['COMPLETED', 'PURGED', 0, 1, 3, 2], 'evidence gone; receipt and historical counts kept');
  assert.ok(s.purged_at && s.first_purged_at && s.purged_at.getTime() === s.first_purged_at.getTime());
  assert.equal(s.retain_until.getTime(), before.retain_until.getTime(), 'the stored deadline is unchanged');
  assert.equal(await adsNamed(x, ['r2-a', 'r2-b']), 0, 'orphan identities removed without a tombstone');
  const [log] = await logOf(x, run.run_id);
  assert.equal(log.reason, 'RETENTION_PERIOD');
  assert.deepEqual([log.observations_deleted, log.identities_deleted, log.late, log.purged_by], [2, 2, false, 'si_retention']);
  assert.equal(log.effective_end.getTime(), before.retain_until.getTime());
  assert.equal(log.due_by.getTime() - log.effective_end.getTime(), 3600 * 1000, 'stricter cleanup target: 1 hour');
  assert.equal(log.purged_at.getTime(), s.purged_at.getTime());
  assert.equal((await purge(x)).outcome, 'NOTHING_DUE', 'idempotent');
  await rejects(assert, asOwner(x.admin, a => a.query(`UPDATE si.collection_runs SET retention_state = 'RETAINED' WHERE run_id = $1`, [run.run_id])),
    { code: CHECK, message: /^SI_RETENTION_IMMUTABLE/ });
  for (const sql of [`UPDATE si.purge_log SET late = true`, 'DELETE FROM si.purge_log', 'TRUNCATE si.purge_log']) {
    await rejects(assert, asOwner(x.admin, a => a.query(sql)), { code: CHECK, message: /^SI_PURGE_RECORD_IMMUTABLE/ });
  }
  // Late purge: past the cleanup target (effective end + 1 hour).
  const late = await collect(x, src, [ROW('r2-c')]);
  await age(x, late.run_id, '2 hours');
  assert.deepEqual(summary(await purge(x)), ['PURGED', src, 1, 1, 1, 1]);
  assert.equal((await logOf(x, late.run_id))[0].late, true);
  await invariants(x);
});

test('RT-3: retain revocation and TERMINATE_RETENTION shorten the effective end; a future revocation does not yet', async t => {
  const x = await fresh(t);
  const revoked = await source(x), terminated = await source(x), scheduled = await source(x);
  const runR = await collect(x, revoked, [ROW('r3-r')]);
  const runT = await collect(x, terminated, [ROW('r3-t')]);
  const runS = await collect(x, scheduled, [ROW('r3-s')]);
  assert.equal((await purge(x)).outcome, 'NOTHING_DUE', 'all within their 30-day period');
  const v = await recordRights(x.si_rights_admin, revoked, { retain: 'DENIED', change_reason: 'retain revoked' });
  const term = await control(x.si_rights_admin, terminated, 'TERMINATE_RETENTION');
  const future = await recordRights(x.si_rights_admin, scheduled, { retain: 'DENIED', effective_from_sql: `clock_timestamp() + interval '1 day'` });
  const done = [];
  for (let i = 0; i < 2; i++) { const p = await purge(x); assert.equal(p.outcome, 'PURGED'); done.push(p.purged_source); }
  assert.deepEqual(done.sort(), [revoked, terminated].sort());
  assert.equal((await purge(x)).outcome, 'NOTHING_DUE', 'the scheduled revocation has not taken effect');
  const [lr] = await logOf(x, runR.run_id), [lt] = await logOf(x, runT.run_id);
  assert.equal(lr.reason, 'RIGHTS_ENDED');
  assert.equal(lr.effective_end.getTime(), new Date(v.effective_from).getTime(), 'ends at the revoking version');
  assert.equal(lt.reason, 'TERMINATED');
  assert.equal(lt.effective_end.getTime(), new Date(term.occurred_at).getTime(), 'ends at the termination');
  const sch = (await x.admin.query(`SELECT si.si_effective_retention_end(r.source_id, 1, r.retain_until) AS e FROM si.collection_runs r WHERE run_id = $1`,
    [runS.run_id])).rows[0].e;
  assert.equal(sch.getTime(), new Date(future.effective_from).getTime(), 'scheduled revocation already bounds the end');
  const st = (await retentionStatus(x.si_monitor)).find(r => r.sourceId === scheduled);
  assert.deepEqual([st.retainedRuns, st.dueRuns, st.overdueRuns], [1, 0, 0]);
  assert.equal((await runState(x, runS.run_id)).obs, 1);
  await invariants(x);
});

test('RT-4: source retirement alone does not shorten retention', async t => {
  const x = await fresh(t);
  const src = await source(x);
  const run = await collect(x, src, [ROW('r4-a')]);
  await x.si_rights_admin.query('UPDATE si.sources SET retired_at = clock_timestamp() WHERE source_id = $1', [src]);
  await sleep(20);
  assert.equal((await purge(x)).outcome, 'NOTHING_DUE');
  const st = (await retentionStatus(x.si_retention)).find(r => r.sourceId === src);
  assert.deepEqual([st.retainedRuns, st.dueRuns], [1, 0]);
  assert.equal((await runState(x, run.run_id)).obs, 1);
  await age(x, run.run_id);
  assert.deepEqual(summary(await purge(x)), ['PURGED', src, 1, 1, 1, 0], 'a retired source is still purged at its normal end');
  await invariants(x);
});

test('RT-5: a PURGED run holds no evidence and is audited; incomplete or inconsistent purges cannot commit', async t => {
  const x = await fresh(t);
  const src = await source(x);
  const run = await collect(x, src, [ROW('r5-a'), ROW('r5-b')]);
  await age(x, run.run_id);
  await rejects(assert, ownerPurge(x, run, { deleteObs: false, deleteAds: false }), { code: CHECK, message: /^SI_PURGE_INCOMPLETE/ });
  await rejects(assert, ownerPurge(x, run, { log: false }), { code: CHECK, message: /^SI_PURGE_UNAUDITED/ });
  await rejects(assert, ownerPurge(x, run, { deleteAds: false }), { code: CHECK, message: /^SI_PURGE_ORPHAN_IDENTITY/ });
  await rejects(assert, ownerPurge(x, run, { logRows: 1 }), { code: CHECK, message: /^SI_PURGE_LOG_MISMATCH/ });
  await rejects(assert, asOwner(x.admin, a => a.query(`INSERT INTO si.purge_log (batch_id, run_id, source_id, rights_version_id, reason,
      effective_end, due_by, purged_at, observations_deleted, identities_deleted, late, purged_by)
    SELECT gen_random_uuid(), run_id, source_id, rights_version_id, 'RETENTION_PERIOD', retain_until, retain_until, retain_until, 2, 0, false, 'x'
      FROM si.collection_runs WHERE run_id = $1`, [run.run_id])), { code: CHECK, message: /^SI_PURGE_LOG_MISMATCH/ });
  const s = await runState(x, run.run_id);
  assert.deepEqual([s.retention_state, s.obs], ['RETAINED', 2], 'every refused attempt left nothing behind');
  assert.equal((await logOf(x, run.run_id)).length, 0);
  assert.deepEqual(summary(await purge(x)), ['PURGED', src, 1, 2, 2, 0]);
  assert.equal((await runState(x, run.run_id)).obs, 0);
  await invariants(x);
});

test('RT-6/RT-7: retained runs keep publication integrity; shared identities survive; only orphans are removed', async t => {
  const x = await fresh(t);
  const src = await source(x);
  const old1 = await collect(x, src, [ROW('s-shared'), ROW('s-only1'), ROW('s-pair')]);
  const old2 = await collect(x, src, [ROW('s-pair'), ROW('s-only2')]);
  const keep = await collect(x, src, [ROW('s-shared'), ROW('s-keep')]);
  const sharedId = (await x.admin.query(`SELECT ad_id FROM si.ads WHERE native_ad_id = 's-shared'`)).rows[0].ad_id;
  await age(x, [old1.run_id, old2.run_id]);
  assert.deepEqual(summary(await purge(x)), ['PURGED', src, 2, 5, 3, 0], 's-only1, s-pair, s-only2 deleted once; s-shared kept');
  const logs = (await x.admin.query('SELECT run_id, identities_deleted, batch_id FROM si.purge_log ORDER BY run_id')).rows;
  assert.equal(logs.length, 2);
  assert.equal(new Set(logs.map(l => l.batch_id)).size, 1, 'one batch');
  assert.equal(logs.reduce((a, l) => a + l.identities_deleted, 0), 3, 'each deleted identity attributed exactly once');
  assert.equal(await adsNamed(x, ['s-only1', 's-pair', 's-only2']), 0);
  assert.equal((await x.admin.query(`SELECT ad_id FROM si.ads WHERE native_ad_id = 's-shared'`)).rows[0].ad_id, sharedId, 'same identity');
  const k = await runState(x, keep.run_id);
  assert.deepEqual([k.retention_state, k.obs, k.published_count, k.receipts], ['RETAINED', 2, 2, 1]);
  // A purged identity can be collected again; it receives a new identity row.
  const again = await collect(x, src, [ROW('s-only1')]);
  assert.equal(again.published_count, 1);
  assert.equal(await adsNamed(x, ['s-only1']), 1);
  await invariants(x);
});

/**
 * A completion that reuses an identity whose last observation is being purged. The instrumented T2
 * pauses after its identity phase (identities exist, observation not yet inserted); the purge then
 * runs in an open transaction; the T2 resumes. Without the rank-3 source lock the purge deletes the
 * identity under the completion and the completion's foreign-key check fails, quoting the key.
 */
async function completionDuringPurge(x) {
  await asOwner(x.admin, a => a.query(T2_PAUSED));
  const id = canary();
  const src = await source(x);
  const old = await collect(x, src, [ROW(id)]);
  await age(x, old.run_id);
  const rows = [ROW(id), ROW(`${id}-new`)];
  const run = await begin(x, src, rows);
  const col = await x.connect('si_collector'), ret = await x.connect('si_retention');
  const [colPid, retPid] = [await pid(col), await pid(ret)];
  await col.query(`SET si.test_pause = '1.5'`);
  const t2 = settle((async () => {
    await col.query('BEGIN');
    try { const r = (await col.query(T2, [run.run_id, run.lease_token, JSON.stringify(rows)])).rows[0]; await col.query('COMMIT'); return r; }
    catch (e) { await col.query('ROLLBACK').catch(() => {}); throw e; }
  })());
  for (let i = 0; ; i++) {
    const w = (await x.admin.query('SELECT wait_event FROM pg_stat_activity WHERE pid = $1', [colPid])).rows[0];
    if (w?.wait_event === 'PgSleep') break;
    assert.ok(i < 200, 'the completion reached its pause');
    await sleep(10);
  }
  await ret.query('BEGIN');
  const p = (await ret.query('SELECT * FROM si.si_purge_due(10)')).rows[0];
  if (p.outcome === 'PURGED') await waitUntilBlocked(x.admin, colPid, retPid, 8000);   // the completion now waits on the purge
  await ret.query('COMMIT');
  return { id, src, old, run, purge: p, t2: await t2 };
}

test('RT-8: concurrent completion and purge cannot produce a foreign-key error or a content leak (forced interleavings)', async t => {
  // (a) completion first: the purge skips the source (BUSY) instead of racing it.
  const x = await fresh(t);
  const a = await completionDuringPurge(x);
  assert.equal(a.purge.outcome, 'BUSY', 'source held by the completion is skipped, not raced');
  assert.equal(a.t2.status, 'ok', `completion succeeds: ${a.t2.code ?? ''}`);
  assert.equal(a.t2.value.published_count, 2);
  assert.deepEqual(summary(await purge(x)), ['PURGED', a.src, 1, 1, 0, 0], 'afterwards: old run purged, shared identity kept');
  assert.equal(await adsNamed(x, [a.id, `${a.id}-new`]), 2);
  await invariants(x);

  // (b) purge first: the completion waits for the source lock, then creates a fresh identity.
  const y = await fresh(t);
  const id = canary();
  const src = await source(y);
  const old = await collect(y, src, [ROW(id)]);
  await age(y, old.run_id);
  const rows = [ROW(id)];
  const run = await begin(y, src, rows);
  const ret = await y.connect('si_retention'), col = await y.connect('si_collector');
  const [retPid, colPid] = [await pid(ret), await pid(col)];
  await ret.query('BEGIN');
  assert.deepEqual(summary((await ret.query('SELECT * FROM si.si_purge_due(10)')).rows[0]), ['PURGED', src, 1, 1, 1, 0]);
  const t2 = settle((async () => {
    await col.query('BEGIN');
    try { const r = (await col.query(T2, [run.run_id, run.lease_token, JSON.stringify(rows)])).rows[0]; await col.query('COMMIT'); return r; }
    catch (e) { await col.query('ROLLBACK').catch(() => {}); throw e; }
  })());
  await waitUntilBlocked(y.admin, colPid, retPid);
  await ret.query('COMMIT');
  const r = await t2;
  assert.equal(r.status, 'ok', `completion after the purge succeeds: ${r.code ?? ''}`);
  assert.equal(await adsNamed(y, [id]), 1, 'a fresh identity');
  await invariants(y);
  assert.ok(!serverLog().includes(id) && !serverLog().includes(a.id), 'no identity value in the server log');
});

test('RT-9: concurrent purgers never double-purge and do not convoy', async t => {
  const x = await fresh(t);
  const s1 = await source(x), s2 = await source(x);
  const r1 = await collect(x, s1, [ROW('p9-a')]), r2 = await collect(x, s1, [ROW('p9-b')]), r3 = await collect(x, s2, [ROW('p9-c')]);
  await age(x, [r1.run_id, r2.run_id], '30 minutes');
  await age(x, r3.run_id, '10 minutes');
  const A = await x.connect('si_retention'), B = await x.connect('si_retention');
  await A.query('BEGIN');
  assert.deepEqual(summary((await A.query('SELECT * FROM si.si_purge_due(10)')).rows[0]), ['PURGED', s1, 2, 2, 2, 0]);
  const t0 = performance.now();
  assert.deepEqual(summary((await B.query('SELECT * FROM si.si_purge_due(10)')).rows[0]), ['PURGED', s2, 1, 1, 1, 0], 'B takes the other source');
  assert.ok(performance.now() - t0 < 2000, 'B did not wait for A');
  assert.equal((await B.query('SELECT * FROM si.si_purge_due(10)')).rows[0].outcome, 'BUSY', 'the only due source is held by A');
  await A.query('COMMIT');
  assert.equal((await B.query('SELECT * FROM si.si_purge_due(10)')).rows[0].outcome, 'NOTHING_DUE');
  const logs = (await x.admin.query('SELECT run_id, count(*)::int AS n FROM si.purge_log GROUP BY run_id')).rows;
  assert.equal(logs.length, 3);
  assert.ok(logs.every(l => l.n === 1), 'exactly one audit record per run');
  await invariants(x);
});

test('RT-10: an interrupted purge leaves no partial deletion or audit record; failures are recorded as codes', async t => {
  const x = await fresh(t);
  const src = await source(x);
  const big = i => Array.from({ length: 500 }, (_, k) => ROW(`c${i}-${k}`));
  const runs = [await collect(x, src, big(0)), await collect(x, src, big(1))];
  await age(x, runs.map(r => r.run_id));
  const counts = async () => (await x.admin.query(`SELECT (SELECT count(*)::int FROM si.observations) AS obs, (SELECT count(*)::int FROM si.ads) AS ads,
    (SELECT count(*)::int FROM si.purge_log) AS logs,
    (SELECT count(*)::int FROM si.collection_runs WHERE retention_state = 'RETAINED') AS retained`)).rows[0];
  const before = await counts();
  assert.deepEqual(before, { obs: 1000, ads: 1000, logs: 0, retained: 2 });
  // Crash: the purging backend is terminated after its work, before COMMIT.
  const A = await x.connect('si_retention');
  await A.query('BEGIN');
  assert.equal((await A.query('SELECT * FROM si.si_purge_due(10)')).rows[0].runs_purged, 2);
  await x.admin.query('SELECT pg_terminate_backend($1)', [await pid(A)]);
  await rejects(assert, A.query('COMMIT'));
  assert.deepEqual(await counts(), before, 'crash: nothing deleted, nothing audited');
  // Abort in the middle of the deletes (statement timeout): same.
  const B = await x.connect('si_retention');
  await B.query(`SET statement_timeout = '5ms'`);
  const err = await rejects(assert, purgeDue(B, 10));
  assert.ok(err instanceof RetentionFailed);
  assert.equal(err.message, 'RETENTION_FAILED: STATEMENT_TIMEOUT');
  assert.deepEqual([err.code, err.sqlstate, err.recorded], ['STATEMENT_TIMEOUT', '57014', true]);
  await B.query('RESET statement_timeout');
  assert.deepEqual(await counts(), before, 'timeout: nothing deleted, nothing audited');
  // Unsupported isolation level: refused before any lock.
  await B.query(`SET default_transaction_isolation = 'repeatable read'`);
  const iso = await rejects(assert, purgeDue(B, 10));
  assert.deepEqual([iso.code, iso.sqlstate, iso.recorded], ['ISOLATION', '25000', true]);
  await B.query('RESET default_transaction_isolation');
  const failures = await purgeFailures(x.si_monitor, 10);
  assert.deepEqual(failures.map(f => [f.code, f.sqlstate, f.recordedBy]), [['ISOLATION', '25000', 'si_retention'], ['STATEMENT_TIMEOUT', '57014', 'si_retention']]);
  // Recovery: the next batch purges everything once.
  assert.deepEqual(summary(await purge(x)), ['PURGED', src, 2, 1000, 1000, 0]);
  assert.deepEqual(await counts(), { obs: 0, ads: 0, logs: 2, retained: 0 });
  await invariants(x);
});

test('RT-11: only si_retention can purge; no application role can read or delete evidence', async t => {
  const x = await fresh(t);
  const src = await source(x);
  const run = await collect(x, src, [ROW('r11')]);
  await age(x, run.run_id);
  for (const role of ['si_collector', 'si_rights_admin', 'si_monitor']) {
    await rejects(assert, purge(x, 10, x[role]), { code: '42501' });
    await rejects(assert, x[role].query(`SELECT si.si_record_purge_failure('INTERNAL', NULL)`), { code: '42501' });
  }
  for (const role of ['si_collector', 'si_rights_admin']) {
    await rejects(assert, x[role].query('SELECT * FROM si.si_retention_status()'), { code: '42501' });
    await rejects(assert, x[role].query('SELECT * FROM si.si_purge_failures(5)'), { code: '42501' });
  }
  for (const role of ['si_collector', 'si_rights_admin', 'si_retention', 'si_monitor']) {
    for (const sql of ['SELECT 1 FROM si.observations', 'SELECT 1 FROM si.ads', 'DELETE FROM si.observations', 'DELETE FROM si.ads',
                       `SELECT si.si_effective_retention_end('x', 1, now())`, `SELECT si.si_cleanup_due_by('x', 1, now())`,
                       `SELECT si.si_retention_end_reason('x', 1, now())`]) {
      await rejects(assert, x[role].query(sql), { code: '42501' });
    }
  }
  for (const role of ['si_collector', 'si_rights_admin', 'si_monitor']) {
    await rejects(assert, x[role].query('SELECT 1 FROM si.purge_log'), { code: '42501' });
    await rejects(assert, x[role].query('SELECT 1 FROM si.purge_failures'), { code: '42501' });
  }
  for (const bad of [0, 21, null]) await rejects(assert, purge(x, bad), { code: '22023' });
  await rejects(assert, x.si_retention.query(`SELECT si.si_record_purge_failure('FREE TEXT', NULL)`), { code: '22023' });
  await rejects(assert, x.si_retention.query(`SELECT si.si_record_purge_failure('INTERNAL', 'not-a-state')`), { code: '22023' });
  await rejects(assert, purgeDue(x.si_retention, MAX_PURGE_RUNS + 1), { message: /^RETENTION_FAILED: BAD_ARGUMENT$/ });
  assert.equal((await runState(x, run.run_id)).obs, 1, 'nothing purged by the refused calls');
  assert.equal((await purge(x)).outcome, 'PURGED');
  assert.equal((await x.si_retention.query('SELECT count(*)::int AS n FROM si.purge_log')).rows[0].n, 1, 'si_retention reads the content-free audit');
});

test('RT-12: audit records, status, CLI output and logs contain no advertising content', async t => {
  const x = await fresh(t);
  const marks = Array.from({ length: 6 }, canary);
  const src = await source(x);
  const run = await collect(x, src, [ROW(marks[0], { advertiserName: marks[1], title: marks[2], sourceUrl: `https://example.test/${marks[3]}`,
    destinationUrl: `https://example.test/${marks[4]}`, creativeUrl: `https://example.test/${marks[5]}` })]);
  await age(x, run.run_id, '3 hours');
  const notices = [];
  for (const c of Object.values(x)) if (c?.on) c.on('notice', m => notices.push(`${m.message} ${m.detail ?? ''}`));
  const over = cli(x.db, 'si_monitor', ['overdue']);
  assert.equal(over.status, 2, 'overdue evidence is reported with exit code 2');
  assert.equal(JSON.parse(over.stdout)[0].overdueRuns, 1);
  const out = [over, cli(x.db, 'si_retention', ['purge', '--limit', '5']), cli(x.db, 'si_monitor', ['status']),
               cli(x.db, 'si_monitor', ['overdue']), cli(x.db, 'si_retention', ['failures']),
               cli(x.db, 'si_monitor', ['purge']), cli(x.db, 'si_retention', ['purge', '--limit', '99'])];
  assert.deepEqual(JSON.parse(out[1].stdout), { outcome: 'PURGED', sourceId: src, runsPurged: 1, observationsPurged: 1, identitiesPurged: 1, lateRuns: 1 });
  assert.equal(out[3].status, 0, 'nothing overdue after the purge');
  assert.equal(out[5].status, 1);
  assert.equal(out[5].stderr.trim(), 'RETENTION_FAILED code=PRIVILEGE sqlstate=42501 recorded=false', 'fixed failure line, no database text');
  assert.equal(out[6].stderr.trim(), 'RETENTION_FAILED code=BAD_ARGUMENT sqlstate=none recorded=false');
  const texts = [
    ...out.flatMap(o => [o.stdout, o.stderr]), ...notices,
    JSON.stringify((await x.admin.query('SELECT * FROM si.purge_log')).rows),
    JSON.stringify((await x.admin.query('SELECT * FROM si.purge_failures')).rows),
    JSON.stringify(await retentionStatus(x.si_monitor)), JSON.stringify(await overdueRetention(x.si_monitor)),
    JSON.stringify(await purgeFailures(x.si_retention, 100)), serverLog()];
  for (const m of marks) assert.ok(!texts.some(t => t.includes(m)), `canary ${m} absent from audit, status, CLI output and logs`);
  // Catalog: the audit tables have only id, code, time and count columns, each constrained.
  const cols = async t => (await x.admin.query(`SELECT array_agg(attname::text || ':' || format_type(atttypid, atttypmod) ORDER BY attnum) AS c
     FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped`, [t])).rows[0].c;
  assert.deepEqual(await cols('si.purge_log'), ['purge_id:bigint', 'batch_id:uuid', 'run_id:uuid', 'source_id:text', 'rights_version_id:bigint',
    'reason:text', 'effective_end:timestamp with time zone', 'due_by:timestamp with time zone', 'purged_at:timestamp with time zone',
    'observations_deleted:integer', 'identities_deleted:integer', 'late:boolean', 'purged_by:text']);
  assert.deepEqual(await cols('si.purge_failures'), ['failure_id:bigint', 'occurred_at:timestamp with time zone', 'code:text', 'sqlstate:text',
    'recorded_by:text']);
});

test('RT-13 (gates): purge timing and SUSPEND / TERMINATE waits against a maximum-size purge batch', async t => {
  const x = await fresh(t, 'm3retperf');
  const full = (tag, i) => Array.from({ length: 500 }, (_, k) => ROW(`${tag}${i}-${k}`, { title: 't'.repeat(900) }));
  async function loaded(tag, runsN) {
    const src = await source(x);
    const ids = [];
    for (let i = 0; i < runsN; i++) ids.push((await collect(x, src, full(tag, i))).run_id);
    await age(x, ids);
    return src;
  }
  // Batch timing: 10 runs x 500 observations, purged 2 runs per batch.
  await loaded('pt', 10);
  const ms = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now(); const p = await purge(x, 2); ms.push(performance.now() - t0);
    assert.deepEqual([p.outcome, p.runs_purged, p.observations_purged], ['PURGED', 2, 1000]);
  }
  ms.sort((a, b) => a - b);
  // Emergency controls during a maximum batch (20 runs, 10,000 observations and identities).
  const gate = [];
  for (const kind of ['SUSPEND', 'TERMINATE_RETENTION']) {
    const src = await loaded(kind === 'SUSPEND' ? 'gs' : 'gt', MAX_PURGE_RUNS);
    const ret = await x.connect('si_retention'), ra = await x.connect('si_rights_admin');
    const [retPid, raPid] = [await pid(ret), await pid(ra)];
    const t0 = performance.now();
    const p = (async () => { const r = (await ret.query('SELECT * FROM si.si_purge_due($1)', [MAX_PURGE_RUNS])).rows[0]; return { r, ms: performance.now() - t0 }; })();
    for (let i = 0; ; i++) {
      const a = (await x.admin.query('SELECT state FROM pg_stat_activity WHERE pid = $1', [retPid])).rows[0];
      if (a?.state === 'active') break;
      assert.ok(i < 500, 'purge started');
      await sleep(2);
    }
    await sleep(30);                                                     // the purge holds the source by now
    const c0 = performance.now();
    const ctl = settle(control(ra, src, kind).then(r => ({ r, ms: performance.now() - c0 })));
    let blocked = false;
    for (let i = 0; i < 400 && !blocked; i++) {
      blocked = (await x.admin.query('SELECT $2::int = ANY (pg_blocking_pids($1)) AS b', [raPid, retPid])).rows[0].b;
      if (!blocked) { const st = (await x.admin.query('SELECT state FROM pg_stat_activity WHERE pid = $1', [raPid])).rows[0]; if (st?.state === 'idle') break; }
    }
    const pr = await p, cr = await ctl;
    assert.equal(cr.status, 'ok', `${kind} recorded: ${cr.code ?? ''}`);
    assert.deepEqual([pr.r.outcome, pr.r.runs_purged, pr.r.observations_purged, pr.r.identities_purged], ['PURGED', MAX_PURGE_RUNS, 10000, 10000]);
    assert.ok(blocked, `${kind} was observed waiting for the purge (contention proven)`);
    gate.push({ kind, purgeMs: pr.ms, waitMs: cr.value.ms });
  }
  console.log(`# RT-13 purge batch of 2 runs (1000 obs) ms: median ${ms[2].toFixed(0)}, max ${ms[4].toFixed(0)}; ` +
              gate.map(g => `${g.kind}: max-batch purge ${g.purgeMs.toFixed(0)} ms, control wait ${g.waitMs.toFixed(0)} ms`).join('; '));
  assert.ok(ms[2] <= 2000, `median batch ${ms[2].toFixed(0)} ms <= 2000 ms`);
  for (const g of gate) {
    assert.ok(g.purgeMs <= 5000, `${g.kind}: maximum purge batch ${g.purgeMs.toFixed(0)} ms <= 5000 ms`);
    assert.ok(g.waitMs <= 5000, `${g.kind}: emergency-control wait ${g.waitMs.toFixed(0)} ms <= 5000 ms`);
  }
  await invariants(x);
});

test('RT-14: down 0006 with purged data restores the exact 0005 catalog; up re-applies identically', async t => {
  const x = await fresh(t);
  const src = await source(x);
  const run = await collect(x, src, [ROW('r14')]);
  await age(x, run.run_id);
  assert.equal((await purge(x)).outcome, 'PURGED');
  const at6 = await schemaFingerprint(x.admin);
  const ref = await freshDatabase(t, 'm3ret5', { migrate: false });
  const refc = await connect({ database: ref }); t.after(() => refc.end());
  await migrateUp(refc, { to: 5 });
  assert.deepEqual(await migrateDown(x.admin, { to: 5, allowDestructive: true }), [17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6]);
  // A table ACL equal to the owner's default (acldefault: all privileges to the owner, none to others)
  // is equivalent to NULL; pg_dump/restore turns the explicit form into NULL, so on a restored cluster
  // (DR-1) the two lineages differ only in that spelling. Nothing else is normalized.
  const norm = f => f.replaceAll('"relacl":"{si_owner=arwdDxt/si_owner}"', '"relacl":null');
  assert.equal(norm(await schemaFingerprint(x.admin)), norm(await schemaFingerprint(refc)), 'exact 0005 catalog with purged data present');
  assert.equal((await runState(x, run.run_id)).retention_state, 'PURGED', 'a PURGED run is a valid 0005 row');
  assert.deepEqual(await migrateUp(x.admin), [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.equal(norm(await schemaFingerprint(x.admin)), norm(at6));
});

// ------------------------------------------------------------------------------------------------
// Targeted mutants: each is applied to its own disposable database and must be detected.
async function scenarioTerminate(x) {
  const src = await source(x);
  const run = await collect(x, src, [ROW('m-term')]);
  await control(x.si_rights_admin, src, 'TERMINATE_RETENTION');
  const p = await purge(x);
  return p.outcome !== 'PURGED' || (await runState(x, run.run_id)).obs !== 0;             // detected = not purged
}
async function scenarioUnexpiredDelete(x) {
  const src = await source(x);
  const run = await collect(x, src, [ROW('m-del'), ROW('m-del2')]);
  const r = await settle(asOwner(x.admin, a => a.query('DELETE FROM si.observations WHERE run_id = $1 AND ordinal = 0', [run.run_id])));
  return !(r.status === 'db-error' && r.code === CHECK && /^SI_EVIDENCE_IMMUTABLE/.test(r.message));   // detected = not refused at once
}
async function scenarioPurgedWithEvidence(x) {
  const src = await source(x);
  const run = await collect(x, src, [ROW('m-pwe')]);
  await age(x, run.run_id);
  const r = await settle(ownerPurge(x, run, { deleteObs: false, deleteAds: false }));
  return r.status === 'ok';                                                                 // detected = it committed
}
async function scenarioSharedIdentity(x) {
  const src = await source(x);
  const old = await collect(x, src, [ROW('m-shared'), ROW('m-own')]);
  await collect(x, src, [ROW('m-shared')]);
  await age(x, old.run_id);
  const r = await settle(purge(x));
  return r.status !== 'ok' || r.value.outcome !== 'PURGED' || (await adsNamed(x, ['m-shared'])) !== 1;
}
async function scenarioLeak(x) {
  const id = canary();
  const notices = [];
  x.si_retention.on('notice', m => notices.push(`${m.message} ${m.detail ?? ''}`));
  const src = await source(x);
  const run = await collect(x, src, [ROW(id)]);
  await age(x, run.run_id);
  const r = await settle(purge(x));
  await sleep(200);                                                                         // let the server log flush
  const out = [JSON.stringify(r), ...notices, JSON.stringify((await x.admin.query('SELECT * FROM si.purge_log')).rows), serverLog()];
  return out.some(t => t.includes(id));                                                     // detected = canary found
}
async function scenarioSourceLock(x) {
  const r = await completionDuringPurge(x);
  if (r.t2.status !== 'ok') {
    // What the race does without the lock: the completion's FK check fails and its detail quotes the identity.
    console.log(`# RT-M source-lock race: purge ${r.purge.outcome}; completion ${r.t2.status} ${r.t2.code}; ` +
                `error detail quotes the native ad id: ${String(r.t2.message ?? '').includes(r.id) || String(r.t2.detail ?? '').includes(r.id)}`);
  }
  return r.purge.outcome === 'PURGED' || r.t2.status !== 'ok';                              // detected = raced the completion
}

const MUTANTS = [
  { name: 'missing source lock', scenario: scenarioSourceLock,
    sql: mutate(PURGE_FN, 'PERFORM 1 FROM si.sources s WHERE s.source_id = cand FOR NO KEY UPDATE SKIP LOCKED;',
                'PERFORM 1 FROM si.sources s WHERE s.source_id = cand;') },
  { name: 'unconditional evidence deletion', scenario: scenarioUnexpiredDelete,
    sql: mutate(GUARD_FN, `BEGIN\n  IF TG_OP = 'DELETE' AND TG_LEVEL = 'ROW'`, `BEGIN\n  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;\n  IF TG_OP = 'DELETE' AND TG_LEVEL = 'ROW'`) },
  { name: 'ignoring TERMINATE_RETENTION', scenario: scenarioTerminate,
    sql: mutate(RETENTION_END_FN, '(SELECT min(c.occurred_at) FROM si.source_controls c\n      WHERE c.source_id = p_source_id' +
      ` AND c.kind = 'TERMINATE_RETENTION'\n        AND c.through_version >= p_collected_version),`, 'NULL::timestamptz,') },
  { name: 'committing PURGED with evidence remaining', scenario: scenarioPurgedWithEvidence,
    sql: mutate(PURGE_CHECK_FN, '  IF EXISTS (SELECT 1 FROM si.observations o WHERE o.run_id = NEW.run_id) THEN\n' +
      `    RAISE EXCEPTION 'SI_PURGE_INCOMPLETE: run % is PURGED but still holds evidence', NEW.run_id USING ERRCODE = '23514';\n  END IF;\n`, '') },
  { name: 'identity deleted without the recheck', scenario: scenarioSharedIdentity,
    sql: mutate(PURGE_FN, `                AND NOT EXISTS (SELECT 1 FROM si.observations o WHERE o.ad_id = a.ad_id)\n`, '') },
  { name: 'content leaked into diagnostics', scenario: scenarioLeak,
    sql: mutate(PURGE_FN, '  -- Identities whose last observation was just deleted',
      `  RAISE WARNING 'purged identities: %', (SELECT string_agg(a.native_ad_id, ',') FROM si.ads a WHERE a.ad_id = ANY (g_ads));\n  -- Identities whose last observation was just deleted`) }
];
for (const m of MUTANTS) {
  test(`RT-M (${m.name}): the baseline passes the scenario and the targeted mutant is detected`, async t => {
    const base = await m.scenario(await fresh(t, 'm3retmb'));
    const x = await fresh(t, 'm3retmm');
    await asOwner(x.admin, a => a.query(m.sql));
    const killed = await m.scenario(x);
    console.log(`# RT-M ${m.name}: baseline ${base ? 'DETECTED (unexpected)' : 'clean'}, mutant ${killed ? 'KILLED' : 'SURVIVED'}`);
    assert.equal(base, false, `${m.name}: the unmutated code passes the scenario`);
    assert.equal(killed, true, `${m.name}: the mutant is detected`);
  });
}

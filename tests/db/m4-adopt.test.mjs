// B-002 M4-P3.3 Phase 1 (R-42): populated adoption of migration 0022 — `build-index` (CREATE INDEX CONCURRENTLY, outside
// any transaction) and `adopt` (record 0022 under the migrator's advisory lock after db/ops/readiness.sql). Real
// disposable PostgreSQL 16; each test builds its own database at version 21 and fills si.observations.
// Fixtures a product path cannot perform, labelled where used:
//   - BULK ROWS: the test superuser inserts synthetic observations under session_replication_role = replica (triggers and
//     FK checks skipped; CHECKs enforced) to give the concurrent build real work. Content is synthetic.
//   - HELD BUILD: a REPEATABLE READ transaction holding a snapshot keeps CREATE INDEX CONCURRENTLY in its wait phase, so a
//     cancellation, a lost connection, concurrent inserts or a racing migrator hit the build deterministically mid-way.
//   - CATALOG FLAGS: the superuser marks one index invalid where a single-flag state is needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { asOwner, cfg, connect, freshDatabase, roles, schemaFingerprint, settle } from './helpers.mjs';
import { adoptMigration, buildIndexConcurrently, DEFAULT_MIGRATIONS_DIR, MIGRATION_LOCK_KEY, migrateDown, migrateUp, loadMigrations } from '../../dist/persistence/migrate.js';
import { checkIndexReadiness, REQUIRED_INDEX_DEFINITION } from '../../dist/persistence/readiness.js';

const ROWS = 20000;
const OWN = new Set(['INDEX_NOT_VALID', 'INDEX_NOT_READY', 'INDEX_NOT_LIVE']);
const M22 = loadMigrations().find(m => m.version === 22);
const codes = async c => (await checkIndexReadiness(c)).map(f => `${f.code}:${f.object}`).sort();
const version = async c => Number((await c.query('SELECT coalesce(max(version), 0) AS v FROM si.schema_migrations')).rows[0].v);
const oidOf = async (c, name) => (await c.query(`SELECT to_regclass($1)::oid AS o`, [name])).rows[0].o;

async function bulk(admin, n, from = 0) {                                                   // BULK ROWS
  await admin.query('BEGIN'); await admin.query('SET LOCAL session_replication_role = replica');
  await admin.query(`INSERT INTO si.observations (run_id, source_id, rights_version_id, ordinal, ad_id, network, native_ad_id, advertiser_name,
                       countries, seen_at, source_url, content_sha256)
    SELECT md5('r' || (g / 500))::uuid, 'mig-src', 1, g % 500, g, 'META', 'native-' || g, 'Synthetic Co ' || (g % 97), ARRAY['DE'],
           now(), 'https://example.test/a', repeat('a', 64) FROM generate_series($1::bigint, $2::bigint - 1) g`, [from, from + n]);
  await admin.query('COMMIT');
}
/** A database at version 21 (0022 not applied, no index), with synthetic rows. */
async function at(t, v = 21, rows = ROWS) {
  const db = await freshDatabase(t, 'm4mig', { migrate: false });
  const { admin } = await roles(t, db, ['admin']);
  await migrateUp(admin, { to: v });
  if (v >= 5 && rows) await bulk(admin, rows);
  const conn = async user => { const k = await connect({ user, database: db }); t.after(() => k.end().catch(() => {})); return k; };
  return { db, admin, conn };
}
const err = code => e => e.code === code || new RegExp(`^${code}:`).test(e.message);

/** HELD BUILD: a snapshot older than the build; the build waits for it in its final phase. */
async function holdSnapshot(conn) {
  const h = await conn(undefined);
  await h.query('BEGIN ISOLATION LEVEL REPEATABLE READ'); await h.query('SELECT count(*) FROM si.sources');
  return h;
}
async function buildWaiting(admin, ms = 30000) {
  const t0 = performance.now();
  for (;;) {
    const r = (await admin.query(`SELECT p.pid, p.phase FROM pg_stat_progress_create_index p WHERE p.command = 'CREATE INDEX CONCURRENTLY'`)).rows[0];
    const w = r && (await admin.query(`SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`, [r.pid])).rows[0];
    if (r && w?.wait_event_type === 'Lock' && /waiting/.test(r.phase)) return r;
    if (performance.now() - t0 > ms) throw new Error(`build never reached its wait phase: ${JSON.stringify(r)}`);
    await sleep(10);
  }
}
const otherIndexes = async c => (await c.query(`SELECT c.relname, c.oid::int AS oid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                                                 WHERE c.relnamespace = 'si'::regnamespace AND c.relname <> 'observations_by_ad_fk' ORDER BY 1`)).rows;

test('MIG-1: build, adopt as si_migrator, then up: 0022 is recorded with its exact checksums and evidence; the catalog equals a normal migration', async t => {
  const x = await at(t);
  const mig = await x.conn('si_migrator');
  const b = await buildIndexConcurrently(mig, { version: 22 });
  assert.equal(b.state, 'BUILT');
  assert.deepEqual(await codes(x.admin), []);
  const a = await adoptMigration(mig, { version: 22 });
  assert.equal(a.state, 'ADOPTED');
  const row = (await x.admin.query('SELECT * FROM si.schema_migrations WHERE version = 22')).rows[0];
  assert.deepEqual([row.name, row.up_sha256, row.down_sha256, row.applied_by], [M22.name, M22.upSha256, M22.downSha256, 'si_migrator']);
  const ev = (await x.admin.query('SELECT * FROM si.schema_adoptions')).rows;
  assert.equal(ev.length, 1);
  assert.deepEqual([ev[0].version, ev[0].name, ev[0].up_sha256, ev[0].down_sha256, ev[0].index_name, ev[0].index_definition, ev[0].readiness, ev[0].adopted_by],
                   [22, M22.name, M22.upSha256, M22.downSha256, 'observations_by_ad_fk', REQUIRED_INDEX_DEFINITION, 'PASS', 'si_migrator']);
  assert.equal(Number(ev[0].index_oid), Number(await oidOf(x.admin, 'si.observations_by_ad_fk')));
  assert.ok(Number(ev[0].index_bytes) > 0);
  assert.deepEqual(await migrateUp(mig), [23, 24, 25]);
  // Reference: a database migrated normally to 23. Equal except the adoption log's own objects.
  const ref = await at(t, 25, 0);
  const strip = f => { const j = JSON.parse(f);
    j.relations = j.relations.filter(r => !/^schema_adoptions/.test(r.relname));
    j.columns = j.columns.filter(r => r.relname !== 'schema_adoptions');
    j.constraints = j.constraints.filter(r => r.rel !== 'si.schema_adoptions');
    j.indexes = j.indexes.filter(r => !/^schema_adoptions/.test(r.indexname));
    j.triggers = j.triggers.filter(r => r.rel !== 'si.schema_adoptions');
    j.functions = j.functions.filter(r => r.proname !== 'trg_schema_adoptions_append_only');
    return JSON.stringify(j); };
  assert.equal(strip(await schemaFingerprint(x.admin)), strip(await schemaFingerprint(ref.admin)), 'adopted catalog = normally migrated catalog');
  assert.deepEqual(await codes(x.admin), []);
});

test('MIG-2: wrong migration state: version 20 is refused; a normally migrated database is ALREADY_APPLIED; only 22 is adoptable', async t => {
  const low = await at(t, 20);
  await assert.rejects(buildIndexConcurrently(low.admin, { version: 22 }), err('WRONG_VERSION'));
  await assert.rejects(adoptMigration(low.admin, { version: 22 }), err('WRONG_VERSION'));
  assert.equal(await version(low.admin), 20);
  const done = await at(t, 23, 0);
  assert.equal((await buildIndexConcurrently(done.admin, { version: 22 })).state, 'ALREADY_APPLIED');
  assert.equal((await adoptMigration(done.admin, { version: 22 })).state, 'ALREADY_APPLIED');
  assert.equal((await done.admin.query(`SELECT to_regclass('si.schema_adoptions') AS t`)).rows[0].t, null, 'nothing written');
  for (const v of [21, 23]) {
    await assert.rejects(adoptMigration(done.admin, { version: v }), err('NOT_ADOPTABLE'));
    await assert.rejects(buildIndexConcurrently(done.admin, { version: v }), err('NOT_ADOPTABLE'));
  }
});

test('MIG-3: repeated invocation is safe: build twice, adopt twice; one migration row and one evidence row', async t => {
  const x = await at(t);
  assert.equal((await buildIndexConcurrently(x.admin, { version: 22 })).state, 'BUILT');
  assert.equal((await buildIndexConcurrently(x.admin, { version: 22 })).state, 'ALREADY_BUILT');
  assert.equal((await adoptMigration(x.admin, { version: 22 })).state, 'ADOPTED');
  assert.equal((await adoptMigration(x.admin, { version: 22 })).state, 'ALREADY_APPLIED');
  assert.equal((await buildIndexConcurrently(x.admin, { version: 22 })).state, 'ALREADY_APPLIED');
  assert.equal((await x.admin.query('SELECT count(*)::int AS n FROM si.schema_migrations WHERE version = 22')).rows[0].n, 1);
  assert.equal((await x.admin.query('SELECT count(*)::int AS n FROM si.schema_adoptions')).rows[0].n, 1);
});

test('MIG-4: a cancelled concurrent build leaves an invalid index that is never accepted: adopt refuses; build refuses without --replace-invalid; replacement drops only that index', async t => {
  const x = await at(t);
  const before = await otherIndexes(x.admin);
  const mig = await x.conn('si_migrator');
  const h = await holdSnapshot(x.conn);
  const build = settle(buildIndexConcurrently(mig, { version: 22 }));
  const p = await buildWaiting(x.admin);
  await x.admin.query('SELECT pg_cancel_backend($1)', [p.pid]);
  const r = await build;
  assert.equal(r.status === 'ok', false);
  assert.match(r.message, /^BUILD_FAILED: .*invalid index was left/);
  await h.query('ROLLBACK');
  const left = await codes(x.admin);
  assert.ok(left.length > 0 && left.every(c => OWN.has(c.split(':')[0])), JSON.stringify(left));
  await assert.rejects(adoptMigration(mig, { version: 22 }), err('INDEX_NOT_READY'));
  await assert.rejects(buildIndexConcurrently(mig, { version: 22 }), err('INVALID_INDEX_PRESENT'));
  assert.equal(await version(x.admin), 21);
  const b = await buildIndexConcurrently(mig, { version: 22, replaceInvalid: true });
  assert.deepEqual([b.state, b.replacedInvalid], ['BUILT', true]);
  assert.deepEqual(await otherIndexes(x.admin), before, 'no other index was touched');
  assert.equal((await adoptMigration(mig, { version: 22 })).state, 'ADOPTED');
});

test('MIG-5: the build session is lost mid-build (backend terminated, as by a restart): recovery is the same', async t => {
  const x = await at(t);
  const mig = await x.conn('si_migrator');
  const h = await holdSnapshot(x.conn);
  const build = settle(buildIndexConcurrently(mig, { version: 22 }));
  const p = await buildWaiting(x.admin);
  await x.admin.query('SELECT pg_terminate_backend($1)', [p.pid]);
  assert.notEqual((await build).status, 'ok');
  await h.query('ROLLBACK');
  const left = await codes(x.admin);
  assert.ok(left.length > 0 && left.every(c => OWN.has(c.split(':')[0])), JSON.stringify(left));
  const mig2 = await x.conn('si_migrator');
  await assert.rejects(adoptMigration(mig2, { version: 22 }), err('INDEX_NOT_READY'));
  assert.equal((await buildIndexConcurrently(mig2, { version: 22, replaceInvalid: true })).state, 'BUILT');
  assert.equal((await adoptMigration(mig2, { version: 22 })).state, 'ADOPTED');
});

test('MIG-6: lock timeout: a conflicting lock makes the build fail fast and leave nothing; adopt times out without writing', async t => {
  const x = await at(t);
  const holder = await x.conn(undefined);
  await holder.query('BEGIN'); await holder.query('LOCK TABLE si.observations IN SHARE UPDATE EXCLUSIVE MODE');
  const t0 = performance.now();
  await assert.rejects(buildIndexConcurrently(x.admin, { version: 22, lockTimeoutMs: 300 }), e => /^BUILD_FAILED: .*lock timeout/.test(e.message));
  assert.ok(performance.now() - t0 < 5000);
  assert.deepEqual(await codes(x.admin), ['INDEX_MISSING:si.observations_by_ad_fk'], 'nothing left behind');
  await holder.query('ROLLBACK');
  assert.equal((await buildIndexConcurrently(x.admin, { version: 22 })).state, 'BUILT');
  await holder.query('BEGIN'); await holder.query('LOCK TABLE si.observations IN SHARE UPDATE EXCLUSIVE MODE');
  await assert.rejects(adoptMigration(x.admin, { version: 22, lockTimeoutMs: 300 }), e => e.code === '55P03');
  await holder.query('ROLLBACK');
  assert.equal(await version(x.admin), 21);
  assert.equal((await adoptMigration(x.admin, { version: 22 })).state, 'ADOPTED');
});

test('MIG-7: writers are not blocked while the concurrent build is in progress; the new rows are in the index', async t => {
  const x = await at(t);
  const h = await holdSnapshot(x.conn);
  const build = settle(buildIndexConcurrently(await x.conn('si_migrator'), { version: 22 }));
  await buildWaiting(x.admin);
  const w = await x.conn(undefined);
  const lat = [];
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    await w.query('BEGIN'); await w.query('SET LOCAL session_replication_role = replica'); await w.query(`SET LOCAL lock_timeout = '2s'`);
    await w.query(`INSERT INTO si.observations (run_id, source_id, rights_version_id, ordinal, ad_id, network, native_ad_id, advertiser_name,
                     countries, seen_at, source_url, content_sha256)
                   VALUES (gen_random_uuid(), 'mig-src', 1, 0, $1, 'META', $2, 'W', ARRAY['DE'], now(), 'https://example.test/a', repeat('a', 64))`, [900000 + i, `w-${i}`]);
    await w.query('COMMIT');
    lat.push(performance.now() - t0);
  }
  assert.ok((await x.admin.query(`SELECT count(*)::int AS n FROM pg_stat_progress_create_index`)).rows[0].n === 1, 'the build is still in progress');
  console.log(`# MIG-7 insert latency during the build: max ${Math.max(...lat).toFixed(1)} ms over ${lat.length}`);
  assert.ok(Math.max(...lat) < 1000, `writers not blocked: ${lat.map(v => v.toFixed(0)).join(',')}`);
  await h.query('ROLLBACK');
  assert.equal((await build).status, 'ok');
  await x.admin.query('BEGIN'); await x.admin.query('SET LOCAL enable_seqscan = off'); await x.admin.query('SET LOCAL enable_bitmapscan = off');
  const plan = (await x.admin.query(`EXPLAIN SELECT count(*) FROM si.observations WHERE ad_id = 900007 AND source_id = 'mig-src' AND network = 'META' AND native_ad_id = 'w-7'`)).rows.map(r => r['QUERY PLAN']).join(' ');
  const n = (await x.admin.query(`SELECT count(*)::int AS n FROM si.observations WHERE ad_id = 900007 AND source_id = 'mig-src' AND network = 'META' AND native_ad_id = 'w-7'`)).rows[0].n;
  await x.admin.query('ROLLBACK');
  assert.match(plan, /observations_by_ad_fk/);
  assert.equal(n, 1);
});

test('MIG-8: cleanup never drops what it did not build: a valid wrong index, an invalid wrong index and an invalid foreign artifact are refused and kept', async t => {
  const x = await at(t);
  await asOwner(x.admin, a => a.query('CREATE INDEX observations_by_ad_fk ON si.observations (source_id, ad_id, network, native_ad_id)'));
  const o1 = await oidOf(x.admin, 'si.observations_by_ad_fk');
  await assert.rejects(buildIndexConcurrently(x.admin, { version: 22, replaceInvalid: true }), err('INDEX_CONFLICT'));
  await assert.rejects(adoptMigration(x.admin, { version: 22 }), err('INDEX_NOT_READY'));
  assert.equal(await oidOf(x.admin, 'si.observations_by_ad_fk'), o1, 'the valid wrong index is kept');
  await x.admin.query(`UPDATE pg_catalog.pg_index SET indisvalid = false WHERE indexrelid = 'si.observations_by_ad_fk'::regclass`);   // CATALOG FLAGS
  await assert.rejects(buildIndexConcurrently(x.admin, { version: 22, replaceInvalid: true }), err('INDEX_CONFLICT'));
  assert.equal(await oidOf(x.admin, 'si.observations_by_ad_fk'), o1, 'an invalid index of another definition is kept');
  await asOwner(x.admin, async a => { await a.query('DROP INDEX si.observations_by_ad_fk'); await a.query('CREATE INDEX foreign_scratch ON si.observations (native_ad_id)'); });
  await x.admin.query(`UPDATE pg_catalog.pg_index SET indisvalid = false WHERE indexrelid = 'si.foreign_scratch'::regclass`);         // CATALOG FLAGS
  const o2 = await oidOf(x.admin, 'si.foreign_scratch');
  await assert.rejects(buildIndexConcurrently(x.admin, { version: 22, replaceInvalid: true }), err('INVALID_ARTIFACTS_PRESENT'));
  assert.equal(await oidOf(x.admin, 'si.foreign_scratch'), o2, 'a foreign artifact is kept');
  assert.deepEqual(await codes(x.admin), ['INDEX_MISSING:si.observations_by_ad_fk', 'INVALID_INDEX_ARTIFACT:foreign_scratch']);
  assert.equal(await version(x.admin), 21);
});

test('MIG-9: checksums fail closed: a modified 0022 file and a modified applied file are both refused; nothing is written', async t => {
  const x = await at(t);
  for (const file of ['0022_purge_fk_support_index.up.sql', '0005_evidence.up.sql']) {
    const dir = mkdtempSync(join(tmpdir(), 'si mig copy '));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    cpSync(DEFAULT_MIGRATIONS_DIR, dir, { recursive: true });
    appendFileSync(join(dir, file), '\n-- edited\n');
    await assert.rejects(buildIndexConcurrently(x.admin, { version: 22, dir }), err('CHECKSUM_MISMATCH'), file);
    await assert.rejects(adoptMigration(x.admin, { version: 22, dir }), err('CHECKSUM_MISMATCH'), file);
  }
  assert.deepEqual(await codes(x.admin), ['INDEX_MISSING:si.observations_by_ad_fk']);
  assert.equal(await version(x.admin), 21);
});

test('MIG-10: a migrator racing the concurrent build never records 0022 without a ready index; the procedure converges', async t => {
  const x = await at(t);
  const h = await holdSnapshot(x.conn);
  const b = await x.conn('si_migrator'), m = await x.conn('si_migrator');
  const build = settle(buildIndexConcurrently(b, { version: 22 }));
  await buildWaiting(x.admin);
  const up = settle(migrateUp(m, { to: 22 }));
  await sleep(300);
  await h.query('ROLLBACK');
  const [rb, ru] = [await build, await up];
  console.log(`# MIG-10 race: build ${rb.status === 'ok' ? rb.value.state : rb.message.slice(0, 60)}; up ${ru.status === 'ok' ? JSON.stringify(ru.value) : ru.message.slice(0, 60)}`);
  if (await version(x.admin) >= 22) assert.deepEqual(await codes(x.admin), [], 'version 22 is recorded only with a ready index');
  const fixer = await x.conn('si_migrator');
  const r2 = await buildIndexConcurrently(fixer, { version: 22, replaceInvalid: true });
  const r3 = await adoptMigration(fixer, { version: 22 });
  assert.ok(['BUILT', 'ALREADY_BUILT', 'ALREADY_APPLIED'].includes(r2.state) && ['ADOPTED', 'ALREADY_APPLIED'].includes(r3.state), JSON.stringify([r2, r3]));
  assert.equal(await version(x.admin), 22);
  assert.deepEqual(await codes(x.admin), []);
  const row = (await x.admin.query('SELECT up_sha256, down_sha256 FROM si.schema_migrations WHERE version = 22')).rows;
  assert.deepEqual(row, [{ up_sha256: M22.upSha256, down_sha256: M22.downSha256 }]);
});

test('MIG-11: adoption takes the migrator advisory lock: it waits for a running migrator and then proceeds', async t => {
  const x = await at(t);
  await buildIndexConcurrently(x.admin, { version: 22 });
  const other = await x.conn(undefined);
  await other.query(`SELECT pg_advisory_lock(x'${MIGRATION_LOCK_KEY}'::bigint)`);
  const mig = await x.conn('si_migrator');
  const pidM = (await mig.query('SELECT pg_backend_pid() AS p')).rows[0].p;
  const adopt = settle(adoptMigration(mig, { version: 22 }));
  for (let i = 0; ; i++) {
    const w = (await x.admin.query(`SELECT count(*)::int AS n FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND NOT granted`, [pidM])).rows[0].n;
    if (w === 1) break;
    assert.ok(i < 500, 'adopt waits on the migration lock'); await sleep(10);
  }
  assert.equal(await version(x.admin), 21);
  await other.query(`SELECT pg_advisory_unlock(x'${MIGRATION_LOCK_KEY}'::bigint)`);
  const r = await adopt;
  assert.equal(r.status, 'ok', JSON.stringify(r));
  assert.equal(r.value.state, 'ADOPTED');
});

test('MIG-12: rollback and re-adoption: down to 21 drops the index and the record; the evidence is append-only and keeps both adoptions', async t => {
  const x = await at(t);
  await buildIndexConcurrently(x.admin, { version: 22 });
  await adoptMigration(x.admin, { version: 22 });
  assert.deepEqual(await migrateDown(x.admin, { to: 21, allowDestructive: true }), [22]);
  assert.deepEqual(await codes(x.admin), ['INDEX_MISSING:si.observations_by_ad_fk']);
  assert.equal(await version(x.admin), 21);
  for (const sql of ['UPDATE si.schema_adoptions SET readiness = readiness', 'DELETE FROM si.schema_adoptions', 'TRUNCATE si.schema_adoptions']) {
    await assert.rejects(asOwner(x.admin, a => a.query(sql)), /SI_APPEND_ONLY/, sql);
  }
  await buildIndexConcurrently(x.admin, { version: 22 });
  assert.equal((await adoptMigration(x.admin, { version: 22 })).state, 'ADOPTED');
  assert.equal((await x.admin.query('SELECT count(*)::int AS n FROM si.schema_adoptions')).rows[0].n, 2);
});

test('MIG-13: privileges: si_monitor reads the evidence but cannot build or adopt; application roles cannot read it', async t => {
  const x = await at(t);
  await buildIndexConcurrently(x.admin, { version: 22 });
  const mon = await x.conn('si_monitor');
  await assert.rejects(adoptMigration(mon, { version: 22 }), e => e.code === '42501');
  assert.equal((await mon.query('SELECT 1 AS ok')).rows[0].ok, 1, 'the refused adoption left no open transaction');
  await adoptMigration(x.admin, { version: 22 });
  assert.equal((await mon.query('SELECT count(*)::int AS n FROM si.schema_adoptions')).rows[0].n, 1);
  const col = await x.conn('si_collector');
  await assert.rejects(col.query('SELECT 1 FROM si.schema_adoptions'), e => e.code === '42501');
  const y = await at(t);
  await assert.rejects(buildIndexConcurrently(await y.conn('si_monitor'), { version: 22 }), e => e.code === '42501');
  assert.deepEqual(await codes(y.admin), ['INDEX_MISSING:si.observations_by_ad_fk']);
});

test('MIG-14: the build refuses to run inside a transaction and leaves nothing', async t => {
  const x = await at(t);
  await x.admin.query('BEGIN');
  await assert.rejects(buildIndexConcurrently(x.admin, { version: 22 }), e => /^BUILD_FAILED: .*transaction block/.test(e.message));
  await x.admin.query('ROLLBACK');
  assert.deepEqual(await codes(x.admin), ['INDEX_MISSING:si.observations_by_ad_fk']);
});

test('MIG-15: the CLI drives the procedure as si_migrator (build-index, adopt, readiness, up)', async t => {
  const x = await at(t);
  const cli = fileURLToPath(new URL('../../dist/persistence/cli.js', import.meta.url));
  const env = { ...process.env, SI_DATABASE_URL: `postgres://si_migrator:${encodeURIComponent(cfg.rolePassword)}@${cfg.host}:${cfg.port}/${x.db}` };
  delete env.SI_PRODUCTION;
  const run = (...a) => spawnSync(process.execPath, [cli, ...a], { encoding: 'utf8', env });
  let r = run('readiness'); assert.equal(r.status, 1, r.stdout + r.stderr);
  r = run('adopt', '--version', '22'); assert.equal(r.status, 1, r.stdout + r.stderr); assert.match(r.stderr, /INDEX_NOT_READY/);
  r = run('build-index', '--version', '22', '--lock-timeout-ms', '5000'); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /"state":"BUILT"/);
  r = run('adopt', '--version', '22'); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /"state":"ADOPTED"/);
  r = run('readiness'); assert.equal(r.status, 0, r.stdout + r.stderr);
  r = run('up'); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /applied: 23/);
});

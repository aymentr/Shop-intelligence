// Migration runner and bootstrap: design tests M1–M5 plus runner edge cases.
// Every test runs against a real PostgreSQL database created for it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertSchemaVersion, codeSchemaVersion, DEFAULT_MIGRATIONS_DIR, loadMigrations, MIGRATION_LOCK_KEY,
  migrateDown, migrateUp, migrationStatus
} from '../../dist/persistence/migrate.js';
import { bootstrapCluster, bootstrapDatabase, LOGIN_ROLES } from '../../dist/persistence/bootstrap.js';
import { cfg, connect, freshDatabase, pid, rejects, roles, schemaFingerprint, waitUntilBlocked } from './helpers.mjs';

function tempMigrations(t, files) {
  const dir = mkdtempSync(join(tmpdir(), 'si migrations '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
}
const SIMPLE = {
  '0001_alpha.up.sql': 'CREATE TABLE si.m_alpha (x int);',
  '0001_alpha.down.sql': 'DROP TABLE si.m_alpha;',
  '0002_beta.up.sql': 'CREATE TABLE si.m_beta (x int);',
  '0002_beta.down.sql': 'DROP TABLE si.m_beta;'
};
const appliedVersions = async c => (await c.query('SELECT version FROM si.schema_migrations ORDER BY 1')).rows.map(r => r.version);
const relExists = async (c, rel) => (await c.query('SELECT pg_catalog.to_regclass($1) IS NOT NULL AS e', [rel])).rows[0].e;

test('M1: up -> down -> up yields an identical schema (catalog fingerprint incl. owners and ACLs)', async t => {
  const db = await freshDatabase(t, 'm1', { migrate: false });
  const { admin } = await roles(t, db, ['admin']);
  assert.deepEqual(await migrateUp(admin), [1]);
  const afterUp = await schemaFingerprint(admin);
  assert.deepEqual(await migrateDown(admin, { to: 0, allowDestructive: true }), [1]);
  const afterDown = await schemaFingerprint(admin);
  assert.notEqual(afterDown, afterUp);
  const left = (await admin.query(`SELECT relname FROM pg_class WHERE relnamespace = 'si'::regnamespace AND relkind = 'r'`)).rows;
  assert.deepEqual(left.map(r => r.relname), ['schema_migrations'], 'down 0001 leaves only the runner table');
  assert.equal((await admin.query(`SELECT count(*)::int AS n FROM pg_proc WHERE pronamespace = 'si'::regnamespace`)).rows[0].n, 0);
  assert.deepEqual(await migrateUp(admin), [1]);
  assert.equal(await schemaFingerprint(admin), afterUp);
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM si.rights_versions')).rows[0].n, 1, 'seed re-applied');
});

test('M2: an edited applied migration (up or down file) is refused by checksum', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'si migrations copy '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(DEFAULT_MIGRATIONS_DIR, dir, { recursive: true });
  const db = await freshDatabase(t, 'm2', { migrate: false });
  const { admin } = await roles(t, db, ['admin']);
  await migrateUp(admin, { dir });
  appendFileSync(join(dir, '0001_sources_rights.up.sql'), '\n-- edited after being applied\n');
  await rejects(assert, migrateUp(admin, { dir }), { message: /^CHECKSUM_MISMATCH/ });
  await rejects(assert, migrateDown(admin, { dir, to: 0, allowDestructive: true }), { message: /^CHECKSUM_MISMATCH/ });
  assert.match((await migrationStatus(admin, dir)).problem, /CHECKSUM_MISMATCH/);
  cpSync(DEFAULT_MIGRATIONS_DIR, dir, { recursive: true });       // restore up, now edit down
  appendFileSync(join(dir, '0001_sources_rights.down.sql'), '\n-- edited\n');
  await rejects(assert, migrateUp(admin, { dir }), { message: /^CHECKSUM_MISMATCH/ });
  assert.deepEqual(await appliedVersions(admin), [1], 'nothing changed');
});

test('M3: concurrent runners serialize on the advisory lock; exactly one applies', async t => {
  const dir = tempMigrations(t, {
    '0001_slow.up.sql': 'CREATE TABLE si.m_slow (x int); SELECT pg_catalog.pg_sleep(1.5);',
    '0001_slow.down.sql': 'DROP TABLE si.m_slow;'
  });
  const db = await freshDatabase(t, 'm3', { migrate: false });
  const { admin: observer } = await roles(t, db, ['admin']);
  const c1 = await connect({ database: db }), c2 = await connect({ database: db });
  t.after(async () => { await c1.end(); await c2.end(); });
  const [p1, p2] = [await pid(c1), await pid(c2)];
  assert.notEqual(p1, p2, 'distinct backends');
  const run1 = migrateUp(c1, { dir });
  // Wait until runner 1 holds the migration lock, then start runner 2 and prove it waits.
  for (let i = 0; i < 200; i++) {
    const held = await observer.query(
      `SELECT count(*)::int AS n FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND granted
         AND ((classid::bigint << 32) | objid::bigint) = x'${MIGRATION_LOCK_KEY}'::bigint`, [p1]);
    if (held.rows[0].n > 0) break;
    await new Promise(r => setTimeout(r, 10));
  }
  const run2 = migrateUp(c2, { dir });
  await waitUntilBlocked(observer, p2, p1);
  const [r1, r2] = await Promise.all([run1, run2]);
  assert.deepEqual([r1, r2], [[1], []]);
  assert.deepEqual(await appliedVersions(observer), [1]);
});

test('M4: down is refused without the destructive flag, and with non-synthetic data', async t => {
  const db = await freshDatabase(t, 'm4', { migrate: false });
  const { admin } = await roles(t, db, ['admin']);
  await migrateUp(admin);
  await rejects(assert, migrateDown(admin, { to: 0, allowDestructive: false }), { message: /^DESTRUCTIVE_NOT_ALLOWED/ });
  await rejects(assert, migrateDown(admin, { to: 0 }), { message: /^DESTRUCTIVE_NOT_ALLOWED/ });
  assert.deepEqual(await appliedVersions(admin), [1]);

  // Non-synthetic guard: a throwaway schema without the 0001 CHECK lets us plant a non-synthetic row.
  const dir = tempMigrations(t, {
    '0001_fake_sources.up.sql': `CREATE TABLE si.sources (source_id text, evidence_kind text);
                                 INSERT INTO si.sources VALUES ('fake', 'LICENSED');`,
    '0001_fake_sources.down.sql': 'DROP TABLE si.sources;'
  });
  const db2 = await freshDatabase(t, 'm4b', { migrate: false });
  const c = await connect({ database: db2 });
  t.after(() => c.end());
  await migrateUp(c, { dir });
  await rejects(assert, migrateDown(c, { dir, to: 0, allowDestructive: true }), { message: /^NON_SYNTHETIC_DATA/ });
  assert.ok(await relExists(c, 'si.sources'), 'rollback did not run');
});

test('M5: bootstrap is idempotent (roles, settings, database and schema ACLs)', async t => {
  const db = await freshDatabase(t, 'm5', { migrate: false });
  const { admin } = await roles(t, db, ['admin']);
  const snapshot = async () => JSON.stringify({
    roles: (await admin.query(`SELECT rolname, rolcanlogin, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
                                      rolreplication, rolbypassrls, rolconfig FROM pg_roles WHERE rolname LIKE 'si\\_%'
                                      AND rolname NOT LIKE 'si\\_t\\_%' ORDER BY 1`)).rows,
    database: (await admin.query('SELECT datacl::text FROM pg_database WHERE datname = current_database()')).rows,
    publicSchema: (await admin.query(`SELECT nspacl::text FROM pg_namespace WHERE nspname = 'public'`)).rows,
    schema: await schemaFingerprint(admin)
  });
  const pw = Object.fromEntries(LOGIN_ROLES.map(r => [r, cfg.rolePassword]));
  const before = await snapshot();
  await bootstrapCluster(admin, { passwords: pw }); await bootstrapDatabase(admin);
  await bootstrapCluster(admin, { passwords: pw }); await bootstrapDatabase(admin);
  assert.equal(await snapshot(), before);
  const c = await connect({ user: 'si_monitor', database: db });     // passwords still work
  await c.end();
});

test('runner: a failing migration leaves no partial schema and no version row', async t => {
  const dir = tempMigrations(t, {
    ...SIMPLE,
    '0002_beta.up.sql': 'CREATE TABLE si.m_half (x int); SELECT 1/0;',
    '0002_beta.down.sql': 'DROP TABLE si.m_half;'
  });
  const db = await freshDatabase(t, 'atomic', { migrate: false });
  const { admin } = await roles(t, db, ['admin']);
  await rejects(assert, migrateUp(admin, { dir }), { code: '22012' });
  assert.deepEqual(await appliedVersions(admin), [1]);
  assert.equal(await relExists(admin, 'si.m_alpha'), true);
  assert.equal(await relExists(admin, 'si.m_half'), false, 'the failed migration rolled back completely');
  assert.deepEqual((await migrationStatus(admin, dir)).pending, [2]);
});

test('runner: unqualified object names are refused (search_path = pg_catalog, pg_temp)', async t => {
  const dir = tempMigrations(t, {
    '0001_unqualified.up.sql': 'CREATE TABLE unqualified_t (x int);',
    '0001_unqualified.down.sql': 'DROP TABLE si.unqualified_t;'
  });
  const db = await freshDatabase(t, 'unqual', { migrate: false });
  const { admin } = await roles(t, db, ['admin']);
  const err = await rejects(assert, migrateUp(admin, { dir }));
  assert.ok(['42501', '3F000'].includes(err.code), `unexpected SQLSTATE ${err.code}: ${err.message}`);
  // The whole transaction rolled back, including the history table it created.
  const s = await migrationStatus(admin, dir);
  assert.deepEqual(s.applied, []);
  assert.deepEqual(s.pending, [1]);
  assert.equal(await relExists(admin, 'si.unqualified_t'), false);
  assert.equal(await relExists(admin, 'public.unqualified_t'), false);
});

test('runner: applied versions missing locally, out-of-order sets and partial targets', async t => {
  const db = await freshDatabase(t, 'order', { migrate: false });
  const { admin } = await roles(t, db, ['admin']);
  const full = tempMigrations(t, SIMPLE);
  assert.deepEqual(await migrateUp(admin, { dir: full, to: 1 }), [1]);
  assert.deepEqual(await migrateUp(admin, { dir: full }), [2]);
  const onlyFirst = tempMigrations(t, { '0001_alpha.up.sql': SIMPLE['0001_alpha.up.sql'], '0001_alpha.down.sql': SIMPLE['0001_alpha.down.sql'] });
  await rejects(assert, migrateUp(admin, { dir: onlyFirst }), { message: /^UNKNOWN_APPLIED_VERSION/ });
  await admin.query('DELETE FROM si.schema_migrations WHERE version = 1');     // simulate a corrupted history
  await rejects(assert, migrateUp(admin, { dir: full }), { message: /^OUT_OF_ORDER/ });
});

test('runner: invalid migration sets are rejected before touching the database', t => {
  const gap = tempMigrations(t, { ...SIMPLE, '0003_gamma.up.sql': 'SELECT 1;', '0003_gamma.down.sql': 'SELECT 1;' });
  rmSync(join(gap, '0002_beta.up.sql')); rmSync(join(gap, '0002_beta.down.sql'));
  assert.throws(() => loadMigrations(gap), /^MigrationError: INVALID_MIGRATION_SET|INVALID_MIGRATION_SET/);
  const noDown = tempMigrations(t, { '0001_alpha.up.sql': 'SELECT 1;' });
  assert.throws(() => loadMigrations(noDown), /INVALID_MIGRATION_SET/);
  const badName = tempMigrations(t, { '1_alpha.up.sql': 'SELECT 1;' });
  assert.throws(() => loadMigrations(badName), /INVALID_MIGRATION_SET/);
  const twoNames = tempMigrations(t, { '0001_a.up.sql': 'SELECT 1;', '0001_b.down.sql': 'SELECT 1;' });
  assert.throws(() => loadMigrations(twoNames), /INVALID_MIGRATION_SET/);
});

test('runner: history records exact checksums, applying login, and objects owned by si_owner', async t => {
  const db = await freshDatabase(t, 'history');
  const { admin } = await roles(t, db, ['admin']);
  const row = (await admin.query('SELECT * FROM si.schema_migrations')).rows[0];
  const sha = f => createHash('sha256').update(readFileSync(join(DEFAULT_MIGRATIONS_DIR, f))).digest('hex');
  assert.equal(row.version, 1);
  assert.equal(row.name, 'sources_rights');
  assert.equal(row.up_sha256, sha('0001_sources_rights.up.sql'));
  assert.equal(row.down_sha256, sha('0001_sources_rights.down.sql'));
  assert.equal(row.applied_by, cfg.adminUser);
  const owners = (await admin.query(`
    SELECT DISTINCT pg_get_userbyid(relowner) AS o FROM pg_class WHERE relnamespace = 'si'::regnamespace
    UNION SELECT DISTINCT pg_get_userbyid(proowner) FROM pg_proc WHERE pronamespace = 'si'::regnamespace`)).rows;
  assert.deepEqual(owners.map(r => r.o), ['si_owner']);
});

test('assertSchemaVersion: the application refuses a database at the wrong version', async t => {
  const db = await freshDatabase(t, 'version');
  const { si_collector } = await roles(t, db, ['si_collector']);
  assert.equal(codeSchemaVersion(), 1);
  await assertSchemaVersion(si_collector);                            // as an application role
  await rejects(assert, assertSchemaVersion(si_collector, 2), { message: /^SCHEMA_VERSION_MISMATCH: database is at version 1/ });
  const empty = await freshDatabase(t, 'version0', { migrate: false });
  const c = await connect({ database: empty });
  t.after(() => c.end());
  await rejects(assert, assertSchemaVersion(c), { message: /database is at version 0, code expects 1/ });
});

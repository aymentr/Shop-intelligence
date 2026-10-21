// D5b audit (M2 step 2): the dedicated non-superuser migrator, and a dry run of the optional
// advisory-lock hardening in throwaway databases. The hardening is NOT part of bootstrap.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bootstrapCluster, bootstrapDatabase } from '../../dist/persistence/bootstrap.js';
import { migrateDown, migrateUp, migrationStatus, MIGRATION_LOCK_KEY } from '../../dist/persistence/migrate.js';
import { assertSafeTarget, cfg, connect, dropDatabase, freshDatabase, rejects, schemaFingerprint, uniqueDbName } from './helpers.mjs';

const DENIED = '42501';
const HARDENING = readFileSync(fileURLToPath(new URL('../../db/bootstrap/optional/advisory-lock-hardening.sql', import.meta.url)), 'utf8');
const ADVISORY_CALLS = [
  'pg_advisory_lock(1)', 'pg_advisory_lock(1, 2)', 'pg_advisory_lock_shared(1)', 'pg_advisory_lock_shared(1, 2)',
  'pg_try_advisory_lock(1)', 'pg_try_advisory_lock(1, 2)', 'pg_try_advisory_lock_shared(1)', 'pg_try_advisory_lock_shared(1, 2)',
  'pg_advisory_unlock(1)', 'pg_advisory_unlock(1, 2)', 'pg_advisory_unlock_shared(1)', 'pg_advisory_unlock_shared(1, 2)',
  'pg_advisory_unlock_all()', 'pg_advisory_xact_lock(1)', 'pg_advisory_xact_lock(1, 2)', 'pg_advisory_xact_lock_shared(1)',
  'pg_advisory_xact_lock_shared(1, 2)', 'pg_try_advisory_xact_lock(1)', 'pg_try_advisory_xact_lock(1, 2)',
  'pg_try_advisory_xact_lock_shared(1)', 'pg_try_advisory_xact_lock_shared(1, 2)'
];
const publicAdvisory = async c => (await c.query(`
  SELECT count(*)::int AS n FROM pg_proc p
  WHERE p.pronamespace = 'pg_catalog'::regnamespace AND p.proname ~ '^pg_(try_)?advisory'
    AND EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')`)).rows[0].n;

test('MG0 (audit): exactly 21 advisory-lock functions exist and all are PUBLIC-executable by default', async t => {
  const db = await freshDatabase(t, 'mg0');
  const c = await connect({ database: db });
  t.after(() => c.end());
  const r = (await c.query(`SELECT count(*)::int AS n FROM pg_proc WHERE pronamespace = 'pg_catalog'::regnamespace AND proname ~ '^pg_(try_)?advisory'`)).rows[0];
  assert.equal(r.n, ADVISORY_CALLS.length);
  assert.equal(await publicAdvisory(c), 21);
});

test('MG1: si_migrator is a plain login that can only SET ROLE si_owner (no inherit, no admin, no other memberships)', async t => {
  const db = await freshDatabase(t, 'mg1');
  const c = await connect({ database: db });
  t.after(() => c.end());
  const r = (await c.query(`SELECT rolcanlogin, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls, rolconfig
                            FROM pg_roles WHERE rolname = 'si_migrator'`)).rows[0];
  assert.deepEqual(r, { rolcanlogin: true, rolsuper: false, rolinherit: false, rolcreaterole: false, rolcreatedb: false,
                        rolreplication: false, rolbypassrls: false, rolconfig: ['lock_timeout=30s'] });
  const m = (await c.query(`SELECT pg_get_userbyid(roleid)::text AS role, admin_option, inherit_option, set_option
                            FROM pg_auth_members WHERE member = 'si_migrator'::regrole`)).rows;
  assert.deepEqual(m, [{ role: 'si_owner', admin_option: false, inherit_option: false, set_option: true }]);
  const owners = (await c.query(`SELECT array_agg(pg_get_userbyid(member)::text) AS m FROM pg_auth_members WHERE roleid = 'si_owner'::regrole`)).rows[0].m;
  assert.deepEqual(owners, ['si_migrator'], 'no application role is a member of si_owner');
});

test('MG1b: bootstrap removes any stray membership in si_owner (an application role must never be able to SET ROLE si_owner)', async t => {
  const db = await freshDatabase(t, 'mg1b');
  const adm = await connect({ database: db });
  t.after(() => adm.end());
  t.after(async () => {                    // never leave cluster-wide role state dirty, even on failure
    const c = await connect({ database: 'postgres' });   // roles.sql is cluster-wide; the test database may be gone
    try { await c.query(readFileSync(new URL('../../db/bootstrap/roles.sql', import.meta.url), 'utf8')); } finally { await c.end(); }
  });
  await adm.query('GRANT si_owner TO si_collector WITH SET TRUE');                    // stray, by the administrator
  await adm.query('GRANT si_owner TO si_retention WITH ADMIN TRUE, SET TRUE');        // stray with ADMIN ...
  await adm.query('SET ROLE si_retention');
  await adm.query('GRANT si_owner TO si_monitor WITH SET TRUE');                      // ... and a dependent grant by another grantor
  await adm.query('RESET ROLE');
  const members = async () => (await adm.query(`SELECT array_agg(pg_get_userbyid(member)::text ORDER BY pg_get_userbyid(member)::text) AS m
                                               FROM pg_auth_members WHERE roleid = 'si_owner'::regrole`)).rows[0].m;
  assert.deepEqual(await members(), ['si_collector', 'si_migrator', 'si_monitor', 'si_retention']);
  await bootstrapCluster(adm);
  assert.deepEqual(await members(), ['si_migrator']);
  const col = await connect({ user: 'si_collector', database: db });
  t.after(() => col.end());
  await rejects(assert, col.query('SET ROLE si_owner'), { code: DENIED });
});

test('MG2: the migrator applies, reports and rolls back migrations; the result equals an administrator-migrated schema', async t => {
  const db = await freshDatabase(t, 'mg2', { migrate: false });
  const ref = await freshDatabase(t, 'mg2ref', { migrate: true, fromTemplate: false });
  const mig = await connect({ user: 'si_migrator', database: db });
  const admRef = await connect({ database: ref });
  t.after(async () => { await mig.end(); await admRef.end(); });
  assert.deepEqual(await migrateUp(mig), [1, 2]);
  assert.deepEqual((await migrationStatus(mig)).applied.map(a => [a.version, a.appliedBy]), [[1, 'si_migrator'], [2, 'si_migrator']]);
  const adm = await connect({ database: db });
  t.after(() => adm.end());
  assert.equal(await schemaFingerprint(adm), await schemaFingerprint(admRef), 'identical catalog (owners, ACLs, functions)');
  assert.deepEqual(await migrateDown(mig, { to: 1, allowDestructive: true }), [2]);
  assert.deepEqual(await migrateDown(mig, { to: 0, allowDestructive: true }), [1]);
  assert.deepEqual(await migrateUp(mig), [1, 2]);
  assert.equal(await schemaFingerprint(adm), await schemaFingerprint(admRef));
});

test('MG3: the migrator cannot bootstrap, create roles or grant ownership onward; bootstrap stays an administrator task', async t => {
  const db = await freshDatabase(t, 'mg3');
  const mig = await connect({ user: 'si_migrator', database: db });
  const adm = await connect({ database: db });
  t.after(async () => { await mig.end(); await adm.end(); });
  const aclBefore = (await adm.query('SELECT datacl::text FROM pg_database WHERE datname = current_database()')).rows[0].datacl;
  await rejects(assert, bootstrapCluster(mig), { code: DENIED });
  await rejects(assert, bootstrapDatabase(mig), { code: DENIED });
  assert.equal((await adm.query('SELECT datacl::text FROM pg_database WHERE datname = current_database()')).rows[0].datacl, aclBefore,
    'database ACL unchanged (non-owner GRANT/REVOKE on the database only warned)');
  await rejects(assert, mig.query('CREATE ROLE si_t_mg3 LOGIN'), { code: DENIED });
  await rejects(assert, mig.query('GRANT si_owner TO si_collector'), { code: DENIED });
  await rejects(assert, mig.query('ALTER ROLE si_collector SUPERUSER'), { code: DENIED });
});

test('MG4: outside SET ROLE the migrator has no data access and cannot use the application paths', async t => {
  const db = await freshDatabase(t, 'mg4');
  const mig = await connect({ user: 'si_migrator', database: db });
  t.after(() => mig.end());
  for (const sql of ['SELECT * FROM si.sources', 'SELECT * FROM si.collection_runs', 'SELECT * FROM si.source_controls',
                     `SELECT * FROM si.si_begin_run('synthetic-fixture', 'k', '${'a'.repeat(64)}', 'SYNTHETIC', '{META}')`,
                     `SELECT * FROM si.si_record_source_control('synthetic-fixture', 'SUSPEND', 'x', NULL, NULL, NULL, NULL, NULL)`]) {
    await rejects(assert, mig.query(sql), { code: DENIED });
  }
  assert.ok((await mig.query('SELECT count(*) FROM si.schema_migrations')).rows[0], 'history is readable (status)');
  await mig.query('BEGIN'); await mig.query('SET LOCAL ROLE si_owner');                     // the intended, explicit escalation
  assert.equal((await mig.query('SELECT current_user AS u')).rows[0].u, 'si_owner');
  await mig.query('ROLLBACK');
  const col = await connect({ user: 'si_collector', database: db });
  t.after(() => col.end());
  await rejects(assert, col.query('SET ROLE si_owner'), { code: DENIED });
});

test('MG5: the migrator takes the migration lock (bigint form) as itself, before SET ROLE', async t => {
  const db = await freshDatabase(t, 'mg5');
  const mig = await connect({ user: 'si_migrator', database: db });
  const obs = await connect({ database: db });
  t.after(async () => { await mig.end(); await obs.end(); });
  await mig.query('BEGIN');
  await mig.query(`SELECT pg_catalog.pg_advisory_xact_lock(x'${MIGRATION_LOCK_KEY}'::bigint)`);
  const pidM = (await mig.query('SELECT pg_backend_pid() AS p')).rows[0].p;
  const l = (await obs.query(`SELECT objsubid, granted FROM pg_locks WHERE pid = $1 AND locktype = 'advisory'`, [pidM])).rows;
  await mig.query('ROLLBACK');
  assert.deepEqual(l, [{ objsubid: 1, granted: true }]);
});

test('MG6 (D5b dry run): hardening applied by the pg_catalog owner keeps migrations and T1 working and denies everyone else', async t => {
  const db = await freshDatabase(t, 'mg6');
  const adm = await connect({ database: db });
  t.after(() => adm.end());
  await adm.query(HARDENING);
  assert.equal(await publicAdvisory(adm), 0, 'no advisory function is PUBLIC-executable');
  const mig = await connect({ user: 'si_migrator', database: db });
  const col = await connect({ user: 'si_collector', database: db });
  const others = await Promise.all(['si_rights_admin', 'si_retention', 'si_monitor'].map(u => connect({ user: u, database: db })));
  t.after(async () => { for (const x of [mig, col, ...others]) await x.end(); });
  assert.deepEqual(await migrateDown(mig, { to: 1, allowDestructive: true }), [2]);
  assert.deepEqual(await migrateUp(mig), [2], 'the migrator still migrates');
  const r = (await col.query(`SELECT * FROM si.si_begin_run('synthetic-fixture', 'mg6', '${'a'.repeat(64)}', 'SYNTHETIC', '{META}')`)).rows[0];
  assert.equal(r.outcome, 'RUNNING', 'T1 still takes its request-key lock (inside the definer, as si_owner)');
  for (const x of [col, ...others]) {
    for (const call of ADVISORY_CALLS) await rejects(assert, x.query(`SELECT pg_catalog.${call}`), { code: DENIED });
  }
  for (const call of ADVISORY_CALLS.filter(f => f !== 'pg_advisory_xact_lock(1)')) {
    await rejects(assert, mig.query(`SELECT pg_catalog.${call}`), { code: DENIED });
  }
});

test('MG7 (D5b compatibility): a non-owner administrator cannot apply the hardening — PostgreSQL only warns, the script fails loudly', async t => {
  const db = await freshDatabase(t, 'mg7');
  const adm = await connect({ database: db });
  const role = `si_t_fakeadmin_${Math.random().toString(16).slice(2, 8)}`;
  t.after(async () => {
    await adm.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
    await adm.end();
  });
  await adm.query(`CREATE ROLE ${role} NOLOGIN CREATEROLE`);              // like a managed host's admin: not the pg_catalog owner
  await adm.query('BEGIN');
  await adm.query(`SET LOCAL ROLE ${role}`);
  await rejects(assert, adm.query(HARDENING), { message: /^SI_HARDENING_INCOMPLETE/ });
  await adm.query('ROLLBACK');
  assert.equal(await publicAdvisory(adm), 21, 'nothing changed');
});

test('MG8 (D5b compatibility): hardening is per database — clones keep it, template0 databases do not; pg_dump records it', async t => {
  const hardened = await freshDatabase(t, 'mg8');
  const adm = await connect({ database: hardened });
  await adm.query(HARDENING);
  await adm.end();
  const admin = await connect();
  const clone = uniqueDbName('mg8clone'), fresh0 = uniqueDbName('mg8t0');
  assertSafeTarget(clone); assertSafeTarget(fresh0);
  t.after(async () => { await dropDatabase(clone); await dropDatabase(fresh0); });
  await admin.query(`CREATE DATABASE ${clone} TEMPLATE ${hardened}`);
  await admin.query(`CREATE DATABASE ${fresh0} TEMPLATE template0`);
  await admin.end();
  for (const [name, expected] of [[clone, 0], [fresh0, 21]]) {
    const x = await connect({ database: name });
    assert.equal(await publicAdvisory(x), expected, name);
    await x.end();
  }
  const dump = spawnSync('pg_dump', ['--schema-only', '-h', cfg.host, '-p', String(cfg.port), '-U', cfg.adminUser, hardened],
    { encoding: 'utf8', env: { ...process.env, PGPASSWORD: cfg.adminPassword } });
  if (dump.error || dump.status !== 0) { t.diagnostic(`pg_dump unavailable or incompatible: ${dump.error?.message ?? dump.stderr}`); return; }
  assert.match(dump.stdout, /REVOKE ALL ON FUNCTION pg_catalog\.pg_advisory_lock\(bigint\) FROM PUBLIC/);
  assert.match(dump.stdout, /GRANT ALL ON FUNCTION pg_catalog\.pg_advisory_xact_lock\(bigint\) TO si_migrator/);
});

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
  assert.deepEqual(await migrateUp(admin), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
  const afterUp = await schemaFingerprint(admin);
  assert.deepEqual(await migrateDown(admin, { to: 0, allowDestructive: true }), [17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  const afterDown = await schemaFingerprint(admin);
  assert.notEqual(afterDown, afterUp);
  const left = (await admin.query(`SELECT relname FROM pg_class WHERE relnamespace = 'si'::regnamespace AND relkind = 'r'`)).rows;
  assert.deepEqual(left.map(r => r.relname), ['schema_migrations'], 'down 0012 to 0001 leaves only the runner table');
  assert.equal((await admin.query(`SELECT count(*)::int AS n FROM pg_proc WHERE pronamespace = 'si'::regnamespace`)).rows[0].n, 0);
  assert.deepEqual(await migrateUp(admin), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.equal(await schemaFingerprint(admin), afterUp);
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM si.rights_versions')).rows[0].n, 1, 'seed re-applied');
});

test('M1b: up 0002 -> down 0002 leaves the 0001 schema identical; 0002 re-applies identically', async t => {
  const db = await freshDatabase(t, 'm1b', { migrate: false });
  const { admin } = await roles(t, db, ['admin']);
  assert.deepEqual(await migrateUp(admin, { to: 1 }), [1]);
  const only0001 = await schemaFingerprint(admin);
  assert.deepEqual(await migrateUp(admin, { to: 2 }), [2]);
  const with0002 = await schemaFingerprint(admin);
  assert.notEqual(with0002, only0001);
  assert.deepEqual(await migrateDown(admin, { to: 1, allowDestructive: true }), [2]);
  assert.equal(await schemaFingerprint(admin), only0001, 'down 0002 restores the exact 0001 catalog');
  assert.deepEqual(await migrateUp(admin, { to: 2 }), [2]);
  assert.equal(await schemaFingerprint(admin), with0002);
});

test('M1c: up 0003 -> down 0003 leaves the 0002 schema identical; 0003 re-applies identically', async t => {
  const db = await freshDatabase(t, 'm1c', { migrate: false });
  const { admin } = await roles(t, db, ['admin']);
  assert.deepEqual(await migrateUp(admin, { to: 2 }), [1, 2]);
  const only0002 = await schemaFingerprint(admin);
  assert.deepEqual(await migrateUp(admin, { to: 3 }), [3]);
  const with0003 = await schemaFingerprint(admin);
  assert.notEqual(with0003, only0002);
  assert.deepEqual(await migrateDown(admin, { to: 2, allowDestructive: true }), [3]);
  assert.equal(await schemaFingerprint(admin), only0002, 'down 0003 restores the exact 0002 catalog');
  assert.deepEqual(await migrateUp(admin, { to: 3 }), [3]);
  assert.equal(await schemaFingerprint(admin), with0003);
});

test('M1d: up 0004 -> down 0004 restores the exact 0003 catalog (counts-based T2 byte for byte); 0004 re-applies identically', async t => {
  const db = await freshDatabase(t, 'm1d', { migrate: false });
  const { admin } = await roles(t, db, ['admin']);
  assert.deepEqual(await migrateUp(admin, { to: 3 }), [1, 2, 3]);
  const only0003 = await schemaFingerprint(admin);
  assert.deepEqual(await migrateUp(admin, { to: 4 }), [4]);
  const with0004 = await schemaFingerprint(admin);
  assert.notEqual(with0004, only0003);
  assert.deepEqual(await migrateDown(admin, { to: 3, allowDestructive: true }), [4]);
  assert.equal(await schemaFingerprint(admin), only0003, 'down 0004 restores the exact 0003 catalog');
  assert.deepEqual(await migrateUp(admin, { to: 4 }), [4]);
  assert.equal(await schemaFingerprint(admin), with0004);
});

test('M1e: up 0005 -> down 0005 restores the exact 0004 catalog (T2 and publication check byte for byte); 0005 re-applies identically', async t => {
  const db = await freshDatabase(t, 'm1e', { migrate: false });
  const { admin } = await roles(t, db, ['admin']);
  assert.deepEqual(await migrateUp(admin, { to: 4 }), [1, 2, 3, 4]);
  const only0004 = await schemaFingerprint(admin);
  assert.deepEqual(await migrateUp(admin, { to: 5 }), [5]);
  const with0005 = await schemaFingerprint(admin);
  assert.notEqual(with0005, only0004);
  assert.deepEqual(await migrateDown(admin, { to: 4, allowDestructive: true }), [5]);
  assert.equal(await schemaFingerprint(admin), only0004, 'down 0005 restores the exact 0004 catalog');
  assert.deepEqual(await migrateUp(admin, { to: 5 }), [5]);
  assert.equal(await schemaFingerprint(admin), with0005);
});

test('M1f: up 0006 -> down 0006 restores the exact 0005 catalog (evidence guard byte for byte); 0006 re-applies identically', async t => {
  const db = await freshDatabase(t, 'm1f', { migrate: false });
  const { admin } = await roles(t, db, ['admin']);
  assert.deepEqual(await migrateUp(admin, { to: 5 }), [1, 2, 3, 4, 5]);
  const only0005 = await schemaFingerprint(admin);
  const guard = async () => (await admin.query(`SELECT pg_get_functiondef('si.trg_evidence_append_only()'::regprocedure) AS d`)).rows[0].d;
  const guard0005 = await guard();
  assert.deepEqual(await migrateUp(admin, { to: 6 }), [6]);
  const with0006 = await schemaFingerprint(admin);
  assert.notEqual(with0006, only0005);
  assert.notEqual(await guard(), guard0005, '0006 replaces the evidence guard');
  assert.deepEqual(await migrateDown(admin, { to: 5, allowDestructive: true }), [6]);
  assert.equal(await guard(), guard0005, 'down 0006 restores the 0005 guard text byte for byte');
  assert.equal(await schemaFingerprint(admin), only0005, 'down 0006 restores the exact 0005 catalog');
  assert.deepEqual(await migrateUp(admin, { to: 6 }), [6]);
  assert.equal(await schemaFingerprint(admin), with0006);
});

test('M1g: up 0007 -> down 0007 restores the exact 0006 catalog (receipt guard and purge reason byte for byte); 0007 re-applies identically', async t => {
  const db = await freshDatabase(t, 'm1g', { migrate: false });
  const { admin } = await roles(t, db, ['admin']);
  assert.deepEqual(await migrateUp(admin, { to: 6 }), [1, 2, 3, 4, 5, 6]);
  const only0006 = await schemaFingerprint(admin);
  const def = async f => (await admin.query(`SELECT pg_get_functiondef($1::regprocedure) AS d`, [f])).rows[0].d;
  const fns = ['si.trg_receipts_guard()', 'si.si_retention_end_reason(text, int, timestamptz)'];
  const before = await Promise.all(fns.map(def));
  assert.deepEqual(await migrateUp(admin, { to: 7 }), [7]);
  const with0007 = await schemaFingerprint(admin);
  assert.notEqual(with0007, only0006);
  for (const [k, f] of fns.entries()) assert.notEqual(await def(f), before[k], `0007 replaces ${f}`);
  assert.deepEqual(await migrateDown(admin, { to: 6, allowDestructive: true }), [7]);
  for (const [k, f] of fns.entries()) assert.equal(await def(f), before[k], `down 0007 restores ${f} byte for byte`);
  assert.equal(await schemaFingerprint(admin), only0006, 'down 0007 restores the exact 0006 catalog');
  assert.deepEqual(await migrateUp(admin, { to: 7 }), [7]);
  assert.equal(await schemaFingerprint(admin), with0007);
});

test('M1h: up 0008 -> down 0008 restores the exact 0007 catalog; 0008 re-applies identically', async t => {
  const db = await freshDatabase(t, 'm1h', { migrate: false });
  const { admin } = await roles(t, db, ['admin']);
  assert.deepEqual(await migrateUp(admin, { to: 7 }), [1, 2, 3, 4, 5, 6, 7]);
  const only0007 = await schemaFingerprint(admin);
  assert.deepEqual(await migrateUp(admin, { to: 8 }), [8]);
  const with0008 = await schemaFingerprint(admin);
  assert.notEqual(with0008, only0007);
  assert.deepEqual(await migrateDown(admin, { to: 7, allowDestructive: true }), [8]);
  assert.equal(await schemaFingerprint(admin), only0007, 'down 0008 restores the exact 0007 catalog');
  assert.deepEqual(await migrateUp(admin, { to: 8 }), [8]);
  assert.equal(await schemaFingerprint(admin), with0008);
});

test('M1i: up 0009 -> down 0009 restores the exact 0008 catalog (0008 read function byte for byte); 0009 re-applies identically', async t => {
  const db = await freshDatabase(t, 'm1i', { migrate: false });
  const { admin } = await roles(t, db, ['admin']);
  assert.deepEqual(await migrateUp(admin, { to: 8 }), [1, 2, 3, 4, 5, 6, 7, 8]);
  const only0008 = await schemaFingerprint(admin);
  const def = async f => (await admin.query(`SELECT pg_get_functiondef(to_regprocedure($1)) AS d`, [f])).rows[0].d;
  const read8 = await def('si.si_read_evidence(text, text, int)');
  assert.ok(read8);
  assert.deepEqual(await migrateUp(admin, { to: 9 }), [9]);
  const with0009 = await schemaFingerprint(admin);
  assert.notEqual(with0009, only0008);
  assert.equal(await def('si.si_read_evidence(text, text, int)'), null, '0009 removes the intent-free read entry point');
  assert.deepEqual(await migrateDown(admin, { to: 8, allowDestructive: true }), [9]);
  assert.equal(await def('si.si_read_evidence(text, text, int)'), read8, 'down 0009 restores the 0008 read byte for byte');
  assert.equal(await schemaFingerprint(admin), only0008, 'down 0009 restores the exact 0008 catalog');
  assert.deepEqual(await migrateUp(admin, { to: 9 }), [9]);
  assert.equal(await schemaFingerprint(admin), with0009);
});

test('M1j: up 0010 -> down 0010 restores the exact 0009 catalog (intent trigger and read byte for byte); 0010 re-applies identically', async t => {
  const db = await freshDatabase(t, 'm1j', { migrate: false });
  const { admin } = await roles(t, db, ['admin']);
  assert.deepEqual(await migrateUp(admin, { to: 9 }), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const only0009 = await schemaFingerprint(admin);
  const def = async f => (await admin.query(`SELECT pg_get_functiondef(to_regprocedure($1)) AS d`, [f])).rows[0].d;
  const fns = ['si.trg_read_intents_guard()', 'si.si_read_evidence(text, uuid, text, int)'];
  const before = await Promise.all(fns.map(def));
  assert.deepEqual(await migrateUp(admin, { to: 10 }), [10]);
  const with0010 = await schemaFingerprint(admin);
  assert.notEqual(with0010, only0009);
  for (const [k, f] of fns.entries()) assert.notEqual(await def(f), before[k], `0010 replaces ${f}`);
  assert.deepEqual(await migrateDown(admin, { to: 9, allowDestructive: true }), [10]);
  for (const [k, f] of fns.entries()) assert.equal(await def(f), before[k], `down 0010 restores ${f} byte for byte`);
  assert.equal(await schemaFingerprint(admin), only0009, 'down 0010 restores the exact 0009 catalog');
  assert.deepEqual(await migrateUp(admin, { to: 10 }), [10]);
  assert.equal(await schemaFingerprint(admin), with0010);
});

test('M1k: up 0011 -> down 0011 restores the exact 0010 catalog (si_read_evidence untouched); 0011 re-applies identically', async t => {
  const db = await freshDatabase(t, 'm1k', { migrate: false });
  const { admin } = await roles(t, db, ['admin']);
  assert.deepEqual(await migrateUp(admin, { to: 10 }), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const only0010 = await schemaFingerprint(admin);
  const def = async f => (await admin.query(`SELECT pg_get_functiondef(to_regprocedure($1)) AS d`, [f])).rows[0].d;
  const read10 = await def('si.si_read_evidence(text, uuid, text, int)');
  assert.deepEqual(await migrateUp(admin, { to: 11 }), [11]);
  const with0011 = await schemaFingerprint(admin);
  assert.notEqual(with0011, only0010);
  assert.equal(await def('si.si_read_evidence(text, uuid, text, int)'), read10, '0011 does not modify the evidence read');
  assert.deepEqual(await migrateDown(admin, { to: 10, allowDestructive: true }), [11]);
  assert.equal(await schemaFingerprint(admin), only0010, 'down 0011 restores the exact 0010 catalog');
  assert.deepEqual(await migrateUp(admin, { to: 11 }), [11]);
  assert.equal(await schemaFingerprint(admin), with0011);
});

test('M1l: up 0012 -> down 0012 restores the exact 0011 catalog (evidence read and status untouched); 0012 re-applies identically', async t => {
  const db = await freshDatabase(t, 'm1l', { migrate: false });
  const { admin } = await roles(t, db, ['admin']);
  assert.deepEqual(await migrateUp(admin, { to: 11 }), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  const only0011 = await schemaFingerprint(admin);
  const def = async f => (await admin.query(`SELECT pg_get_functiondef(to_regprocedure($1)) AS d`, [f])).rows[0].d;
  const fns = ['si.si_read_evidence(text, uuid, text, int)', 'si.si_read_source_status(text, uuid, timestamptz, timestamptz)',
               'si.si_claim_read_intent(text, text, uuid, text, int)', 'si.si_begin_read(text, text, int)'];
  const before = await Promise.all(fns.map(def));
  assert.deepEqual(await migrateUp(admin, { to: 12 }), [12]);
  const with0012 = await schemaFingerprint(admin);
  assert.notEqual(with0012, only0011);
  for (const [k, f] of fns.entries()) assert.equal(await def(f), before[k], `0012 does not modify ${f}`);
  assert.deepEqual(await migrateDown(admin, { to: 11, allowDestructive: true }), [12]);
  assert.equal(await schemaFingerprint(admin), only0011, 'down 0012 restores the exact 0011 catalog');
  assert.deepEqual(await migrateUp(admin, { to: 12 }), [12]);
  assert.equal(await schemaFingerprint(admin), with0012);
});

test('M1m: up 0013 -> down 0013 restores the exact 0012 catalog and availability function; 0013 re-applies identically', async t => {
  const db = await freshDatabase(t, 'm1m', { migrate: false });
  const { admin } = await roles(t, db, ['admin']);
  assert.deepEqual(await migrateUp(admin, { to: 12 }), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  const only0012 = await schemaFingerprint(admin);
  const def = async f => (await admin.query(`SELECT pg_get_functiondef(to_regprocedure($1)) AS d`, [f])).rows[0].d;
  const avail = 'si.si_read_source_availability(text, uuid)';
  const fns = ['si.si_read_evidence(text, uuid, text, int)', 'si.si_read_source_status(text, uuid, timestamptz, timestamptz)',
               'si.si_claim_read_intent(text, text, uuid, text, int)', 'si.si_begin_read(text, text, int)'];
  const before = await Promise.all(fns.map(def)), avail12 = await def(avail);
  assert.deepEqual(await migrateUp(admin, { to: 13 }), [13]);
  const with0013 = await schemaFingerprint(admin);
  assert.notEqual(with0013, only0012);
  for (const [k, f] of fns.entries()) assert.equal(await def(f), before[k], `0013 does not modify ${f}`);
  assert.notEqual(await def(avail), avail12, '0013 replaces the availability function');
  assert.deepEqual(await migrateDown(admin, { to: 12, allowDestructive: true }), [13]);
  assert.equal(await def(avail), avail12, 'down 0013 restores 0012\'s availability function byte for byte');
  assert.equal(await schemaFingerprint(admin), only0012, 'down 0013 restores the exact 0012 catalog');
  assert.deepEqual(await migrateUp(admin, { to: 13 }), [13]);
  assert.equal(await schemaFingerprint(admin), with0013, 'a fresh key (data), the same catalog');
});

test('M1n: up 0014 -> down 0014 restores the exact 0013 catalog (no existing function modified); 0014 re-applies identically', async t => {
  const db = await freshDatabase(t, 'm1n', { migrate: false });
  const { admin } = await roles(t, db, ['admin']);
  assert.deepEqual(await migrateUp(admin, { to: 13 }), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  const only0013 = await schemaFingerprint(admin);
  const defs = async () => (await admin.query(`SELECT string_agg(p.oid::regprocedure::text || md5(pg_get_functiondef(p.oid)), ',' ORDER BY 1) AS d
                                               FROM pg_proc p WHERE p.pronamespace = 'si'::regnamespace`)).rows[0].d;
  const before = await defs();
  assert.deepEqual(await migrateUp(admin, { to: 14 }), [14]);
  const with0014 = await schemaFingerprint(admin);
  assert.notEqual(with0014, only0013);
  const after = await defs();
  for (const d of before.split(',')) assert.ok(after.includes(d), `0014 does not modify ${d.slice(0, 60)}`);
  assert.deepEqual(await migrateDown(admin, { to: 13, allowDestructive: true }), [14]);
  assert.equal(await schemaFingerprint(admin), only0013, 'down 0014 restores the exact 0013 catalog');
  assert.deepEqual(await migrateUp(admin, { to: 14 }), [14]);
  assert.equal(await schemaFingerprint(admin), with0014);
});

test('M1o: up 0015 changes exactly the two reader functions and the advertiser index; down 0015 restores the exact 0014 catalog', async t => {
  const db = await freshDatabase(t, 'm1o', { migrate: false });
  const { admin } = await roles(t, db, ['admin']);
  assert.deepEqual(await migrateUp(admin, { to: 14 }), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  const only0014 = await schemaFingerprint(admin);
  const defs = async () => new Map((await admin.query(`SELECT p.oid::regprocedure::text AS f, md5(pg_get_functiondef(p.oid)) AS d
                                                         FROM pg_proc p WHERE p.pronamespace = 'si'::regnamespace`)).rows.map(r => [r.f, r.d]));
  const before = await defs();
  assert.deepEqual(await migrateUp(admin, { to: 15 }), [15]);
  const with0015 = await schemaFingerprint(admin);
  const after = await defs();
  const changed = [...before].filter(([f, d]) => after.get(f) !== d).map(([f]) => f).sort();
  const added = [...after.keys()].filter(f => !before.has(f)).sort();
  assert.deepEqual(changed, ['si.si_advertiser_history(text,uuid,text,text[],timestamp with time zone,timestamp with time zone,text,integer)',
    'si.si_search_advertisers(text,uuid,text,text[],timestamp with time zone,timestamp with time zone,text,boolean,integer)']);
  assert.deepEqual(added, ['si.si_advertiser_key(text)']);
  const idx = async () => (await admin.query(`SELECT indexname FROM pg_indexes WHERE schemaname = 'si' AND tablename = 'observations' ORDER BY 1`)).rows.map(r => r.indexname);
  assert.ok((await idx()).includes('observations_by_source_advertiser_key') && !(await idx()).includes('observations_by_source_advertiser'));
  assert.deepEqual(await migrateDown(admin, { to: 14, allowDestructive: true }), [15]);
  assert.equal(await schemaFingerprint(admin), only0014, 'down 0015 restores the exact 0014 catalog');
  assert.deepEqual(await migrateUp(admin, { to: 15 }), [15]);
  assert.equal(await schemaFingerprint(admin), with0015, '0015 re-applies identically');
});

test('M1p: up 0016 changes exactly the two reader functions (readable runs selected first, no join, plan_cache_mode pinned); down 0016 restores the exact 0015 catalog', async t => {
  const db = await freshDatabase(t, 'm1p', { migrate: false });
  const { admin } = await roles(t, db, ['admin']);
  assert.deepEqual(await migrateUp(admin, { to: 15 }), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  const only0015 = await schemaFingerprint(admin);
  const defs = async () => new Map((await admin.query(`SELECT p.oid::regprocedure::text AS f, pg_get_functiondef(p.oid) AS d, p.proconfig, p.proacl::text AS acl
                                                         FROM pg_proc p WHERE p.pronamespace = 'si'::regnamespace`)).rows.map(r => [r.f, r]));
  const before = await defs();
  assert.deepEqual(await migrateUp(admin, { to: 16 }), [16]);
  const with0016 = await schemaFingerprint(admin);
  const after = await defs();
  const changed = [...before].filter(([f, r]) => after.get(f).d !== r.d).map(([f]) => f).sort();
  assert.deepEqual(changed, ['si.si_advertiser_history(text,uuid,text,text[],timestamp with time zone,timestamp with time zone,text,integer)',
    'si.si_search_advertisers(text,uuid,text,text[],timestamp with time zone,timestamp with time zone,text,boolean,integer)']);
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), 'no function added or removed');
  for (const f of changed) {
    const [b, a] = [before.get(f), after.get(f)];
    assert.equal(a.acl, b.acl, `${f}: privileges unchanged`);
    assert.deepEqual(a.proconfig, [...b.proconfig, 'plan_cache_mode=force_custom_plan'], `${f}: only plan_cache_mode added to the pinned settings`);
    assert.match(a.d, /o\.run_id = ANY \(readable_runs\)/);
    assert.doesNotMatch(a.d, /JOIN readable|WITH readable/, `${f}: no join with the readable runs`);
    assert.equal(a.d.split('si.si_evidence_readable(r.run_id)').length, 2, `${f}: the evidence predicate appears exactly once`);
  }
  assert.deepEqual(await migrateDown(admin, { to: 15, allowDestructive: true }), [16]);
  assert.equal(await schemaFingerprint(admin), only0015, 'down 0016 restores the exact 0015 catalog');
  assert.deepEqual(await migrateUp(admin, { to: 16 }), [16]);
  assert.equal(await schemaFingerprint(admin), with0016, '0016 re-applies identically');
});

test('M1q: up 0017 changes exactly the two durability gates (one line each: the target) and adds the owner-only target function; down 0017 restores the exact 0016 catalog', async t => {
  const db = await freshDatabase(t, 'm1q', { migrate: false });
  const { admin } = await roles(t, db, ['admin']);
  assert.deepEqual(await migrateUp(admin, { to: 16 }), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  const only0016 = await schemaFingerprint(admin);
  const defs = async () => new Map((await admin.query(`SELECT p.oid::regprocedure::text AS f, pg_get_functiondef(p.oid) AS d, p.proconfig, p.proacl::text AS acl,
                                                                p.prosecdef, p.provolatile, pg_get_userbyid(p.proowner) AS owner
                                                         FROM pg_proc p WHERE p.pronamespace = 'si'::regnamespace`)).rows.map(r => [r.f, r]));
  const before = await defs();
  assert.deepEqual(await migrateUp(admin, { to: 17 }), [17]);
  const with0017 = await schemaFingerprint(admin);
  const after = await defs();
  const changed = [...before].filter(([f, r]) => after.get(f).d !== r.d).map(([f]) => f).sort();
  assert.deepEqual(changed, ['si.si_claim_read_intent(text,text,uuid,text,integer)', 'si.si_read_evidence(text,uuid,text,integer)']);
  assert.deepEqual([...after.keys()].filter(f => !before.has(f)), ['si.si_durability_target(pg_lsn)']);
  const OLD = '  target := pg_current_wal_insert_lsn();';
  const NEW = '  target := si.si_durability_target(pg_current_wal_insert_lsn());              -- 0017 (R-35): header bytes excluded';
  for (const f of changed) {
    const [b, a] = [before.get(f), after.get(f)];
    assert.deepEqual([a.acl, a.proconfig, a.prosecdef, a.provolatile, a.owner], [b.acl, b.proconfig, b.prosecdef, b.provolatile, b.owner], `${f}: attributes unchanged`);
    assert.equal(a.d, b.d.replace(OLD, NEW), `${f}: exactly the target line changed`);
    assert.equal(b.d.split(OLD).length, 2, `${f}: one target line before`);
  }
  const helper = after.get('si.si_durability_target(pg_lsn)');
  assert.deepEqual([helper.owner, helper.prosecdef, helper.provolatile, helper.acl], ['si_owner', false, 's', '{si_owner=X/si_owner}'], 'owner-only helper');
  assert.deepEqual(await migrateDown(admin, { to: 16, allowDestructive: true }), [17]);
  assert.equal(await schemaFingerprint(admin), only0016, 'down 0017 restores the exact 0016 catalog');
  assert.deepEqual(await migrateUp(admin, { to: 17 }), [17]);
  assert.equal(await schemaFingerprint(admin), with0017, '0017 re-applies identically');
});

test('0001 is frozen: its files match the checksums merged in PR #2 (main 4418b69)', () => {
  // Applied migrations are immutable. A change to 0001 must be a new migration instead.
  const sha = f => createHash('sha256').update(readFileSync(join(DEFAULT_MIGRATIONS_DIR, f))).digest('hex');
  assert.equal(sha('0001_sources_rights.up.sql'), 'a538faad41b54489f77195f99a5ca155df4b15072fd7e181d04db8d1035ba77f');
  assert.equal(sha('0001_sources_rights.down.sql'), 'b12f6f743cba76f9b91de2f02298e76f5f79130c9c72b6f7f53245f09bc671ce');
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
  assert.deepEqual(await appliedVersions(admin), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17], 'nothing changed');
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
  await rejects(assert, migrateDown(admin, { to: 1 }), { message: /^DESTRUCTIVE_NOT_ALLOWED/ });
  assert.deepEqual(await appliedVersions(admin), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);

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
  const rows = (await admin.query('SELECT * FROM si.schema_migrations ORDER BY version')).rows;
  const sha = f => createHash('sha256').update(readFileSync(join(DEFAULT_MIGRATIONS_DIR, f))).digest('hex');
  assert.deepEqual(rows.map(r => [r.version, r.name]), [[1, 'sources_rights'], [2, 'runs'], [3, 'request_scope'], [4, 'completion_hardening'], [5, 'evidence'], [6, 'retention'], [7, 'receipt_verification'], [8, 'internal_reader'], [9, 'read_audit'], [10, 'read_durability'], [11, 'reader_status'], [12, 'reader_availability'], [13, 'opaque_availability_state'], [14, 'server_side_intelligence'], [15, 'intelligence_remediation'], [16, 'cold_query_reliability'], [17, 'wal_boundary_gate']]);
  for (const [row, base] of [[rows[0], '0001_sources_rights'], [rows[1], '0002_runs'], [rows[2], '0003_request_scope'],
                             [rows[3], '0004_completion_hardening'], [rows[4], '0005_evidence'], [rows[5], '0006_retention'], [rows[6], '0007_receipt_verification'], [rows[7], '0008_internal_reader'], [rows[8], '0009_read_audit'], [rows[9], '0010_read_durability'], [rows[10], '0011_reader_status'], [rows[11], '0012_reader_availability'], [rows[12], '0013_opaque_availability_state'], [rows[13], '0014_server_side_intelligence'], [rows[14], '0015_intelligence_remediation'], [rows[15], '0016_cold_query_reliability'], [rows[16], '0017_wal_boundary_gate']]) {
    assert.equal(row.up_sha256, sha(`${base}.up.sql`));
    assert.equal(row.down_sha256, sha(`${base}.down.sql`));
    assert.equal(row.applied_by, cfg.adminUser);
  }
  const owners = (await admin.query(`
    SELECT DISTINCT pg_get_userbyid(relowner) AS o FROM pg_class WHERE relnamespace = 'si'::regnamespace
    UNION SELECT DISTINCT pg_get_userbyid(proowner) FROM pg_proc WHERE pronamespace = 'si'::regnamespace`)).rows;
  assert.deepEqual(owners.map(r => r.o), ['si_owner']);
});

test('assertSchemaVersion: the application refuses a database at the wrong version', async t => {
  const db = await freshDatabase(t, 'version');
  const { si_collector } = await roles(t, db, ['si_collector']);
  assert.equal(codeSchemaVersion(), 17);
  await assertSchemaVersion(si_collector);                            // as an application role
  await rejects(assert, assertSchemaVersion(si_collector, 10), { message: /^SCHEMA_VERSION_MISMATCH: database is at version 17/ });
  const empty = await freshDatabase(t, 'version0', { migrate: false });
  const c = await connect({ database: empty });
  t.after(() => c.end());
  await rejects(assert, assertSchemaVersion(c), { message: /database is at version 0, code expects 17/ });
});

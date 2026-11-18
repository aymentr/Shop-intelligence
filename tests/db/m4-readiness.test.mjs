// B-002 M4-P3.3 Phase 1 (R-45): db/ops/readiness.sql — schema readiness of the 0022 index. Real disposable PostgreSQL 16.
// Every fault is built in its own database cloned from the migrated template; the EXACT set of failure codes is asserted,
// so removing any single check changes the result of a named test (tests/mutations/m4-p33-p1.mjs).
// Fixtures a product path cannot perform, labelled where used:
//   - CATALOG FLAGS: the test superuser sets pg_index.indisvalid / indisready / indislive on one index (single-flag states
//     that PostgreSQL only produces transiently; the realistic cancelled CREATE INDEX CONCURRENTLY is in m4-adopt, MIG-4).
//   - SUBSTITUTES: the owner drops the 0022 index and creates a deliberately wrong one under the same name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { asOwner, cfg, connect, freshDatabase, roles } from './helpers.mjs';
import { checkIndexReadiness, checkIndexReadinessPrecondition, READINESS_SQL_PATH, REQUIRED_INDEX_DEFINITION } from '../../dist/persistence/readiness.js';
import { migrateUp } from '../../dist/persistence/migrate.js';

const SQL = readFileSync(READINESS_SQL_PATH, 'utf8');
const GATE = readFileSync(new URL('../../db/ops/integrity-gate.sql', import.meta.url), 'utf8');
const IX = 'si.observations_by_ad_fk';
const COLS = '(ad_id, source_id, network, native_ad_id)';
async function fresh(t) { const db = await freshDatabase(t, 'm4rdy'); const { admin } = await roles(t, db, ['admin']); return { db, admin }; }
const codes = async c => (await checkIndexReadiness(c)).map(f => `${f.code}:${f.object}`).sort();
async function substitute(admin, ddl) { await asOwner(admin, async a => { await a.query(`DROP INDEX ${IX}`); await a.query(ddl); }); }
async function flag(admin, column, value) {
  await admin.query(`UPDATE pg_catalog.pg_index SET ${column} = $1 WHERE indexrelid = '${IX}'::regclass`, [value]);   // CATALOG FLAGS
}

test('RDY-0: a migrated database passes; the check is read-only and needs no privilege (si_monitor, READ ONLY transaction)', async t => {
  const { db, admin } = await fresh(t);
  assert.deepEqual(await codes(admin), []);
  assert.equal((await admin.query(`SELECT pg_get_indexdef('${IX}'::regclass) AS d`)).rows[0].d, REQUIRED_INDEX_DEFINITION, 'the pinned text is what 0022 creates');
  assert.ok(SQL.includes(`'${REQUIRED_INDEX_DEFINITION}'`), 'readiness.sql pins the same definition');
  const mon = await connect({ user: 'si_monitor', database: db }); t.after(() => mon.end());
  await mon.query('BEGIN READ ONLY');
  assert.deepEqual((await mon.query(SQL)).rows, []);
  await mon.query('ROLLBACK');
});

const FAULTS = [
  ['RDY-1 missing', async a => asOwner(a, x => x.query(`DROP INDEX ${IX}`)), ['INDEX_MISSING:si.observations_by_ad_fk']],
  ['RDY-2 not valid', async a => flag(a, 'indisvalid', false), ['INDEX_NOT_VALID:si.observations_by_ad_fk']],
  ['RDY-3 not ready', async a => flag(a, 'indisready', false), ['INDEX_NOT_READY:si.observations_by_ad_fk']],
  ['RDY-4 not live', async a => flag(a, 'indislive', false), ['INDEX_NOT_LIVE:si.observations_by_ad_fk']],
  ['RDY-5 not an index', async a => asOwner(a, async x => { await x.query(`DROP INDEX ${IX}`); await x.query('CREATE TABLE si.observations_by_ad_fk (x int)'); }),
    ['NOT_AN_INDEX:si.observations_by_ad_fk']],
  ['RDY-6 wrong table', async a => substitute(a, `CREATE INDEX observations_by_ad_fk ON si.ads ${COLS}`),
    ['INDEX_WRONG_DEFINITION:si.observations_by_ad_fk', 'INDEX_WRONG_TABLE:si.ads']],
  ['RDY-7 wrong access method', async a => substitute(a, `CREATE INDEX observations_by_ad_fk ON si.observations USING brin ${COLS}`),
    ['INDEX_WRONG_ACCESS_METHOD:brin', 'INDEX_WRONG_DEFINITION:si.observations_by_ad_fk', 'INDEX_WRONG_OPCLASS:ad_id', 'INDEX_WRONG_OPCLASS:native_ad_id',
     'INDEX_WRONG_OPCLASS:network', 'INDEX_WRONG_OPCLASS:source_id']],
  ['RDY-8 key order', async a => substitute(a, 'CREATE INDEX observations_by_ad_fk ON si.observations (source_id, ad_id, network, native_ad_id)'),
    ['INDEX_WRONG_DEFINITION:si.observations_by_ad_fk', 'INDEX_WRONG_KEY:si.observations_by_ad_fk']],
  ['RDY-9 key column missing', async a => substitute(a, 'CREATE INDEX observations_by_ad_fk ON si.observations (ad_id, source_id, network)'),
    ['INDEX_WRONG_DEFINITION:si.observations_by_ad_fk', 'INDEX_WRONG_KEY:si.observations_by_ad_fk']],
  ['RDY-10 collation', async a => substitute(a, 'CREATE INDEX observations_by_ad_fk ON si.observations (ad_id, source_id COLLATE "C", network, native_ad_id)'),
    ['INDEX_WRONG_COLLATION:source_id', 'INDEX_WRONG_DEFINITION:si.observations_by_ad_fk']],
  ['RDY-11 operator class', async a => substitute(a, 'CREATE INDEX observations_by_ad_fk ON si.observations (ad_id, source_id text_pattern_ops, network, native_ad_id)'),
    ['INDEX_WRONG_DEFINITION:si.observations_by_ad_fk', 'INDEX_WRONG_OPCLASS:source_id']],
  ['RDY-12 direction (DESC)', async a => substitute(a, 'CREATE INDEX observations_by_ad_fk ON si.observations (ad_id DESC, source_id, network, native_ad_id)'),
    ['INDEX_WRONG_DEFINITION:si.observations_by_ad_fk', 'INDEX_WRONG_DIRECTION:ad_id']],
  ['RDY-13 direction (NULLS FIRST)', async a => substitute(a, 'CREATE INDEX observations_by_ad_fk ON si.observations (ad_id, source_id, network NULLS FIRST, native_ad_id)'),
    ['INDEX_WRONG_DEFINITION:si.observations_by_ad_fk', 'INDEX_WRONG_DIRECTION:network']],
  ['RDY-14 included columns', async a => substitute(a, `CREATE INDEX observations_by_ad_fk ON si.observations ${COLS} INCLUDE (run_id)`),
    ['INDEX_INCLUDED_COLUMNS:si.observations_by_ad_fk', 'INDEX_WRONG_DEFINITION:si.observations_by_ad_fk']],
  ['RDY-15 partial', async a => substitute(a, `CREATE INDEX observations_by_ad_fk ON si.observations ${COLS} WHERE network = 'META'`),
    ['INDEX_PARTIAL:si.observations_by_ad_fk', 'INDEX_WRONG_DEFINITION:si.observations_by_ad_fk']],
  ['RDY-16 expression', async a => substitute(a, 'CREATE INDEX observations_by_ad_fk ON si.observations (ad_id, source_id, network, lower(native_ad_id))'),
    ['INDEX_EXPRESSION:si.observations_by_ad_fk', 'INDEX_WRONG_DEFINITION:si.observations_by_ad_fk', 'INDEX_WRONG_KEY:si.observations_by_ad_fk']],
  ['RDY-17 unique (catch-all)', async a => substitute(a, `CREATE UNIQUE INDEX observations_by_ad_fk ON si.observations ${COLS}`),
    ['INDEX_WRONG_DEFINITION:si.observations_by_ad_fk']],
  ['RDY-18 invalid artifact beside a ready index', async a => {
    await asOwner(a, x => x.query(`CREATE INDEX observations_by_ad_fk_ccnew ON si.observations ${COLS}`));
    await a.query(`UPDATE pg_catalog.pg_index SET indisvalid = false WHERE indexrelid = 'si.observations_by_ad_fk_ccnew'::regclass`);   // CATALOG FLAGS
  }, ['INVALID_INDEX_ARTIFACT:observations_by_ad_fk_ccnew']],
  ['RDY-19 invalid artifact on another table of schema si', async a => {
    await asOwner(a, x => x.query('CREATE INDEX ads_scratch ON si.ads (native_ad_id)'));
    await a.query(`UPDATE pg_catalog.pg_index SET indisready = false WHERE indexrelid = 'si.ads_scratch'::regclass`);                // CATALOG FLAGS
  }, ['INVALID_INDEX_ARTIFACT:ads_scratch']],
];
for (const [name, fault, expected] of FAULTS) {
  test(`${name}: reported exactly`, async t => {
    const { admin } = await fresh(t);
    await fault(admin);
    assert.deepEqual(await codes(admin), [...expected].sort());
  });
}

test('RDY-20: readiness is not evidence integrity: each check is blind to what the other reports', async t => {
  const { admin } = await fresh(t);
  await asOwner(admin, a => a.query(`DROP INDEX ${IX}`));
  assert.deepEqual((await admin.query(GATE)).rows, [], 'the integrity gate does not judge the performance index');
  assert.deepEqual(await codes(admin), ['INDEX_MISSING:si.observations_by_ad_fk']);
  const b = await fresh(t);
  await asOwner(b.admin, a => a.query('ALTER TABLE si.observations DROP CONSTRAINT observations_ad'));
  assert.ok((await b.admin.query(GATE)).rows.length > 0, 'the integrity gate reports the dropped FK');
  assert.deepEqual(await codes(b.admin), [], 'readiness does not judge evidence references');
});

test('RDY-21: preflight form: NOT_APPLICABLE below version 22, PASS at 23, FAIL with codes when the index is broken', async t => {
  const db = await freshDatabase(t, 'm4rdy21', { migrate: false });
  const { admin } = await roles(t, db, ['admin']);
  await migrateUp(admin, { to: 21 });
  assert.deepEqual(await checkIndexReadinessPrecondition(admin), [{ name: 'index_readiness_observations_by_ad_fk', ok: true,
    actual: 'NOT_APPLICABLE (schema version 21 < 22)', expected: 'PASS' }]);
  const x = await fresh(t);
  assert.equal((await checkIndexReadinessPrecondition(x.admin))[0].actual, 'PASS');
  await flag(x.admin, 'indisvalid', false);
  assert.deepEqual(await checkIndexReadinessPrecondition(x.admin), [{ name: 'index_readiness_observations_by_ad_fk', ok: false,
    actual: 'INDEX_NOT_VALID:si.observations_by_ad_fk', expected: 'PASS' }]);
});

test('RDY-22: `cli.js readiness` exits 0 on PASS and 1 with every failure code', async t => {
  const cli = fileURLToPath(new URL('../../dist/persistence/cli.js', import.meta.url));
  const { db, admin } = await fresh(t);
  const env = { ...process.env, SI_DATABASE_URL: `postgres://${cfg.adminUser}:${encodeURIComponent(cfg.adminPassword)}@${cfg.host}:${cfg.port}/${db}` };
  delete env.SI_PRODUCTION;
  let r = spawnSync(process.execPath, [cli, 'readiness'], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^readiness PASS/m);
  await substitute(admin, 'CREATE INDEX observations_by_ad_fk ON si.observations (source_id, ad_id, network, native_ad_id)');
  r = spawnSync(process.execPath, [cli, 'readiness'], { encoding: 'utf8', env });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n').sort(), ['FAIL INDEX_WRONG_DEFINITION si.observations_by_ad_fk', 'FAIL INDEX_WRONG_KEY si.observations_by_ad_fk']);
});

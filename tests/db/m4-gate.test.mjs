// B-002 M4-P3.3-P1-CLOSE-01: the 0022 index readiness check inside the ACTUAL production gate (assertProductionReady,
// which every SI_PRODUCTION=1 CLI command runs before dispatch), at exactly version 22 and at 23, and through adoption.
// Closes the acceptance findings NX1 (the gate's own readiness check removable without a failing test: `preflight
// --production` appends the same check a second time, which masked it) and NX2 (version 22 untested).
// Real disposable PostgreSQL 16. Fixtures a product path cannot perform, labelled where used:
//   - HARDENING: db/bootstrap/optional/advisory-lock-hardening.sql applied by the test superuser to the disposable database
//     (the production gate requires it; as in preconditions.test.mjs).
//   - CATALOG FLAG: the test superuser marks the index invalid (pg_index.indisvalid = false).
//   - BULK ROWS: synthetic observations inserted under session_replication_role = replica.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { asOwner, cfg, connect, freshDatabase, roles } from './helpers.mjs';
import { assertProductionReady } from '../../dist/persistence/production-readiness.js';
import { adoptMigration, buildIndexConcurrently, migrateUp } from '../../dist/persistence/migrate.js';
import { checkIndexReadinessPrecondition } from '../../dist/persistence/readiness.js';

const CLI = fileURLToPath(new URL('../../dist/persistence/cli.js', import.meta.url));
const HARDENING = readFileSync(new URL('../../db/bootstrap/optional/advisory-lock-hardening.sql', import.meta.url), 'utf8');
const IX = 'si.observations_by_ad_fk';
const CHECK = 'index_readiness_observations_by_ad_fk';

/** A hardened disposable database at `version`. At 22 the index is built concurrently and ADOPTED (the populated path). */
async function hardened(t, version, { adopt = version === 22 } = {}) {
  const db = await freshDatabase(t, 'm4gate', { migrate: false });
  const { admin } = await roles(t, db, ['admin']);
  await migrateUp(admin, { to: adopt ? 21 : version });
  await admin.query('BEGIN'); await admin.query('SET LOCAL session_replication_role = replica');               // BULK ROWS
  await admin.query(`INSERT INTO si.observations (run_id, source_id, rights_version_id, ordinal, ad_id, network, native_ad_id, advertiser_name,
      countries, seen_at, source_url, content_sha256)
    SELECT md5('r' || (g / 500))::uuid, 'gate-src', 1, g % 500, g, 'META', 'n-' || g, 'Synthetic', ARRAY['DE'], now(), 'https://example.test/a',
           repeat('a', 64) FROM generate_series(0, 1999) g`);
  await admin.query('COMMIT');
  if (adopt) {
    const mig = await connect({ user: 'si_migrator', database: db });
    try {
      await buildIndexConcurrently(mig, { version: 22 });
      assert.equal((await adoptMigration(mig, { version: 22 })).state, 'ADOPTED');
      if (version > 22) await migrateUp(mig, { to: version });
    } finally { await mig.end(); }
  }
  await admin.query(HARDENING);                                                                                // HARDENING
  const v = Number((await admin.query('SELECT max(version) AS v FROM si.schema_migrations')).rows[0].v);
  assert.equal(v, version);
  return { db, admin };
}
async function gate(db, admin) {
  const collector = await connect({ user: 'si_collector', database: db });
  try { await assertProductionReady(admin, { collector }); return 'PASS'; }
  catch (e) { return e.message; }
  finally { await collector.end(); }
}
const invalidate = admin => admin.query(`UPDATE pg_catalog.pg_index SET indisvalid = false WHERE indexrelid = '${IX}'::regclass`);  // CATALOG FLAG
function productionCli(db, args) {
  const env = { ...process.env, SI_PRODUCTION: '1',
    SI_DATABASE_URL: `postgres://${cfg.adminUser}:${encodeURIComponent(cfg.adminPassword)}@${cfg.host}:${cfg.port}/${db}`,
    SI_COLLECTOR_DATABASE_URL: `postgres://si_collector:${encodeURIComponent(cfg.rolePassword)}@${cfg.host}:${cfg.port}/${db}` };
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });
}

test('GATE-1: the production gate itself (assertProductionReady) passes a ready index at 23 and rejects an invalid or missing one', async t => {
  const { db, admin } = await hardened(t, 23);
  assert.equal(await gate(db, admin), 'PASS');
  await invalidate(admin);
  assert.match(await gate(db, admin), new RegExp(`^PRODUCTION_PREFLIGHT_FAILED: .*${CHECK}=INDEX_NOT_VALID:si\\.observations_by_ad_fk`));
  await asOwner(admin, a => a.query(`DROP INDEX ${IX}`));
  assert.match(await gate(db, admin), new RegExp(`^PRODUCTION_PREFLIGHT_FAILED: .*${CHECK}=INDEX_MISSING:si\\.observations_by_ad_fk`));
});

test('GATE-2: a production command (SI_PRODUCTION=1 `status`) is refused before dispatch when the index is not ready, and runs when it is', async t => {
  const { db, admin } = await hardened(t, 23);
  let r = productionCli(db, ['status']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /"applied":\[1,.*23\]/);
  await invalidate(admin);
  r = productionCli(db, ['status']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(r.stdout, '', 'nothing was dispatched');
  assert.match(r.stderr, new RegExp(`PRODUCTION_PREFLIGHT_FAILED: .*${CHECK}=INDEX_NOT_VALID`));
});

test('GATE-3: exactly version 22 (adopted, before up): a ready index passes the gate, an invalid one is refused (also via the CLI)', async t => {
  const { db, admin } = await hardened(t, 22);
  assert.deepEqual(await checkIndexReadinessPrecondition(admin), [{ name: CHECK, ok: true, actual: 'PASS', expected: 'PASS' }],
    'at 22 the check is enforced, not NOT_APPLICABLE');
  assert.equal(await gate(db, admin), 'PASS');
  assert.equal(productionCli(db, ['status']).status, 0);
  await invalidate(admin);
  assert.match(await gate(db, admin), new RegExp(`${CHECK}=INDEX_NOT_VALID`));
  const r = productionCli(db, ['status']);
  assert.equal(r.status, 1); assert.match(r.stderr, new RegExp(`${CHECK}=INDEX_NOT_VALID`));
});

test('GATE-4: exactly version 22 reached by the plain migration passes; at 21 the check is NOT_APPLICABLE and production-mode recovery works', async t => {
  const plain = await hardened(t, 22, { adopt: false });
  assert.equal(await gate(plain.db, plain.admin), 'PASS');
  // version 21 with the invalid leftover of a failed build: the gate passes (index not yet required), so the documented
  // recovery runs as production commands: build-index --replace-invalid, adopt, then status at 22.
  const { db, admin } = await hardened(t, 21);
  await asOwner(admin, a => a.query('CREATE INDEX observations_by_ad_fk ON si.observations (ad_id, source_id, network, native_ad_id)'));
  await invalidate(admin);
  assert.equal((await checkIndexReadinessPrecondition(admin))[0].actual, 'NOT_APPLICABLE (schema version 21 < 22)');
  assert.equal(await gate(db, admin), 'PASS');
  let r = productionCli(db, ['adopt', '--version', '22']);
  assert.equal(r.status, 1); assert.match(r.stderr, /INDEX_NOT_READY/);
  r = productionCli(db, ['build-index', '--version', '22', '--replace-invalid']);
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /"state":"BUILT","ms":[0-9.]+,"replacedInvalid":true/);
  r = productionCli(db, ['adopt', '--version', '22']);
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /"state":"ADOPTED"/);
  assert.equal(productionCli(db, ['status']).status, 0);
});

test('GATE-5: an invalid index is never accepted by adoption or repeated adoption, at 21 or after 22 is recorded', async t => {
  const { db, admin } = await hardened(t, 21);
  await asOwner(admin, a => a.query('CREATE INDEX observations_by_ad_fk ON si.observations (ad_id, source_id, network, native_ad_id)'));
  await invalidate(admin);
  const mig = await connect({ user: 'si_migrator', database: db }); t.after(() => mig.end());
  const evidence = async () => (await admin.query(`SELECT to_regclass('si.schema_adoptions') IS NOT NULL AS p`)).rows[0].p
    ? Number((await admin.query('SELECT count(*) AS n FROM si.schema_adoptions')).rows[0].n) : 0;
  for (let i = 0; i < 2; i++) {
    await assert.rejects(adoptMigration(mig, { version: 22 }), e => e.code === 'INDEX_NOT_READY' && /INDEX_NOT_VALID/.test(e.message));
    assert.equal(Number((await admin.query('SELECT max(version) AS v FROM si.schema_migrations')).rows[0].v), 21);
    assert.equal(await evidence(), 0);
  }
  // 22 recorded (repair, then adopt), then the index becomes invalid: repeated adoption must not report success
  await asOwner(admin, a => a.query(`DROP INDEX ${IX}`));
  await buildIndexConcurrently(mig, { version: 22 });
  assert.equal((await adoptMigration(mig, { version: 22 })).state, 'ADOPTED');
  await invalidate(admin);
  for (let i = 0; i < 2; i++) {
    await assert.rejects(adoptMigration(mig, { version: 22 }), e => e.code === 'INDEX_NOT_READY' && /is recorded but the index is not ready/.test(e.message));
    assert.equal(await evidence(), 1);
  }
});

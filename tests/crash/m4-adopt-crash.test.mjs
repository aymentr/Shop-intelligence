// B-002 M4-P3.3 Phase 1 (R-42): a database restart during the concurrent build of the 0022 index. Real disposable
// PostgreSQL 16 (compose), synthetic data. Fixtures a product path cannot perform, labelled where used:
//   - CRASH: the build's backend is killed with SIGKILL inside the disposable compose container; the postmaster then
//     terminates every session, reinitialises and replays WAL (crash recovery: a full server restart cycle without
//     stopping the container, whose tmpfs data directory would not survive a container restart).
//   - BULK ROWS / HELD BUILD: as in tests/db/m4-adopt.test.mjs.
// Asserted: after the restart the leftover is reported by readiness (own codes only), adopt refuses, the build refuses
// without --replace-invalid, the replacement drops exactly that index, and adopt + up converge. No other index is touched.
// This file restarts the server. It is run on its own (CI step "Crash durability").
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { connect, freshDatabase, roles } from '../db/helpers.mjs';
import { crash } from '../db/durability-fixtures.mjs';
import { adoptMigration, buildIndexConcurrently, migrateUp } from '../../dist/persistence/migrate.js';
import { checkIndexReadiness } from '../../dist/persistence/readiness.js';

const OWN = /^INDEX_NOT_(VALID|READY|LIVE)$/;
async function at21(t, rows) {
  const db = await freshDatabase(t, 'm4acr', { migrate: false });
  const { admin } = await roles(t, db, ['admin']);
  await migrateUp(admin, { to: 21 });
  await admin.query('BEGIN'); await admin.query('SET LOCAL session_replication_role = replica');            // BULK ROWS
  await admin.query(`INSERT INTO si.observations (run_id, source_id, rights_version_id, ordinal, ad_id, network, native_ad_id, advertiser_name,
                       countries, seen_at, source_url, content_sha256)
    SELECT md5('r' || (g / 500))::uuid, 'crash-src', 1, g % 500, g, 'META', 'native-' || g, 'Synthetic Co', ARRAY['DE'], now(),
           'https://example.test/a', repeat('a', 64) FROM generate_series(0, $1::bigint - 1) g`, [rows]);
  await admin.query('COMMIT');
  await admin.end();
  return db;
}
const others = async c => (await c.query(`SELECT c.relname, i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                                          WHERE c.relnamespace = 'si'::regnamespace AND c.relname <> 'observations_by_ad_fk' ORDER BY 1`)).rows;

async function crashAndRecover(t, db, rows, when) {
  let k = await connect({ database: db });
  const before = await others(k);
  const mig = await connect({ user: 'si_migrator', database: db }); mig.on('error', () => {});
  const held = when === 'wait' ? await connect({ database: db }) : null;                                      // HELD BUILD
  if (held) { held.on('error', () => {}); await held.query('BEGIN ISOLATION LEVEL REPEATABLE READ'); await held.query('SELECT count(*) FROM si.sources'); }
  k.on('error', () => {});
  const build = buildIndexConcurrently(mig, { version: 22 }).then(r => ({ ok: r }), e => ({ err: e.message }));
  let pid;
  for (let i = 0; !pid; i++) {
    const p = (await k.query(`SELECT pid, phase, blocks_done FROM pg_stat_progress_create_index WHERE command = 'CREATE INDEX CONCURRENTLY'`)).rows[0];
    if (p && (when === 'wait' ? /waiting/.test(p.phase) : /building index/.test(p.phase) && Number(p.blocks_done) > 0)) pid = p.pid;
    else if (i > 30000) throw new Error(`the build never reached ${when}`); else await sleep(1);
  }
  await crash(pid);                                                                                           // CRASH
  const b = await build;
  assert.ok(b.err, `the build must fail: ${JSON.stringify(b)}`);
  for (const c of [mig, held, k]) await c?.end().catch(() => {});
  k = await connect({ database: db }); t.after(() => k.end().catch(() => {}));
  assert.equal((await k.query('SELECT count(*)::int AS n FROM si.observations')).rows[0].n, rows, 'committed rows survive the restart');
  const left = (await checkIndexReadiness(k)).map(f => f.code);
  console.log(`# CRASH (${when}) after recovery: build ${b.err.slice(0, 80)}; readiness ${JSON.stringify(left)}`);
  assert.ok(left.length > 0 && left.every(c => OWN.test(c)), JSON.stringify(left));
  const m2 = await connect({ user: 'si_migrator', database: db }); t.after(() => m2.end().catch(() => {}));
  await assert.rejects(adoptMigration(m2, { version: 22 }), e => e.code === 'INDEX_NOT_READY');
  await assert.rejects(buildIndexConcurrently(m2, { version: 22 }), e => e.code === 'INVALID_INDEX_PRESENT');
  const r = await buildIndexConcurrently(m2, { version: 22, replaceInvalid: true });
  assert.deepEqual([r.state, r.replacedInvalid], ['BUILT', true]);
  assert.deepEqual(await others(k), before, 'no other index was touched');
  assert.equal((await adoptMigration(m2, { version: 22 })).state, 'ADOPTED');
  assert.deepEqual(await migrateUp(m2), [23, 24, 25, 26]);
  assert.deepEqual(await checkIndexReadiness(k), []);
}

test('MIG-C1: server restart while the concurrent build waits for older snapshots; recovery by --replace-invalid', { timeout: 600000 }, async t => {
  await crashAndRecover(t, await at21(t, 20000), 20000, 'wait');
});
test('MIG-C2: server restart while the concurrent build scans the table; recovery by --replace-invalid', { timeout: 600000 }, async t => {
  await crashAndRecover(t, await at21(t, 500000), 500000, 'scan');
});

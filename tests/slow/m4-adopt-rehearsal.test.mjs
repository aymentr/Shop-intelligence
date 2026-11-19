// B-002 M4-P3.3 Phase 1 (R-42): rehearsal of the populated adoption of 0022 on a disposable database.
// SI_ADOPT_ROWS synthetic observations (default 1,000,000; BULK ROWS fixture: superuser, replica mode, CHECKs enforced),
// at version 21. While one writer inserts continuously (one row per transaction, lock_timeout 5 s):
//   1. a first CREATE INDEX CONCURRENTLY is cancelled mid-scan (failure), leaving an invalid index;
//   2. build-index --replace-invalid drops exactly that index and rebuilds it (measured);
//   3. adopt records 0022; `up` applies 0023 and 0024; readiness passes.
// Reported: build time, writer latency p50 / p95 / max and lock-wait samples, index size, WAL written during the build.
// With SI_ADOPT_PLAIN=1 (default) the same is measured for 0022's own non-concurrent build in a second database.
// Asserted (CI): the procedure converges; during the concurrent build the writer is never in a lock wait and no insert
// takes 1 s or more. A synthetic rehearsal on a test container is NOT evidence of production-storage performance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { connect, freshDatabase, roles } from '../db/helpers.mjs';
import { adoptMigration, buildIndexConcurrently, migrateUp } from '../../dist/persistence/migrate.js';
import { checkIndexReadiness } from '../../dist/persistence/readiness.js';

const ROWS = Number(process.env.SI_ADOPT_ROWS ?? 1000000), PLAIN = (process.env.SI_ADOPT_PLAIN ?? '1') === '1';
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.ceil(p / 100 * s.length) - 1)] : 0; };

async function populated(t) {
  const db = await freshDatabase(t, 'm4reh', { migrate: false });
  const { admin } = await roles(t, db, ['admin']);
  await migrateUp(admin, { to: 21 });
  const t0 = performance.now();
  for (let from = 0; from < ROWS; from += 1000000) {
    const n = Math.min(1000000, ROWS - from);
    await admin.query('BEGIN'); await admin.query('SET LOCAL session_replication_role = replica');
    await admin.query(`INSERT INTO si.observations (run_id, source_id, rights_version_id, ordinal, ad_id, network, native_ad_id, advertiser_name,
                         countries, seen_at, source_url, content_sha256)
      SELECT md5('r' || (g / 500))::uuid, 'reh-src', 1, g % 500, g, 'META', 'native-' || g, 'Synthetic Co ' || (g % 997), ARRAY['DE'],
             now(), 'https://example.test/a', repeat('a', 64) FROM generate_series($1::bigint, $2::bigint - 1) g`, [from, from + n]);
    await admin.query('COMMIT');
  }
  await admin.query('VACUUM (ANALYZE, PARALLEL 0) si.observations');   // no parallel vacuum: its DSM segment exceeds a 64 MB /dev/shm
  const size = (await admin.query(`SELECT pg_size_pretty(pg_total_relation_size('si.observations')) AS s`)).rows[0].s;
  console.log(`# REH ${ROWS} rows loaded in ${((performance.now() - t0) / 1000).toFixed(0)} s; si.observations total ${size}`);
  const conn = async user => { const k = await connect({ user, database: db }); t.after(() => k.end().catch(() => {})); return k; };
  return { db, admin, conn };
}
/** One writer, one row per transaction, until stop(); latency and lock-wait samples. */
async function writer(x) {
  const w = await x.conn(undefined), wpid = (await w.query('SELECT pg_backend_pid() AS p')).rows[0].p;
  const lat = [], errors = []; let lockSamples = 0, samples = 0, run = true, i = 0;
  const loop = (async () => { while (run) {
    const t0 = performance.now();
    try {
      await w.query('BEGIN'); await w.query('SET LOCAL session_replication_role = replica'); await w.query(`SET LOCAL lock_timeout = '5s'`);
      await w.query(`INSERT INTO si.observations (run_id, source_id, rights_version_id, ordinal, ad_id, network, native_ad_id, advertiser_name,
                       countries, seen_at, source_url, content_sha256)
                     VALUES (gen_random_uuid(), 'reh-src', 1, 0, $1, 'META', $2, 'W', ARRAY['DE'], now(), 'https://example.test/a', repeat('a', 64))`,
                     [5000000000 + i, `w-${i}`]);
      await w.query('COMMIT'); lat.push(performance.now() - t0);
    } catch (e) { errors.push(e.code ?? e.message); await w.query('ROLLBACK').catch(() => {}); }
    i++; await sleep(2);
  } })();
  const sampler = (async () => { while (run) {
    const r = (await x.admin.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [wpid])).rows[0];
    samples++; if (r?.wait_event_type === 'Lock') lockSamples++; await sleep(5);
  } })();
  return { stop: async () => { run = false; await loop; await sampler; return { lat, errors, lockSamples, samples }; } };
}
const report = (label, ms, w, extra = '') => console.log(`# REH ${ROWS} ${label}: ${ms.toFixed(0)} ms; writer ${w.lat.length} inserts p50 ${pct(w.lat, 50).toFixed(1)} / p95 ${pct(w.lat, 95).toFixed(1)} / max ${Math.max(0, ...w.lat).toFixed(1)} ms, lock-wait samples ${w.lockSamples}/${w.samples}, errors ${JSON.stringify(w.errors)}${extra}`);
const walBytes = async (admin, from) => Number((await admin.query(`SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(), $1::pg_lsn)::bigint AS b`, [from])).rows[0].b);
const lsn = async admin => (await admin.query('SELECT pg_current_wal_insert_lsn()::text AS l')).rows[0].l;

test(`REH: populated adoption of 0022 at ${ROWS} observations (failure, retry, adopt, up), with a concurrent writer`, { timeout: 4 * 3600 * 1000 }, async t => {
  const x = await populated(t);
  const mig = await x.conn('si_migrator');
  // 1. A first build, cancelled once it is scanning the table.
  const w1 = await writer(x);
  const first = buildIndexConcurrently(mig, { version: 22 }).then(r => ({ ok: r }), e => ({ err: e.message }));
  for (let i = 0; ; i++) {
    const p = (await x.admin.query(`SELECT pid, phase, blocks_done FROM pg_stat_progress_create_index`)).rows[0];
    if (p && /building index/.test(p.phase) && Number(p.blocks_done) > 0) { await x.admin.query('SELECT pg_cancel_backend($1)', [p.pid]); break; }
    if (i > 20000) throw new Error('the first build never started scanning');
    await sleep(1);
  }
  const f = await first;
  const wf = await w1.stop();
  const left = (await checkIndexReadiness(x.admin)).map(z => z.code);
  console.log(`# REH ${ROWS} cancelled first build: ${f.err ? f.err.slice(0, 90) : JSON.stringify(f.ok)}; readiness ${JSON.stringify(left)}`);
  assert.ok(f.err && left.length > 0 && left.every(c => /^INDEX_NOT_(VALID|READY|LIVE)$/.test(c)), JSON.stringify([f, left]));
  await assert.rejects(adoptMigration(mig, { version: 22 }), /INDEX_NOT_READY/);
  void wf;
  // 2. The replacement build, measured.
  const mig2 = await x.conn('si_migrator');
  const w2 = await writer(x);
  const wal0 = await lsn(x.admin);
  const b = await buildIndexConcurrently(mig2, { version: 22, replaceInvalid: true });
  const wal = await walBytes(x.admin, wal0);
  const ws = await w2.stop();
  const ix = (await x.admin.query(`SELECT pg_size_pretty(pg_relation_size('si.observations_by_ad_fk')) AS s, pg_relation_size('si.observations_by_ad_fk') AS b`)).rows[0];
  report('CONCURRENT build (replace-invalid)', b.ms, ws, `; index ${ix.s}; WAL during the build ${(wal / 1048576).toFixed(1)} MB`);
  assert.deepEqual([b.state, b.replacedInvalid], ['BUILT', true]);
  assert.equal(ws.lockSamples, 0, 'the writer never waited on a lock during the concurrent build');
  assert.ok(Math.max(0, ...ws.lat) < 1000, 'no insert took 1 s or more during the concurrent build');
  assert.deepEqual(ws.errors, []);
  // 3. Adopt, up, readiness.
  const t3 = performance.now(); const a = await adoptMigration(mig2, { version: 22 }); const adoptMs = performance.now() - t3;
  const t4 = performance.now(); const up = await migrateUp(mig2); const upMs = performance.now() - t4;
  console.log(`# REH ${ROWS} adopt ${a.state} in ${adoptMs.toFixed(0)} ms; up ${JSON.stringify(up)} in ${upMs.toFixed(0)} ms`);
  assert.equal(a.state, 'ADOPTED'); assert.deepEqual(up, [23, 24, 25, 26]);
  assert.deepEqual(await checkIndexReadiness(x.admin), []);
  // Comparison: 0022's own non-concurrent build under the same writer.
  if (PLAIN) {
    const y = await populated(t);
    const w3 = await writer(y);
    const t5 = performance.now(); await migrateUp(await y.conn('si_migrator'), { to: 22 }); const plainMs = performance.now() - t5;
    report('PLAIN 0022 build (migrator transaction)', plainMs, await w3.stop());
  }
});

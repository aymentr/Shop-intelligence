// B-002 M4-P3.3-P1-OPS-01 (docs §17.5): command-scoped tolerance of UNRELATED invalid index artifacts by the production
// gate. Only `retention purge` and the read-only status commands may proceed past such an artifact, with an explicit
// warning, and only when the artifact cannot matter to them; every failure of observations_by_ad_fk, every invalid
// schema index and every other gate check still blocks; every other production command stays strict.
// Real disposable PostgreSQL 16, synthetic data, the production CLI (SI_PRODUCTION=1) run as the documented logins.
// Fixtures a product path cannot perform, labelled where used:
//   - HARDENING: db/bootstrap/optional/advisory-lock-hardening.sql applied by the test superuser (the gate requires it).
//   - AGED RUNS: the superuser moves retain_until into the past (replica mode) so runs are due now.
//   - CATALOG FLAG: the superuser sets pg_index flags (single-flag states, e.g. an invalid NOT READY artifact).
//   - HELD BUILD: a REPEATABLE READ snapshot keeps a real CREATE INDEX CONCURRENTLY / REINDEX CONCURRENTLY in its snapshot
//     wait, where it is cancelled: the leftover is a REAL invalid, ready index.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { asOwner, cfg, connect, createSources, freshDatabase, recordRights, roles } from './helpers.mjs';
import { fixtureSha256, requestSha256 } from '../../dist/persistence/request-hash.js';
import { SCHEMA_INDEXES } from '../../dist/persistence/readiness.js';
import { adoptMigration, buildIndexConcurrently, loadMigrations, migrateUp } from '../../dist/persistence/migrate.js';

const CLI = fileURLToPath(new URL('../../dist/persistence/cli.js', import.meta.url));
const HARDENING = readFileSync(new URL('../../db/bootstrap/optional/advisory-lock-hardening.sql', import.meta.url), 'utf8');
const IX = 'si.observations_by_ad_fk';
const ROW = (id, title = 't') => ({ network: 'META', nativeAdId: id, advertiserName: 'Synthetic Co', countries: ['DE'],
  seenAt: '2026-01-01T00:00:00.000Z', sourceUrl: 'https://example.test/a', title });
let n = 0;

async function collect(c, src, rows) {
  const fx = fixtureSha256(rows), key = `ops${++n}`;
  const sha = requestSha256({ adapterId: src, evidenceKind: 'SYNTHETIC', networks: ['META'], fixtureSha256: fx });
  const run = (await c.query('SELECT * FROM si.si_begin_run_scoped($1,$2,$3,$4,$5::text[],$6)', [src, key, sha, 'SYNTHETIC', ['META'], fx])).rows[0];
  await c.query('BEGIN');
  const r = (await c.query('SELECT * FROM si.si_complete_run($1::uuid, $2::uuid, $3::jsonb)', [run.run_id, run.lease_token, JSON.stringify(rows)])).rows[0];
  await c.query('COMMIT');
  assert.equal(r.outcome, 'COMPLETED');
  return run.run_id;
}

/** A hardened version-23 database with `due` aged runs of 50 observations each on source A, and a second source B. */
async function world(t, { due = 3 } = {}) {
  const db = await freshDatabase(t, 'm4ops');
  const x = await roles(t, db, ['admin', 'si_rights_admin', 'si_collector']);
  const [a, b] = [`opsa-${++n}`, `opsb-${++n}`];
  await createSources(x.admin, [a, b], ['META', 'TIKTOK']);
  for (const s of [a, b]) await recordRights(x.si_rights_admin, s, {});
  const ids = [];
  for (let r = 0; r < due; r++) ids.push(await collect(x.si_collector, a, Array.from({ length: 50 }, (_, k) => ROW(`${a}-${r}-${k}`))));
  await x.admin.query('BEGIN'); await x.admin.query('SET LOCAL session_replication_role = replica');              // AGED RUNS
  await x.admin.query(`UPDATE si.collection_runs SET retain_until = clock_timestamp() - interval '10 minutes' WHERE run_id = ANY ($1::uuid[])`, [ids]);
  await x.admin.query('COMMIT');
  await x.admin.query(HARDENING);                                                                                 // HARDENING
  const conn = async u => { const k = await connect({ user: u, database: db }); k.on('error', () => {}); t.after(() => k.end().catch(() => {})); return k; };
  return { db, ...x, a, b, ids, conn };
}
const url = (db, user) => user ? `postgres://${user}:${encodeURIComponent(cfg.rolePassword)}@${cfg.host}:${cfg.port}/${db}`
                               : `postgres://${cfg.adminUser}:${encodeURIComponent(cfg.adminPassword)}@${cfg.host}:${cfg.port}/${db}`;
/** The production CLI (SI_PRODUCTION=1) as `user`, with a collector session for the gate unless `collector: false`. */
function prod(db, user, args, { collector = true } = {}) {
  const env = { ...process.env, SI_PRODUCTION: '1', SI_DATABASE_URL: url(db, user) };
  if (collector) env.SI_COLLECTOR_DATABASE_URL = url(db, 'si_collector'); else delete env.SI_COLLECTOR_DATABASE_URL;
  const t0 = performance.now();
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });
  return { status: r.status, out: r.stdout, err: r.stderr, ms: performance.now() - t0,
           warns: r.stderr.split('\n').filter(l => l.startsWith('WARN PRODUCTION_PREFLIGHT_TOLERATED: ')) };
}
const purged = async x => Number((await x.admin.query(`SELECT count(*) AS n FROM si.collection_runs WHERE run_id = ANY ($1::uuid[]) AND retention_state = 'PURGED'`, [x.ids])).rows[0].n);
const flag = (x, name, cols) => x.admin.query(`UPDATE pg_catalog.pg_index SET ${cols} WHERE indexrelid = 'si.${name}'::regclass`);   // CATALOG FLAG
/** An unrelated invalid artifact that is NOT READY (never maintained). */
async function notReady(x, name, on = 'si.ads (native_ad_id)') {
  await asOwner(x.admin, a => a.query(`CREATE INDEX ${name} ON ${on}`));
  await flag(x, name, 'indisvalid = false, indisready = false');
}
/** HELD BUILD: run `ddl` (a concurrent build) as the owner, cancel it in its snapshot wait; returns the leftover's flags. */
async function cancelledConcurrently(x, ddl, leftover) {
  const h = await x.conn(undefined); await h.query('BEGIN ISOLATION LEVEL REPEATABLE READ'); await h.query('SELECT 1 FROM si.sources LIMIT 1');
  const own = await x.conn(undefined); await own.query('SET ROLE si_owner');
  const p = own.query(ddl).then(() => 'completed', e => e.code);
  for (let i = 0; ; i++) {
    const r = (await x.admin.query(`SELECT pid, phase FROM pg_stat_progress_create_index`)).rows[0];
    if (r && /waiting for old snapshots/.test(r.phase)) { await x.admin.query('SELECT pg_cancel_backend($1)', [r.pid]); break; }
    assert.ok(i < 6000, 'the concurrent build reached its snapshot wait'); await sleep(5);
  }
  assert.equal(await p, '57014');
  await h.query('ROLLBACK');
  return (await x.admin.query(`SELECT indisvalid AS v, indisready AS r FROM pg_index WHERE indexrelid = 'si.${leftover}'::regclass`)).rows[0];
}
const refusedStrict = (r, re) => { assert.equal(r.status, 1, r.out + r.err); assert.equal(r.out, ''); assert.match(r.err, /PRODUCTION_PREFLIGHT_FAILED: /); if (re) assert.match(r.err, re); };
const refusedRetention = (r, re) => {
  assert.equal(r.status, 1, r.out + r.err); assert.equal(r.out, '');
  assert.match(r.err, /^RETENTION_FAILED code=PRECONDITION sqlstate=none recorded=false$/m);
  assert.doesNotMatch(r.err, /code=CONNECTION/);
  assert.match(r.err, /^PRODUCTION_PREFLIGHT_FAILED: /m); if (re) assert.match(r.err, re);
};

test('OPS-0: SCHEMA_INDEXES equals the migrated catalog (plus the adoption log); the diagnostic functions are read-only', async t => {
  const db = await freshDatabase(t, 'm4ops0', { migrate: false });
  const { admin } = await roles(t, db, ['admin']);
  await migrateUp(admin, { to: 21 });
  const mig = await connect({ user: 'si_migrator', database: db }); t.after(() => mig.end());
  await buildIndexConcurrently(mig, { version: 22 }); await adoptMigration(mig, { version: 22 }); await migrateUp(mig);
  const names = (await admin.query(`SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                                     WHERE c.relnamespace = 'si'::regnamespace ORDER BY 1`)).rows.map(r => r.relname);
  assert.deepEqual(names, [...SCHEMA_INDEXES].sort(), 'every schema index of 0001-0024 and of the adoption log, and nothing else');
  const vol = (await admin.query(`SELECT p.proname, p.provolatile FROM pg_proc p WHERE p.pronamespace = 'si'::regnamespace
      AND p.proname IN ('si_retention_status', 'si_purge_failures', 'si_verification_status', 'si_verification_failures') ORDER BY 1`)).rows;
  assert.deepEqual(vol.map(r => `${r.proname}:${r.provolatile}`),
    ['si_purge_failures:s', 'si_retention_status:s', 'si_verification_failures:s', 'si_verification_status:s'], 'diagnostics call STABLE functions only');
});

test('OPS-1: healthy database: production purge (si_retention) and diagnostics run with no warning', async t => {
  const x = await world(t);
  const s = prod(x.db, 'si_monitor', ['status']);
  assert.equal(s.status, 0, s.err); assert.deepEqual(s.warns, []);
  const r = prod(x.db, 'si_retention', ['retention', 'purge', '--limit', '20']);
  assert.equal(r.status, 0, r.err); assert.deepEqual(r.warns, []);
  assert.match(r.out, /"outcome":"PURGED".*"runsPurged":3/);
  assert.equal(await purged(x), 3);
});

test('OPS-2: one unrelated NOT READY artifact: purge and diagnostics proceed with a warning; every other production command is refused', async t => {
  const x = await world(t);
  await notReady(x, 'ops_scratch');
  const w = /^WARN PRODUCTION_PREFLIGHT_TOLERATED: index_readiness_observations_by_ad_fk: INVALID_INDEX_ARTIFACT:ops_scratch on ads \(/;
  for (const [user, args] of [['si_monitor', ['status']], ['si_monitor', ['readiness']], ['si_retention', ['retention', 'status']],
                              ['si_retention', ['retention', 'overdue']], ['si_retention', ['retention', 'failures']],
                              ['si_monitor', ['verification', 'status']], ['si_monitor', ['verification', 'failures']]]) {
    const r = prod(x.db, user, args);
    assert.ok(r.status === 0 || (args[1] === 'overdue' && r.status === 2) || (args[1] === 'status' && args[0] === 'verification' && r.status === 2) || args[0] === 'readiness',
      `${args.join(' ')}: ${r.status} ${r.err}`);
    assert.equal(r.warns.length, 1, `${args.join(' ')} warns: ${r.err}`); assert.match(r.warns[0], w);
    assert.match(r.warns[0], /scope diagnostic\)$/);
  }
  const p = prod(x.db, 'si_retention', ['retention', 'purge', '--limit', '20']);
  assert.equal(p.status, 0, p.err); assert.match(p.out, /"outcome":"PURGED"/);
  assert.equal(p.warns.length, 1); assert.match(p.warns[0], /ops_scratch on ads \(not a schema index; not ready: never maintained; scope purge\)$/);
  // normal and deployment commands stay strict
  for (const [user, args] of [[undefined, ['up']], ['si_migrator', ['up']], ['si_migrator', ['adopt', '--version', '22']],
                              ['si_migrator', ['build-index', '--version', '22']], ['si_monitor', ['verification', 'run']],
                              [undefined, ['preflight', '--production']], [undefined, ['down', '--to', '22', '--allow-destructive']]]) {
    const r = prod(x.db, user, args);
    refusedStrict(r, /index_readiness_observations_by_ad_fk=INVALID_INDEX_ARTIFACT:ops_scratch/);
    assert.deepEqual(r.warns, [], 'no tolerance outside purge and diagnostics');
  }
  assert.equal(Number((await x.admin.query('SELECT max(version) AS v FROM si.schema_migrations')).rows[0].v), loadMigrations().at(-1).version, 'down was not dispatched');
});

test('OPS-3: several tolerable artifacts (not ready, and a REAL REINDEX CONCURRENTLY leftover with an identical twin): purge correct, one warning each', async t => {
  const x = await world(t, { due: 4 });
  await notReady(x, 'ops_a');
  await notReady(x, 'ops_b', 'si.collection_runs (finished_at)');
  const f = await cancelledConcurrently(x, 'REINDEX INDEX CONCURRENTLY si.purge_log_run_id_key', 'purge_log_run_id_key_ccnew');   // HELD BUILD
  assert.deepEqual(f, { v: false, r: true }, 'a real ready, invalid, UNIQUE leftover on a table the purge writes');
  const r = prod(x.db, 'si_retention', ['retention', 'purge', '--limit', '20']);
  assert.equal(r.status, 0, r.err); assert.match(r.out, /"runsPurged":4/);
  assert.deepEqual(r.warns.map(l => l.match(/INVALID_INDEX_ARTIFACT:(\S+)/)[1]).sort(), ['ops_a', 'ops_b', 'purge_log_run_id_key_ccnew']);
  assert.match(r.warns.find(l => l.includes('_ccnew')), /identical valid twin; scope purge\)$/);
  assert.equal(await purged(x), 4);
  assert.equal(Number((await x.admin.query('SELECT count(*) AS n FROM si.purge_log WHERE run_id = ANY ($1::uuid[]) AND NOT late', [x.ids])).rows[0].n), 4);
});

test('OPS-4: a READY unrelated artifact without a twin can break the purge; the purge is refused (PRECONDITION), diagnostics warn', async t => {
  const x = await world(t, { due: 2 });
  const f = await cancelledConcurrently(x, 'CREATE UNIQUE INDEX CONCURRENTLY ops_uq ON si.purge_log (source_id)', 'ops_uq');      // HELD BUILD
  assert.deepEqual(f, { v: false, r: true });
  // runtime relevance: the invalid index is still maintained and enforces uniqueness on the purge's own INSERT
  const ret = await x.conn('si_retention');
  await ret.query('BEGIN');
  const direct = await ret.query('SELECT * FROM si.si_purge_due(20)').then(() => 'purged', e => e.code);
  await ret.query('ROLLBACK');
  assert.equal(direct, '23505', 'two runs of one source: unique violation from an INVALID index');
  const r = prod(x.db, 'si_retention', ['retention', 'purge', '--limit', '20']);
  refusedRetention(r, /index_readiness_observations_by_ad_fk=INVALID_INDEX_ARTIFACT:ops_uq/);
  assert.equal(await purged(x), 0);
  const s = prod(x.db, 'si_monitor', ['status']);
  assert.equal(s.status, 0, s.err); assert.match(s.warns.join('\n'), /ops_uq on purge_log \(not a schema index; read-only command; scope diagnostic\)/);
});

test('OPS-5: an invalid SCHEMA index (unrelated to 0022) blocks the purge and the diagnostics', async t => {
  const x = await world(t);
  await flag(x, 'runs_retention', 'indisvalid = false');
  refusedRetention(prod(x.db, 'si_retention', ['retention', 'purge']), /INVALID_INDEX_ARTIFACT:runs_retention/);
  refusedStrict(prod(x.db, 'si_monitor', ['status']), /INVALID_INDEX_ARTIFACT:runs_retention/);
  assert.equal(await purged(x), 0);
});

test('OPS-6: every failure of observations_by_ad_fk blocks purge and diagnostics, also beside tolerable artifacts', async t => {
  const cases = [
    ['invalid', x => flag(x, 'observations_by_ad_fk', 'indisvalid = false'), /INDEX_NOT_VALID:si\.observations_by_ad_fk/],
    ['not ready', x => flag(x, 'observations_by_ad_fk', 'indisready = false'), /INDEX_NOT_READY:si\.observations_by_ad_fk/],
    ['missing', x => asOwner(x.admin, a => a.query(`DROP INDEX ${IX}`)), /INDEX_MISSING:si\.observations_by_ad_fk/],
    ['wrong definition', x => asOwner(x.admin, async a => { await a.query(`DROP INDEX ${IX}`);
       await a.query('CREATE INDEX observations_by_ad_fk ON si.observations (source_id, ad_id, network, native_ad_id)'); }), /INDEX_WRONG_KEY:si\.observations_by_ad_fk/],
  ];
  for (const [name, fault, re] of cases) {
    const x = await world(t, { due: 1 });
    await notReady(x, 'ops_side');
    await fault(x);
    const p = prod(x.db, 'si_retention', ['retention', 'purge']);
    refusedRetention(p, re);
    refusedStrict(prod(x.db, 'si_monitor', ['status']), re);
    assert.equal(await purged(x), 0, name);
  }
});

test('OPS-7: another production-readiness failure (no collector session) still refuses the purge, reported as PRECONDITION', async t => {
  const x = await world(t, { due: 1 });
  await notReady(x, 'ops_c');
  const r = prod(x.db, 'si_retention', ['retention', 'purge'], { collector: false });
  refusedRetention(r, /collector_session=missing/);
  assert.equal(await purged(x), 0);
});

test('OPS-8: tolerance grants no authority: an unauthorized login cannot purge', async t => {
  const x = await world(t, { due: 1 });
  await notReady(x, 'ops_d');
  for (const user of ['si_monitor', 'si_collector']) {
    const r = prod(x.db, user, ['retention', 'purge']);
    assert.equal(r.status, 1); assert.match(r.err, /^RETENTION_FAILED code=PRIVILEGE sqlstate=42501 recorded=false$/m, `${user}: ${r.err}`);
  }
  assert.equal(await purged(x), 0);
});

test('OPS-9: purge under contention with tolerated artifacts: deadlines kept, bounded latency, collector unaffected', async t => {
  const x = await world(t, { due: 10 });
  await notReady(x, 'ops_e'); await notReady(x, 'ops_f', 'si.observations (seen_at)');
  const col = await x.conn('si_collector');
  let running = true, collected = 0;
  const bg = (async () => { while (running) { await collect(col, x.b, Array.from({ length: 50 }, (_, k) => ROW(`${x.b}-${collected}-${k}`))); collected++; } })();
  await sleep(200);
  const r = prod(x.db, 'si_retention', ['retention', 'purge', '--limit', '20']);
  running = false; await bg;
  assert.equal(r.status, 0, r.err); assert.match(r.out, /"runsPurged":10/); assert.match(r.out, /"lateRuns":0/);
  assert.equal(r.warns.length, 2);
  const log = (await x.admin.query(`SELECT count(*)::int n, bool_or(late) late, max(purged_at - due_by) < interval '0' AS early
                                     FROM si.purge_log WHERE run_id = ANY ($1::uuid[])`, [x.ids])).rows[0];
  assert.deepEqual(log, { n: 10, late: false, early: true });
  assert.ok(collected > 0, 'the collector completed runs during the purge');
  assert.ok(r.ms < 5000, `production purge command (gate + purge) ${r.ms.toFixed(0)} ms`);
  console.log(`# OPS-9 production purge command with 2 tolerated artifacts: ${r.ms.toFixed(0)} ms for 10 runs x 50 observations; collector runs meanwhile ${collected}`);
});

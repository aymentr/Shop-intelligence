// B-002 M4-P3.1: cost of the advertiser summaries (migration 0020). One synthetic source per layout, built through the
// product write path. Publications ALTERNATE between the 0020 si_complete_run (with summaries) and the 0005 text (bench
// fixture: si.zz_complete_run_nosum, the summary commit check disabled), so both are measured on the same growing data;
// the runs published without summaries are then backfilled (backfill duration).
//
//   node tests/db/run.mjs tests/slow/m4-summaries-bench.test.mjs
//   SI_SB_LAYOUTS=obs5k,obs50k,obs200k,obs1m,runs10k,runs30k,ids500,ids100k  (full measurement; long; obs1m needs shm 1 GB)
//
// Reported per layout: publication p50/p95 with and without summaries and the overhead; WAL bytes per publication
// (write amplification); storage of summaries + dictionary + status (with indexes and TOAST) relative to the observation
// table (with its indexes and TOAST); backfill, verification and rebuild durations; purge time per run with and without
// the summary trigger; temporary-file bytes; the collector backend's peak RSS. R-37 is reported, not hidden: the first
// R37_RUNS publications of the runs layouts use ONE persistent collector session (per-500 medians); afterwards the bench
// reconnects every 500 runs (documented workaround), and the report says so.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { asOwner, cfg, connect, createSources, freshDatabase, recordRights, roles } from '../db/helpers.mjs';
import { fixtureSha256, requestSha256 } from '../../dist/persistence/request-hash.js';

const ALL = {
  obs5k: { runs: 10, per: 500, ids: 500 }, obs50k: { runs: 100, per: 500, ids: 500 }, obs200k: { runs: 400, per: 500, ids: 500 },
  obs1m: { runs: 2000, per: 500, ids: 500 }, runs10k: { runs: 10000, per: 10, ids: 500 }, runs30k: { runs: 30000, per: 10, ids: 500 },
  ids500: { runs: 400, per: 500, ids: 500 }, ids100k: { runs: 400, per: 500, ids: 100000 }, ids100kq: { runs: 60, per: 500, ids: 100000 }, conc50: { runs: 400, per: 500, ids: 50 },
};
const LAYOUTS = (process.env.SI_SB_LAYOUTS ?? 'obs5k,obs50k,runs10k').split(',');
const R37_RUNS = Number(process.env.SI_SB_R37_RUNS ?? 3000);
const SRC = 'sb-a';
const M5 = readFileSync(new URL('../../db/migrations/0005_evidence.up.sql', import.meta.url), 'utf8');
const NOSUM = (() => { const a = M5.indexOf('CREATE OR REPLACE FUNCTION si.si_complete_run'); const e = 'END $run_complete$;';
  return M5.slice(a, M5.indexOf(e, a) + e.length).replace('FUNCTION si.si_complete_run(', 'FUNCTION si.zz_complete_run_nosum('); })();
const pct = (a, p) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(p / 100 * s.length) - 1)]; };
const med = a => pct(a, 50);
const MB = b => (Number(b) / 1048576).toFixed(1);
const container = () => execFileSync('docker', ['compose', 'ps', '-q', 'db'], { encoding: 'utf8' }).trim();
async function vmhwm(c) {
  const pid = (await c.query('SELECT pg_backend_pid() AS p')).rows[0].p;
  try { return Number(/VmHWM:\s+(\d+)/.exec(execFileSync('docker', ['exec', container(), 'cat', `/proc/${pid}/status`], { encoding: 'utf8' }))[1]) / 1024; } catch { return NaN; }
}
const lsn = async c => BigInt((await c.query(`SELECT (pg_current_wal_insert_lsn() - '0/0'::pg_lsn)::bigint::text AS b`)).rows[0].b);
const sizes = async c => (await c.query(`SELECT
    pg_total_relation_size('si.observations') AS obs,
    pg_total_relation_size('si.run_advertiser_summaries') AS sums, pg_total_relation_size('si.advertiser_identities') AS ids,
    pg_total_relation_size('si.run_summary_status') AS st,
    (SELECT count(*) FROM si.observations) AS nobs, (SELECT count(*) FROM si.run_advertiser_summaries) AS nsums,
    (SELECT count(*) FROM si.advertiser_identities) AS nids`)).rows[0];

let n = 0;
function rowsFor(k, per, ids) {
  return Array.from({ length: per }, (_, i) => ({ network: i % 3 === 1 ? 'TIKTOK' : 'META', nativeAdId: `r${k}o${i}`,
    advertiserName: `Advertiser ${String(((k * per + i) * 7919) % ids).padStart(6, '0')} Synthetic`, countries: ['DE'],
    seenAt: '2026-01-01T00:00:00.000Z', sourceUrl: `https://example.test/r${k}o${i}`, destinationUrl: 'https://example.test/d',
    creativeUrl: 'https://example.test/c', title: `Synthetic ${k}` }));
}

test('SB: advertiser summary cost — publication, storage, backfill, rebuild, purge', { timeout: 8 * 3600 * 1000 }, async t => {
  const results = [];
  for (const name of LAYOUTS) {
    const L = ALL[name]; assert.ok(L, `layout ${name}`);
    const db = await freshDatabase(t, 'm4sb');
    const ROLES = ['admin', 'si_rights_admin', 'si_collector', 'si_monitor', 'si_retention'];
    const x = await roles(t, db, ROLES);
    await x.admin.query(`DO $$ DECLARE r record; BEGIN FOR r IN SELECT c.oid::regclass AS t FROM pg_class c WHERE c.relnamespace = 'si'::regnamespace AND c.relkind = 'r' LOOP
                           EXECUTE format('ALTER TABLE %s SET (autovacuum_enabled = off)', r.t); END LOOP; END $$`);
    await asOwner(x.admin, async a => { await a.query(NOSUM); await a.query('GRANT EXECUTE ON FUNCTION si.zz_complete_run_nosum(uuid, uuid, jsonb) TO si_collector');
      await a.query('ALTER TABLE si.collection_runs DISABLE TRIGGER trg_runs_summary_check'); });
    await createSources(x.admin, [SRC], ['META', 'TIKTOK']); await recordRights(x.si_rights_admin, SRC, { retention_days: 3650 });
    const tb0 = Number((await x.admin.query('SELECT temp_bytes FROM pg_stat_database WHERE datname = current_database()')).rows[0].temp_bytes);
    const ms = { sum: [], nosum: [] }, wal = { sum: [], nosum: [] }, r37 = [];
    let col = x.si_collector, sessionRuns = 0, reconnects = 0;
    const tBuild = performance.now();
    for (let k = 0; k < L.runs; k++) {
      const persistent = L.per === 10 && k < R37_RUNS;
      if (!persistent && sessionRuns >= 500) { await col.end(); col = await connect({ user: 'si_collector', database: db }); sessionRuns = 0; reconnects++; }
      const rows = rowsFor(k, L.per, L.ids);
      const fx = fixtureSha256(rows), sha = requestSha256({ adapterId: SRC, evidenceKind: 'SYNTHETIC', networks: ['META', 'TIKTOK'], fixtureSha256: fx });
      const run = (await col.query('SELECT * FROM si.si_begin_run_scoped($1,$2,$3,$4,$5::text[],$6)', [SRC, `sb${++n}`, sha, 'SYNTHETIC', ['META', 'TIKTOK'], fx])).rows[0];
      const mode = k % 2 === 0 ? 'sum' : 'nosum';
      const w0 = await lsn(x.admin), t0 = performance.now();
      await col.query('BEGIN');
      await col.query(`SELECT * FROM si.${mode === 'sum' ? 'si_complete_run' : 'zz_complete_run_nosum'}($1::uuid, $2::uuid, $3::jsonb)`, [run.run_id, run.lease_token, JSON.stringify(rows)]);
      await col.query('COMMIT');
      const dt = performance.now() - t0; ms[mode].push(dt); wal[mode].push(Number((await lsn(x.admin)) - w0));
      if (persistent) r37.push(dt);
      sessionRuns++;
      if (k % 500 === 499 || k === L.runs - 1) for (let i = 0; i < 20; i++) { const r = await x.si_monitor.query('SELECT * FROM si.si_verify_receipts(500)'); if (!r.rows.length || Number(r.rows[0].verified) === 0) break; }
    }
    const buildS = (performance.now() - tBuild) / 1000;
    const tempNow = async () => Number((await x.admin.query('SELECT pg_stat_force_next_flush(), temp_bytes FROM pg_stat_database WHERE datname = current_database()')).rows[0].temp_bytes);
    await new Promise(r => setTimeout(r, 700)); const tbBuild = await tempNow();
    const hwm = await vmhwm(col);
    if (col !== x.si_collector) await col.end().catch(() => {});
    await asOwner(x.admin, a => a.query('ALTER TABLE si.collection_runs ENABLE TRIGGER trg_runs_summary_check'));
    // Backfill the runs published without summaries.
    const owner = await connect({ database: db }); t.after(() => owner.end().catch(() => {}));
    if (process.env.SI_SB_LOGTEMP) await owner.query('SET log_temp_files = 0');   // diagnostic: name the statement that spills
    await owner.query('SET ROLE si_owner');
    const tBf = performance.now(); let bf = 0;
    for (;;) { const r = (await owner.query('SELECT * FROM si.si_backfill_summaries(200)')).rows[0]; bf += r.summarized; if (r.remaining === 0) break; }
    const backfillS = (performance.now() - tBf) / 1000;
    await owner.query('SELECT pg_stat_force_next_flush()'); await new Promise(r => setTimeout(r, 700)); const tbBackfill = await tempNow();
    const tb1 = Number((await x.admin.query('SELECT temp_bytes FROM pg_stat_database WHERE datname = current_database()')).rows[0].temp_bytes);
    await x.admin.query('VACUUM ANALYZE si.observations, si.run_advertiser_summaries, si.advertiser_identities, si.run_summary_status');
    const sz = await sizes(x.admin);
    // Verification and rebuild of the whole source.
    const tV = performance.now(); const findings = (await owner.query(`SELECT count(*)::int AS n FROM si.si_verify_summaries($1)`, [SRC])).rows[0].n; const verifyS = (performance.now() - tV) / 1000;
    assert.equal(findings, 0, 'verification clean');
    await owner.query('SELECT pg_stat_force_next_flush()'); await new Promise(r => setTimeout(r, 700)); const tbVerify = await tempNow();
    await owner.query(`INSERT INTO si.summary_events (source_id, run_id, kind, finding) VALUES ($1, NULL, 'DRIFT_DETECTED', 'MISSING')`, [SRC]);  // bench fixture: open drift to allow a rebuild
    const runIds = (await owner.query(`SELECT run_id FROM si.run_summary_status ORDER BY run_id LIMIT 200`)).rows.map(r => r.run_id);
    const tR = performance.now();
    for (const r of runIds) await owner.query('SELECT si.si_rebuild_run_summaries($1)', [r]);
    const rebuildPerRun = (performance.now() - tR) / runIds.length;
    await owner.query(`SELECT * FROM si.si_verify_summaries($1)`, [SRC]);       // clears the drift
    // Purge: 20 runs with the summary trigger, 20 without (bench fixture), same layout.
    const purgeTime = async (on) => {
      if (!on) await asOwner(x.admin, a => a.query('ALTER TABLE si.collection_runs DISABLE TRIGGER trg_runs_purge_summaries'));
      const ids = (await x.admin.query(`SELECT run_id FROM si.collection_runs WHERE source_id = $1 AND retention_state = 'RETAINED' ORDER BY run_id ${on ? 'ASC' : 'DESC'} LIMIT 20`, [SRC])).rows.map(r => r.run_id);
      await x.admin.query('BEGIN'); await x.admin.query('SET LOCAL session_replication_role = replica');
      await x.admin.query(`UPDATE si.collection_runs SET retain_until = clock_timestamp() - interval '1 minute' WHERE run_id = ANY ($1)`, [ids]);
      await x.admin.query('COMMIT');
      const t0 = performance.now(); const p = (await x.si_retention.query('SELECT * FROM si.si_purge_due(20)')).rows[0];
      const dt = (performance.now() - t0) / p.runs_purged;
      if (!on) await asOwner(x.admin, a => a.query('ALTER TABLE si.collection_runs ENABLE TRIGGER trg_runs_purge_summaries'));
      return dt;
    };
    const purgeOn = await purgeTime(true), purgeOff = await purgeTime(false);
    const r = { name, ...L, buildS: Math.round(buildS), reconnects,
      pub: { sum: [med(ms.sum), pct(ms.sum, 95)], nosum: [med(ms.nosum), pct(ms.nosum, 95)] },
      overheadPct: Math.round((med(ms.sum) / med(ms.nosum) - 1) * 100),
      walPerPub: { sum: Math.round(med(wal.sum)), nosum: Math.round(med(wal.nosum)) },
      storage: { obsMB: MB(sz.obs), sumsMB: MB(sz.sums), idsMB: MB(sz.ids), statusMB: MB(sz.st),
                 ratioPct: Math.round((Number(sz.sums) + Number(sz.ids) + Number(sz.st)) / Number(sz.obs) * 1000) / 10,
                 nobs: Number(sz.nobs), nsums: Number(sz.nsums), nids: Number(sz.nids) },
      backfill: { runs: bf, s: Math.round(backfillS * 10) / 10 }, verifyS: Math.round(verifyS * 10) / 10, rebuildMsPerRun: Math.round(rebuildPerRun * 10) / 10,
      purgeMsPerRun: { withSummaries: Math.round(purgeOn * 10) / 10, without: Math.round(purgeOff * 10) / 10 },
      tempMB: { build: MB(tbBuild - tb0), backfill: MB(tbBackfill - tbBuild), verify: MB(tbVerify - tbBackfill), total: MB(tb1 - tb0) }, collectorHwmMB: Math.round(hwm) };
    if (r37.length) {
      const blocks = []; for (let i = 0; i < r37.length; i += 500) blocks.push(Math.round(med(r37.slice(i, i + 500)) * 10) / 10);
      r.r37PersistentSessionMedianPer500 = blocks;
    }
    console.log(`# SB ${JSON.stringify(r)}`);
    assert.equal(r.tempMB.total, '0.0', `${name}: no temporary file (a plan hashing the dictionary would spill: §15.3)`);
    results.push(r);
  }
  console.log(`# SB summary ${JSON.stringify(results.map(r => [r.name, r.overheadPct + '%', r.storage.ratioPct + '%']))}`);
});

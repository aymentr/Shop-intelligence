// B-002 M4-P3.1-RT13-01: emergency-control latency against a maximum purge batch, repeated, under contention.
// Each iteration: a fresh database (autovacuum off on the si tables: statistics deterministic), one source loaded with
// MAX_PURGE_RUNS x 500 distinct identities and aged; si_purge_due(MAX_PURGE_RUNS) starts, a SUSPEND (even iterations)
// or TERMINATE_RETENTION (odd) is issued while the purge holds the source, and a collector completes runs on another
// source throughout. Reported per statistics mode: p50 / p95 / max of the purge and of the control wait, the index
// tuples the purge read on si.observations, and the purge backend's own lock-wait samples (external contention, kept
// separate from execution time). Asserted (unchanged RT-13 / M3-T14 bounds): p95 purge <= 5 s and p95 wait <= 5 s, and
// the structural bound of m4-rt13-purge-fk PF-1 on every purge.
//   SI_RT13_N=10 SI_RT13_MODES=cold,warm node tests/db/run.mjs tests/slow/m4-rt13-purge-bench.test.mjs
//   SI_RT13_BROKEN=1 ... : the same with the 0022 index dropped (report only: the "before" numbers; nothing asserted)
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { connect, control, createSources, freshDatabase, pid, recordRights, roles, settle } from '../db/helpers.mjs';
import { fixtureSha256, requestSha256 } from '../../dist/persistence/request-hash.js';
import { MAX_PURGE_RUNS } from '../../dist/persistence/retention.js';

const N = Number(process.env.SI_RT13_N ?? 10);
const MODES = (process.env.SI_RT13_MODES ?? 'cold,warm').split(',');
const BROKEN = process.env.SI_RT13_BROKEN === '1';
const BOUND_MS = 5000, PER_ROW = 5;
const ROW = (id, title = 't'.repeat(900)) => ({ network: 'META', nativeAdId: id, advertiserName: 'Synthetic Co', countries: ['DE'],
  seenAt: '2026-01-01T00:00:00.000Z', sourceUrl: 'https://example.test/a', title });
let n = 0;
async function collect(c, src, rows) {
  const fx = fixtureSha256(rows), key = `rk${++n}`;
  const sha = requestSha256({ adapterId: src, evidenceKind: 'SYNTHETIC', networks: ['META'], fixtureSha256: fx });
  const run = (await c.query('SELECT * FROM si.si_begin_run_scoped($1,$2,$3,$4,$5::text[],$6)', [src, key, sha, 'SYNTHETIC', ['META'], fx])).rows[0];
  await c.query('BEGIN');
  const r = (await c.query('SELECT * FROM si.si_complete_run($1::uuid, $2::uuid, $3::jsonb)', [run.run_id, run.lease_token, JSON.stringify(rows)])).rows[0];
  await c.query('COMMIT');
  assert.equal(r.outcome, 'COMPLETED');
  return run.run_id;
}
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };

async function iteration(t, mode, i) {
  const db = await freshDatabase(t, 'm4rt13b');
  const x = await roles(t, db, ['admin', 'si_rights_admin', 'si_collector']);
  const extra = []; t.after(async () => { for (const e of extra) await e.end().catch(() => {}); });
  const conn = async u => { const k = await connect({ user: u, database: db }); extra.push(k); return k; };
  for (const { r } of (await x.admin.query(`SELECT oid::regclass::text AS r FROM pg_class WHERE relnamespace = 'si'::regnamespace AND relkind = 'r'`)).rows)
    await x.admin.query(`ALTER TABLE ${r} SET (autovacuum_enabled = off)`);
  if (BROKEN) await x.admin.query('SET ROLE si_owner; DROP INDEX si.observations_by_ad_fk; RESET ROLE');
  const [src, other] = [`rt13b-${++n}`, `rt13c-${++n}`];
  await createSources(x.admin, [src, other], ['META', 'TIKTOK']);
  for (const s of [src, other]) await recordRights(x.si_rights_admin, s, {});
  const tag = randomBytes(3).toString('hex'), ids = [];
  for (let r = 0; r < MAX_PURGE_RUNS; r++) ids.push(await collect(x.si_collector, src, Array.from({ length: 500 }, (_, k) => ROW(`${tag}${r}-${k}`))));
  await x.admin.query('BEGIN'); await x.admin.query('SET LOCAL session_replication_role = replica');
  await x.admin.query(`UPDATE si.collection_runs SET retain_until = clock_timestamp() - interval '10 minutes' WHERE run_id = ANY ($1::uuid[])`, [ids]);
  await x.admin.query('COMMIT');
  if (mode === 'warm') await x.admin.query('ANALYZE si.observations; ANALYZE si.ads');
  const ret = await conn('si_retention'), ra = await conn('si_rights_admin'), col = await conn('si_collector');
  const [retPid, raPid] = [await pid(ret), await pid(ra)];
  let lockSamples = 0, samples = 0, sampling = true, collected = 0, blocked = false;
  const sampler = (async () => { while (sampling) {
    const a = (await x.admin.query(`SELECT wait_event_type AS w, $2::int = ANY (pg_blocking_pids($3)) AS b FROM pg_stat_activity WHERE pid = $1`, [retPid, retPid, raPid])).rows[0];
    samples++; if (a?.w === 'Lock') lockSamples++; if (a?.b) blocked = true; await sleep(5); } })();
  const background = (async () => { while (sampling) { await collect(col, other, Array.from({ length: 100 }, (_, k) => ROW(`${tag}c${collected}-${k}`, 'c'))); collected++; } })();
  const t0 = performance.now();
  const p = (async () => {
    await ret.query('BEGIN');
    const r = (await ret.query('SELECT * FROM si.si_purge_due($1)', [MAX_PURGE_RUNS])).rows[0];
    const ms = performance.now() - t0;
    const reads = Number((await ret.query(`SELECT sum(pg_stat_get_xact_tuples_returned(indexrelid))::bigint AS n FROM pg_index WHERE indrelid = 'si.observations'::regclass`)).rows[0].n);
    await ret.query('COMMIT');
    return { r, ms, reads };
  })();
  for (let k = 0; ; k++) {
    if ((await x.admin.query('SELECT state FROM pg_stat_activity WHERE pid = $1', [retPid])).rows[0]?.state === 'active') break;
    assert.ok(k < 500, 'purge started'); await sleep(2);
  }
  await sleep(30);
  const kind = i % 2 ? 'TERMINATE_RETENTION' : 'SUSPEND';
  const c0 = performance.now();
  const ctl = await settle(control(ra, src, kind).then(() => performance.now() - c0));
  const pr = await p;
  sampling = false; await sampler; await background;
  assert.equal(ctl.status, 'ok', `${kind} recorded`);
  assert.deepEqual([pr.r.outcome, pr.r.identities_purged], ['PURGED', MAX_PURGE_RUNS * 500]);
  return { kind, purgeMs: pr.ms, waitMs: ctl.value, reads: pr.reads, lockSamples, samples, collected, blocked };
}

for (const mode of MODES) {
  test(`RT13-BENCH ${mode}${BROKEN ? ' (BROKEN: 0022 index dropped, report only)' : ''}: p50/p95 of the maximum purge and of the emergency-control wait under contention`, async t => {
    const it = [];
    for (let i = 0; i < N; i++) it.push(await iteration(t, mode, i));
    const P = it.map(z => z.purgeMs), W = it.map(z => z.waitMs);
    console.log(`# RT13-BENCH ${mode}${BROKEN ? ' BROKEN' : ''} n=${N}: purge p50 ${q(P, 0.5).toFixed(0)} p95 ${q(P, 0.95).toFixed(0)} max ${Math.max(...P).toFixed(0)} ms; ` +
                `control wait p50 ${q(W, 0.5).toFixed(0)} p95 ${q(W, 0.95).toFixed(0)} max ${Math.max(...W).toFixed(0)} ms; index tuples read per purge ${[...new Set(it.map(z => z.reads))].join('/')}; ` +
                `purge lock-wait samples ${it.reduce((a, z) => a + z.lockSamples, 0)}/${it.reduce((a, z) => a + z.samples, 0)}; control blocked by the purge ${it.filter(z => z.blocked).length}/${N}; ` +
                `concurrent collector runs ${it.reduce((a, z) => a + z.collected, 0)}`);
    if (BROKEN) return;
    for (const z of it) assert.ok(z.reads <= PER_ROW * MAX_PURGE_RUNS * 500, `structural bound: ${z.reads} index tuples`);
    assert.ok(q(P, 0.95) <= BOUND_MS, `p95 maximum purge ${q(P, 0.95).toFixed(0)} ms <= ${BOUND_MS} ms`);
    assert.ok(q(W, 0.95) <= BOUND_MS, `p95 emergency-control wait ${q(W, 0.95).toFixed(0)} ms <= ${BOUND_MS} ms`);
  });
}

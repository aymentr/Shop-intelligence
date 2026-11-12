// M3-P3B slow job: real rights deadlines (about 7.5 minutes; T1 needs the 60 s margin plus the 5 min
// lease before a window end). One shared wait covers:
//   VR-2   a completion whose publication check was made IMMEDIATE, committed after the rights expired:
//          the G3 gap is reproduced and the verifier classifies it INVALID (COMMITTED_AFTER_WINDOW);
//   VR-3   the library protocol (deferred check) refuses the same delayed COMMIT; ALL IMMEDIATE cannot
//          complete a non-empty run at all;
//   VR-2h  invalid historical evidence: the same bypass under 0006, verified after upgrading to 0007;
//   VR-2m  targeted mutant: a verdict that ignores the window end classifies the bypass VALID (killed);
//   RT-15  the rights-expiry retention path end to end, with the RIGHTS_ENDED audit label (also when a
//          successor version took effect before the expiry: the stored bound is never extended).
// Synthetic data only; disposable databases. Run through: node tests/db/run.mjs tests/slow/m3-deadline.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { asOwner, connect, createSources, freshDatabase, recordRights, roles } from '../db/helpers.mjs';
import { migrateUp } from '../../dist/persistence/migrate.js';
import { fixtureSha256, requestSha256 } from '../../dist/persistence/request-hash.js';

const MIG7 = readFileSync(new URL('../../db/migrations/0007_receipt_verification.up.sql', import.meta.url), 'utf8');
const ROW = id => ({ network: 'META', nativeAdId: id, advertiserName: 'Synthetic Co', countries: ['DE'], seenAt: '2026-01-01T00:00:00.000Z',
  sourceUrl: 'https://example.test/a' });
const T2 = 'SELECT * FROM si.si_complete_run($1::uuid, $2::uuid, $3::jsonb)';
const EXP = `clock_timestamp() + interval '450 seconds'`;
let n = 0;

async function env(t, prefix, { upTo } = {}) {
  let db;
  if (upTo) {
    db = await freshDatabase(t, prefix, { migrate: false });
    const a = await connect({ database: db });
    try { await migrateUp(a, { to: upTo }); } finally { await a.end(); }
  } else db = await freshDatabase(t, prefix);
  const x = await roles(t, db, ['admin', 'si_rights_admin', 'si_collector', 'si_retention', 'si_monitor']);
  // Non-enumerable: roles() closes every enumerable value at the end of the test.
  Object.defineProperty(x, 'connect', { enumerable: false, value: async user => {
    const k = await connect({ user, database: db }); t.after(() => k.end().catch(() => {})); return k; } });
  Object.defineProperty(x, 'source', { enumerable: false, value: async () => {
    const id = `dl-${++n}`; await createSources(x.admin, [id]); await recordRights(x.si_rights_admin, id, { expires_at_sql: EXP }); return id; } });
  return x;
}
async function begin(x, src, rows, c) {
  const fx = fixtureSha256(rows), sha = requestSha256({ adapterId: src, evidenceKind: 'SYNTHETIC', networks: ['META'], fixtureSha256: fx });
  return (await c.query('SELECT * FROM si.si_begin_run_scoped($1,$2,$3,$4,$5::text[],$6)', [src, `dk${++n}`, sha, 'SYNTHETIC', ['META'], fx])).rows[0];
}
async function collect(x, src, rows) {
  const c = await x.connect('si_collector');
  const run = await begin(x, src, rows, c);
  await c.query('BEGIN'); await c.query(T2, [run.run_id, run.lease_token, JSON.stringify(rows)]); await c.query('COMMIT');
  return run;
}
/** T2 passes its checks now; the transaction is kept active past the deadline (+5 s), then COMMIT. */
async function delayed(x, src, mode) {
  const c = await x.connect('si_collector');
  const rows = [ROW(`dl-${mode}-${++n}`)];
  const run = await begin(x, src, rows, c);
  await c.query('BEGIN');
  if (mode === 'publish-immediate') await c.query('SET CONSTRAINTS si.trg_runs_publish_check IMMEDIATE');
  if (mode === 'all-immediate') await c.query('SET CONSTRAINTS ALL IMMEDIATE');
  try { await c.query(T2, [run.run_id, run.lease_token, JSON.stringify(rows)]); }
  catch (e) { await c.query('ROLLBACK'); return { run, t2: e.message.split(':')[0], commit: null }; }
  for (;;) {
    const past = (await c.query(`SELECT clock_timestamp() > (SELECT expires_at FROM si.rights_versions WHERE source_id = $1 AND version = 1)
                                   + interval '5 seconds' AS p`, [src])).rows[0].p;
    if (past) break;
    await c.query('SELECT pg_sleep(20)');                     // statement_timeout 30 s, idle_in_transaction 10 s
  }
  try { await c.query('COMMIT'); return { run, t2: 'COMPLETED', commit: 'COMMIT' }; }
  catch (e) { return { run, t2: 'COMPLETED', commit: e.message.split(':')[0] }; }
}
const verdict = async (x, id) => (await x.admin.query(`SELECT verdict, reason, commit_ts >= window_end AS after_end,
  window_end = (SELECT expires_at FROM si.rights_versions v WHERE v.rights_version_id = r.rights_version_id) AS end_is_expiry
  FROM si.receipt_verifications r WHERE run_id = $1`, [id])).rows[0];

test('slow: real rights deadlines — G3 bypass detected (INVALID), deferred protocol refuses, RT-15 expiry purge', { timeout: 20 * 60 * 1000 }, async t => {
  const base = await env(t, 'slowb'), hist = await env(t, 'slowh', { upTo: 6 }), mut = await env(t, 'slowm');
  const vfn = MIG7.slice(MIG7.indexOf('CREATE FUNCTION si.si_receipt_verdict'), MIG7.indexOf('END $receipt_verdict$;') + 'END $receipt_verdict$;'.length)
    .replace(/^CREATE FUNCTION/, 'CREATE OR REPLACE FUNCTION');
  assert.equal(vfn.split('ELSIF ts >= window_end THEN').length, 2);
  await asOwner(mut.admin, a => a.query(vfn.replace('ELSIF ts >= window_end THEN', 'ELSIF false THEN')));     // mutant: window end ignored
  const [sN, sD, sF, sA, sX1, sX2] = [await base.source(), await base.source(), await base.source(), await base.source(), await base.source(), await base.source()];
  const [sH, sM] = [await hist.source(), await mut.source()];
  const N = await collect(base, sN, [ROW('dl-normal')]), X1 = await collect(base, sX1, [ROW('dl-x1')]), X2 = await collect(base, sX2, [ROW('dl-x2')]);
  await recordRights(base.si_rights_admin, sX2, { effective_from_sql: `(SELECT expires_at FROM si.rights_versions WHERE source_id = '${sX2}' AND version = 1) - interval '60 seconds'` });
  const [D, F, A, H, M] = await Promise.all([delayed(base, sD, 'publish-immediate'), delayed(base, sF, 'deferred'), delayed(base, sA, 'all-immediate'),
                                             delayed(hist, sH, 'publish-immediate'), delayed(mut, sM, 'publish-immediate')]);
  // VR-3: the library protocol and ALL IMMEDIATE never commit evidence after the deadline.
  assert.deepEqual([F.t2, F.commit], ['COMPLETED', 'SI_T2_RIGHTS_EXPIRING'], 'deferred publication check refuses the late COMMIT');
  assert.equal(A.t2, 'SI_AD_WITHOUT_OBSERVATION', 'ALL IMMEDIATE cannot complete a non-empty run');
  // VR-2: the targeted IMMEDIATE bypass commits after the deadline — and is classified INVALID.
  assert.deepEqual([D.t2, D.commit], ['COMPLETED', 'COMMIT'], 'G3 gap reproduced: evidence committed after the rights expired');
  const vb = (await base.si_monitor.query('SELECT * FROM si.si_verify_receipts(100)')).rows[0];
  assert.deepEqual([vb.verified, vb.valid, vb.invalid, vb.unverifiable], [4, 3, 1, 0]);
  assert.deepEqual(await verdict(base, D.run.run_id), { verdict: 'INVALID', reason: 'COMMITTED_AFTER_WINDOW', after_end: true, end_is_expiry: true });
  for (const r of [N, X1, X2]) assert.equal((await verdict(base, r.run_id)).verdict, 'VALID');
  for (const r of [N, D.run, X1, X2]) {
    assert.equal((await base.admin.query('SELECT si.si_evidence_readable($1) AS r', [r.run_id])).rows[0].r, false, 'nothing is readable after expiry');
  }
  // VR-2h: invalid historical evidence (committed under 0006, verified after the upgrade).
  assert.deepEqual([H.t2, H.commit], ['COMPLETED', 'COMMIT']);
  assert.deepEqual(await migrateUp(hist.admin), [7, 8, 9, 10, 11, 12, 13, 14, 15]);
  await hist.si_monitor.query('SELECT * FROM si.si_verify_receipts(100)');
  assert.equal((await verdict(hist, H.run.run_id)).verdict, 'INVALID');
  // VR-2m: the window-ignoring mutant computes VALID for the late commit (detected); the table CHECK
  // verifications_valid_shape still refuses to store such a VALID row (second, independent layer).
  const mv = (await mut.admin.query('SELECT verdict FROM si.si_receipt_verdict($1)', [M.run.run_id])).rows[0].verdict;
  const stored = await mut.si_monitor.query('SELECT * FROM si.si_verify_receipts(100)').then(() => 'STORED', e => `${e.code} ${e.message.match(/constraint "(\w+)"/)?.[1]}`);
  console.log(`# VR-M window end ignored: baseline INVALID, mutant verdict ${mv} (${mv === 'VALID' ? 'KILLED' : 'SURVIVED'}); storing it: ${stored}`);
  assert.equal(mv, 'VALID', 'the mutant is detected (it would classify the late commit VALID)');
  assert.equal(stored, '23514 verifications_valid_shape', 'the CHECK layer refuses a VALID row committed after the window');
  // RT-15: rights expiry ends retention; the purge label is RIGHTS_ENDED (also with a later successor version).
  const purged = [];
  for (;;) { const p = (await base.si_retention.query('SELECT * FROM si.si_purge_due(20)')).rows[0]; if (p.outcome !== 'PURGED') break; purged.push(p.purged_source); }
  assert.deepEqual(purged.sort(), [sN, sD, sX1, sX2].sort());
  const logs = (await base.admin.query(`SELECT p.source_id, p.reason, p.effective_end = v.expires_at AS at_expiry
    FROM si.purge_log p JOIN si.rights_versions v ON v.source_id = p.source_id AND v.version = 1 ORDER BY p.source_id`)).rows;
  assert.ok(logs.length === 4 && logs.every(l => l.reason === 'RIGHTS_ENDED' && l.at_expiry), JSON.stringify(logs));
  console.log(`# slow: D commit after expiry -> ${vb.invalid} INVALID; F ${F.commit}; A ${A.t2}; purge labels ${[...new Set(logs.map(l => l.reason))].join(',')}`);
});

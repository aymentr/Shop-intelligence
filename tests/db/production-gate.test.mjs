// M3-P3B D7 production gate: assertProductionReady requires a live collector session on the same
// database and fails closed on unsafe effective logging. Real disposable PostgreSQL 16 (D5b applied
// to each disposable database by the pg_catalog owner, as in the preconditions tests).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cfg, connect, freshDatabase } from './helpers.mjs';
import { assertProductionReady } from '../../dist/persistence/production-readiness.js';

const HARDENING = readFileSync(new URL('../../db/bootstrap/optional/advisory-lock-hardening.sql', import.meta.url), 'utf8');
const CLI = fileURLToPath(new URL('../../dist/persistence/cli.js', import.meta.url));
async function hardened(t) {
  const db = await freshDatabase(t, 'prgate');
  const adm = await connect({ database: db });
  t.after(() => adm.end());
  await adm.query(HARDENING);
  const open = async (user = 'si_collector', database = db) => { const c = await connect({ user, database }); t.after(() => c.end().catch(() => {})); return c; };
  return { db, adm, open };
}
const gate = (adm, collector) => assertProductionReady(adm, { collector }).then(() => 'PASS', e => e.message);
const url = (user, db) => `postgres://${user}:${encodeURIComponent(user === cfg.adminUser ? cfg.adminPassword : cfg.rolePassword)}@${cfg.host}:${cfg.port}/${db}`;
function preflight(env) {
  const e = { ...process.env, ...env };
  delete e.SI_PRODUCTION;
  for (const k of Object.keys(env)) if (env[k] === undefined) delete e[k];
  return spawnSync(process.execPath, [CLI, 'preflight', '--production'], { encoding: 'utf8', env: e });
}

test('PR-1: hardened database and a safe collector session pass (library and CLI)', async t => {
  const { db, adm, open } = await hardened(t);
  assert.equal(await gate(adm, await open()), 'PASS');
  const r = preflight({ SI_DATABASE_URL: url(cfg.adminUser, db), SI_COLLECTOR_DATABASE_URL: url('si_collector', db) });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^ok   collector_session: si_collector/m);
  assert.match(r.stdout, /^ok   log_parameter_max_length: 0/m);
});

test('PR-2: each unsafe collector logging setting, and database-level overrides, fail the gate', async t => {
  const { db, adm, open } = await hardened(t);
  const unsafe = [['log_parameter_max_length', '-1'], ['log_parameter_max_length_on_error', '-1'], ['log_statement', 'all'],
                  ['log_min_duration_statement', '0'], ['log_min_duration_sample', '0'], ['log_transaction_sample_rate', '1']];
  for (const [k, v] of unsafe) {
    await adm.query(`ALTER ROLE si_collector IN DATABASE ${db} SET ${k} = '${v}'`);
    const msg = await gate(adm, await open());
    assert.match(msg, new RegExp(`^PRODUCTION_PREFLIGHT_FAILED: .*${k}=`), `${k} (role-in-database override)`);
    await adm.query(`ALTER ROLE si_collector IN DATABASE ${db} RESET ${k}`);
  }
  // A database-wide setting that weakens logging for every role, the collector included.
  await adm.query(`ALTER DATABASE ${db} SET log_statement = 'all'`);
  assert.match(await gate(adm, await open()), /log_statement=all/);
  await adm.query(`ALTER DATABASE ${db} RESET log_statement`);
  assert.equal(await gate(adm, await open()), 'PASS', 'restored');
});

test('PR-3: a missing or unreachable collector session fails closed (library and CLI)', async t => {
  const { db, adm } = await hardened(t);
  assert.match(await gate(adm, undefined), /collector_session=missing/);
  assert.match(await gate(adm, null), /collector_session=missing/);
  assert.match(await assertProductionReady(adm).then(() => 'PASS', e => e.message), /collector_session=missing/, 'no options at all');
  const missing = preflight({ SI_DATABASE_URL: url(cfg.adminUser, db), SI_COLLECTOR_DATABASE_URL: undefined });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /PRODUCTION_PREFLIGHT_FAILED: .*collector_session=missing/);
  const wrongPw = preflight({ SI_DATABASE_URL: url(cfg.adminUser, db), SI_COLLECTOR_DATABASE_URL: `postgres://si_collector:wrong@${cfg.host}:${cfg.port}/${db}` });
  assert.notEqual(wrongPw.status, 0);
  assert.match(wrongPw.stderr, /collector_session=missing/);
  const prod = spawnSync(process.execPath, [CLI, 'status'], { encoding: 'utf8',
    env: { ...process.env, SI_PRODUCTION: '1', SI_DATABASE_URL: url(cfg.adminUser, db), SI_COLLECTOR_DATABASE_URL: '' } });
  assert.notEqual(prod.status, 0, 'every SI_PRODUCTION=1 entry point is gated');
  assert.match(prod.stderr, /collector_session=missing/);
});

test('PR-4: the wrong role, or a collector on another database, fails the gate', async t => {
  const { adm, open } = await hardened(t);
  assert.match(await gate(adm, await open('si_monitor')), /collector_session=si_monitor/);
  assert.match(await gate(adm, await open(cfg.adminUser)), new RegExp(`collector_session=${cfg.adminUser}`));
  const other = await freshDatabase(t, 'prgate2');
  assert.match(await gate(adm, await open('si_collector', other)), /collector_database=/);
});

test('PR-5: checks that cannot complete fail closed', async t => {
  const { adm, open } = await hardened(t);
  const dead = await open();
  await dead.end();
  assert.match(await gate(adm, dead), /collector_logging=check failed/);
  assert.match(await gate(adm, { query: async () => ({ rows: [] }) }), /collector_logging=check failed/);
  assert.match(await gate(adm, { query: async () => { throw new Error('boom'); } }), /collector_logging=check failed/);
  await assert.rejects(assertProductionReady({ query: async () => { throw new Error('database unavailable'); } }, { collector: await open() }),
    /database unavailable/);
});

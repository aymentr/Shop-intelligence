// Founder decision D7: operational preconditions, asserted against the test cluster (the same
// settings compose.yaml uses in CI) and through the CLI deployment check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertOperationalPreconditions, checkOperationalPreconditions, checkProductionAdvisoryPermissions } from '../../dist/persistence/preconditions.js';
import { cfg, connect, freshDatabase } from './helpers.mjs';

const cleanups = [];
const fileScope = { after: fn => cleanups.push(fn) };
let db;
test.before(async () => { db = await freshDatabase(fileScope, 'precond'); });
test.after(async () => { for (const fn of cleanups.reverse()) await fn(); });

test('D7: the test cluster satisfies every operational precondition', async () => {
  const c = await connect({ database: db });
  try {
    const results = await checkOperationalPreconditions(c);
    assert.deepEqual(results.map(r => r.name), ['postgresql_major_16', 'max_prepared_transactions', 'track_commit_timestamp',
                                                'synchronous_standby_names', 'default_transaction_isolation']);
    assert.deepEqual(results.filter(r => !r.ok), [], JSON.stringify(results));
    await assertOperationalPreconditions(c);
    // Direct evidence for the two settings the publication design depends on most.
    await c.query('BEGIN');
    await assert.rejects(c.query(`PREPARE TRANSACTION 'si_precond'`), e => e.code === '55000');
    await c.query('ROLLBACK').catch(() => {});
  } finally { await c.end(); }
});

test('D7: a violated precondition is reported by name (fake settings)', async () => {
  const fake = { query: async () => ({ rows: [{ version: '170002', prepared: '10', commit_ts: 'off', sync: 'standby1', isolation: 'serializable' }] }) };
  const results = await checkOperationalPreconditions(fake);
  assert.deepEqual(results.map(r => r.ok), [false, false, false, false, false]);
  await assert.rejects(assertOperationalPreconditions(fake),
    /PRECONDITIONS_FAILED: postgresql_major_16=170002 .*max_prepared_transactions=10 .*track_commit_timestamp=off .*synchronous_standby_names=standby1 .*default_transaction_isolation=serializable/);
});

test('D7: `cli.js preflight` is the deployment check (exit 0 here)', () => {
  const cli = fileURLToPath(new URL('../../dist/persistence/cli.js', import.meta.url));
  const url = `postgres://${cfg.adminUser}:${encodeURIComponent(cfg.adminPassword)}@${cfg.host}:${cfg.port}/${db}`;
  const r = spawnSync(process.execPath, [cli, 'preflight'], { encoding: 'utf8', env: { ...process.env, SI_DATABASE_URL: url } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal((r.stdout.match(/^ok /gm) ?? []).length, 5, r.stdout);
});

test('D5b: production gate fails closed on PUBLIC and effective application grants', async () => {
  const fake = { query: async () => ({ rows: [{
    public_count: '21', application_count: '3', owner_lock: true, migrator_lock: true
  }] }) };
  const results = await checkProductionAdvisoryPermissions(fake);
  assert.deepEqual(results.map(r => r.ok), [false, false, true, true]);
  assert.deepEqual(results.map(r => r.name), [
    'advisory_public_exposures', 'advisory_application_exposures',
    'advisory_owner_lock', 'advisory_migrator_lock'
  ]);
});

test('D5b: production gate requires both privileged lock capabilities', async () => {
  const fake = { query: async () => ({ rows: [{
    public_count: '0', application_count: '0', owner_lock: false, migrator_lock: false
  }] }) };
  const results = await checkProductionAdvisoryPermissions(fake);
  assert.deepEqual(results.map(r => r.ok), [true, true, false, false]);
});

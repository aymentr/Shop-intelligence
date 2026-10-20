// Entry point for `npm run test:db` (expects `npm run build` first).
// 1. Safety guard (loopback host, *_test database names only).
// 2. Idempotent role bootstrap with dev-only test passwords.
// 3. Rebuilds the template database: bootstrap + all migrations.
// 4. Runs tests/db/*.test.mjs serially; each test file clones the template into
//    its own database (or builds one from scratch) and drops it afterwards.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertSafeTarget, cfg, connect, ensureRoles } from './helpers.mjs';
import { bootstrapDatabase } from '../../dist/persistence/bootstrap.js';
import { migrateUp } from '../../dist/persistence/migrate.js';

assertSafeTarget(cfg.template);
await ensureRoles();

const admin = await connect();
try {
  // Leftovers from interrupted runs (only *_test databases created by this suite).
  const stale = await admin.query(`SELECT datname FROM pg_database WHERE datname ~ '^si_t_[a-z0-9_]+_test$'`);
  for (const { datname } of stale.rows) { assertSafeTarget(datname); await admin.query(`DROP DATABASE ${datname} WITH (FORCE)`); }
  await admin.query(`DROP DATABASE IF EXISTS ${cfg.template} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${cfg.template}`);
} finally { await admin.end(); }

const tpl = await connect({ database: cfg.template });
try {
  await bootstrapDatabase(tpl);
  const applied = await migrateUp(tpl);
  console.log(`template ${cfg.template}: migrations applied ${applied.join(', ')}`);
} finally { await tpl.end(); }

const testDir = fileURLToPath(new URL('./', import.meta.url));
// Optional: `node tests/db/run.mjs rights privileges` runs only those files.
const only = process.argv.slice(2);
const files = only.length ? only.map(n => `${testDir}${n}.test.mjs`) : [`${testDir}*.test.mjs`];
const res = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], {
  stdio: 'inherit',
  env: { ...process.env, SI_TEST_TEMPLATE: cfg.template }
});
process.exitCode = res.status ?? 1;

// Executable mutation of the T1 request-key/hash guard in PostgreSQL migration 0002.
// Run only on disposable CI database, never on existing data or production.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const path = 'db/migrations/0002_runs.up.sql';
const original = readFileSync(path, 'utf8');
const anchor = 'AND x.request_sha256 <> p_request_sha256';
if (original.split(anchor).length !== 2) throw new Error('T1 idempotency mutation anchor ambiguous');
let killed = false;
try {
  // Invert the hash-mismatch predicate: a different payload no longer triggers the intended guard.
  writeFileSync(path, original.replace(anchor, 'AND x.request_sha256 = p_request_sha256'));
  const run = spawnSync(process.execPath, ['tests/db/run.mjs', 't1'], {
    encoding: 'utf8', timeout: 180000
  });
  const output = (run.stdout ?? '') + '\n' + (run.stderr ?? '');
  killed = run.status !== 0 && /not ok \d+ - T1-4/.test(output) &&
    /AssertionError|expected an error|SI_IDEMPOTENCY_KEY_REUSED/.test(output);
  console.log('Mutation: invert T1 request key/hash mismatch check');
  console.log('Mutated PostgreSQL T1 suite exit:', run.status);
  console.log('Failure evidence:\n', output.split('\n').filter(x => /T1-4|not ok|AssertionError|expected an error|SI_IDEMPOTENCY_KEY_REUSED/.test(x)).slice(0, 25).join('\n'));
} finally {
  writeFileSync(path, original);
  if (readFileSync(path, 'utf8') !== original) throw new Error('Migration 0002 restoration failed');
  console.log('Original migration 0002 restored: true');
}
if (!killed) throw new Error('MUTANT_SURVIVED_OR_INCONCLUSIVE: T1-4 failed to expose inverted hash check');
console.log('MUTANT_KILLED: T1-4 rejects inverted request-hash guard');

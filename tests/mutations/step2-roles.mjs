// Executable mutation of the PostgreSQL 16 owner-membership cleanup loop.
// Only run on disposable PostgreSQL test cluster, never production.
// A new test process exercises the changed SQL, and the source is restored in finally.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const path = 'db/bootstrap/roles.sql';
const original = readFileSync(path, 'utf8');
const anchor = 'EXIT WHEN NOT FOUND;';
if (original.split(anchor).length !== 2) throw new Error('Membership mutation anchor ambiguous');
let killed = false;
try {
  writeFileSync(path, original.replace(anchor, 'EXIT WHEN TRUE;'));
  const run = spawnSync(process.execPath,
    ['--test', '--test-name-pattern=MG1b', 'tests/db/migrator.test.mjs'],
    { encoding: 'utf8', timeout: 120000 });
  const output = (run.stdout ?? '') + '\n' + (run.stderr ?? '');
  killed = run.status !== 0 && output.includes('not ok 1 - MG1b') &&
    output.includes('AssertionError');
  console.log('Mutation: skip delegated owner membership cleanup');
  console.log('MG1b mutated test exit:', run.status);
  console.log('Failure evidence:\n', output.split('\n').filter(x => /MG1b|not ok|AssertionError|si_collector|si_retention|si_monitor/.test(x)).slice(0, 25).join('\n'));
} finally {
  writeFileSync(path, original);
  if (readFileSync(path, 'utf8') !== original) throw new Error('Role SQL restoration failed');
  console.log('Original roles.sql restored: true');
}
if (!killed) throw new Error('MUTANT_SURVIVED_OR_INCONCLUSIVE: MG1b did not detect skipped cleanup');
console.log('MUTANT_KILLED: MG1b detects skipped owner membership cleanup');

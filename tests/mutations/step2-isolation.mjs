// B-002 M5: deliberately remove the T1 function's READ COMMITTED guard.
// Run ONLY in the disposable GitHub Actions PostgreSQL 16 environment.
// The mutation is in a migration loaded into a freshly rebuilt test template.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const path = 'db/migrations/0002_runs.up.sql';
const original = readFileSync(path, 'utf8');
const guard = "IF current_setting('transaction_isolation') <> 'read committed' THEN";
const positions = [...original.matchAll(/IF current_setting\('transaction_isolation'\) <> 'read committed' THEN/g)];
if (positions.length !== 2) throw new Error('Expected two isolation guards (trigger, T1); refusing mutation');
const second = positions[1].index;
const mutant = original.slice(0, second) + "IF false THEN" + original.slice(second + guard.length);
let killed = false;
try {
  writeFileSync(path, mutant);
  const r = spawnSync(process.execPath, ['tests/db/run.mjs', 't1'], {
    encoding: 'utf8', timeout: 180000
  });
  const output = (r.stdout ?? '') + '\n' + (r.stderr ?? '');
  const evidence = output.split('\n').filter(x => /LI-T1|not ok|AssertionError|SI_ISOLATION/.test(x));
  console.log('M5 mutation: T1 isolation guard changed to IF false THEN');
  console.log('Mutated suite exit:', r.status);
  console.log(evidence.slice(0, 35).join('\n'));
  killed = r.status !== 0 && /not ok \d+ - LI-T1/.test(output) && /AssertionError|Missing expected rejection|SI_ISOLATION/.test(output);
} finally {
  writeFileSync(path, original);
  if (readFileSync(path, 'utf8') !== original) throw new Error('M5 original migration not restored');
  console.log('M5 original migration restored: true');
}
if (!killed) throw new Error('M5 SURVIVED OR INCONCLUSIVE: no expected LI-T1 failure');
console.log('M5 KILLED: LI-T1 caught missing T1 isolation guard');

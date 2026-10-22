// M4: off-by-one mutation of both independent 20-attempt checks.
// Disposable PostgreSQL CI only. Restores migration in finally.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const path = 'db/migrations/0002_runs.up.sql';
const original = readFileSync(path, 'utf8');
const a = 'IF coalesce(prev_attempt, 0) >= 20 THEN';
const b = 'IF n >= 20 THEN';
if (original.split(a).length !== 2 || original.split(b).length !== 2)
  throw new Error('M4 cap anchors missing or ambiguous');
let killed = false;
try {
  writeFileSync(path, original.replace(a, 'IF coalesce(prev_attempt, 0) > 20 THEN').replace(b, 'IF n > 20 THEN'));
  const r = spawnSync(process.execPath, ['tests/db/run.mjs', 't1'], {encoding:'utf8',timeout:180000});
  const output = (r.stdout ?? '') + '\n' + (r.stderr ?? '');
  console.log('M4 mutated T1 suite exit:',r.status);
  console.log(output.split('\n').filter(x=>/T1-5|not ok|AssertionError|SI_ATTEMPT_LIMIT|check constraint/.test(x)).slice(0,32).join('\n'));
  killed = r.status !== 0 && /not ok \d+ - T1-5/.test(output) && /AssertionError|Missing expected rejection|SI_ATTEMPT_LIMIT|check constraint/.test(output);
} finally {
  writeFileSync(path,original);
  if(readFileSync(path,'utf8')!==original) throw new Error('M4 original migration not restored');
  console.log('M4 original migration restored: true');
}
if(!killed) throw new Error('M4 SURVIVED OR INCONCLUSIVE');
console.log('M4 KILLED: attempt 21 boundary detected');

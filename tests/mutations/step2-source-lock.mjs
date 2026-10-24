// B-002 M2 Step 2 / M1 — source-row lock mutation experiment.
// CI-only, disposable PostgreSQL 16 cluster. Never run against production.
// Change BOTH explicit source FOR KEY SHARE guards; retain all other checks.
// A surviving mutant is a legitimate finding, not permission to weaken tests.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

if (process.env.CI !== 'true') throw new Error('M1 requires the disposable CI environment (CI=true)');
const path = 'db/migrations/0002_runs.up.sql';
const original = readFileSync(path);
const originalText = original.toString('utf8');
const originalHash = createHash('sha256').update(original).digest('hex');
const lock = 'FOR KEY SHARE;';
const lines = originalText.split('\n');
const target = lines.filter(line => line.includes('PERFORM 1 FROM si.sources') && line.includes(lock));
if (target.length !== 2 || !target.every(line => /WHERE .*source_id = /.test(line)))
  throw new Error('M1 source-lock anchors changed: expected exactly the trigger and T1 guards');
let status = 'INCONCLUSIVE';
try {
  let mutated = originalText;
  for (const line of target) {
    if (mutated.split(line).length !== 2) throw new Error('M1 ambiguous mutation anchor');
    mutated = mutated.replace(line, line.replace(lock, ';'));
  }
  if (mutated === originalText) throw new Error('M1 no-op mutation');
  writeFileSync(path, mutated, 'utf8');
  const result = spawnSync(process.execPath, ['tests/db/run.mjs', 't1'], {
    encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024
  });
  const output = (result.stdout ?? '') + '\n' + (result.stderr ?? '');
  const diagnostic = output.split('\n').filter(x => /CC-R:|CC-C:|LO4 |not ok|AssertionError|ERR_TEST_FAILURE|blocked|timeout|error:/.test(x));
  console.log('M1: removed explicit FOR KEY SHARE from both T1 and the insert trigger');
  console.log('Baseline migration sha256:', originalHash);
  console.log('Mutated suite exit:', result.status, 'signal:', result.signal, 'spawn error:', result.error?.message ?? 'none');
  console.log('Relevant output:\n' + diagnostic.slice(0, 70).join('\n'));
  const expectedFailure = /not ok \d+ - (CC-R:|CC-C:|LO4 )/.test(output);
  const assertion = /AssertionError|ERR_ASSERTION|Missing expected|timed out|timeout|waitUntilBlocked|blocking/.test(output);
  if (result.error || result.signal || result.status === null) status = 'INCONCLUSIVE';
  else if (result.status === 0) status = 'SURVIVED';
  else if (expectedFailure && assertion) status = 'KILLED';
  else status = 'INCONCLUSIVE';
} finally {
  writeFileSync(path, original);
  const after = readFileSync(path);
  if (!after.equals(original)) throw new Error('M1 FATAL: migration restoration mismatch');
  console.log('M1 original migration restored byte-for-byte:', true);
}
console.log('M1 CLASSIFICATION:', status);
if (status !== 'KILLED') throw new Error('M1 ' + status + ': no demonstrated targeted regression failure');

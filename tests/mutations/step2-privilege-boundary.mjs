// B-002 / M2 / Step 2 — M6 privilege-boundary mutation experiment.
// CI-only, disposable PostgreSQL test cluster. Do not run on shared databases.
// Each mutant changes migration 0002 in the checkout, rebuilds test databases,
// and restores the original migration byte-for-byte before the next experiment.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

if (process.env.CI !== 'true') throw new Error('M6 requires CI=true');
if (process.env.SI_PRODUCTION === '1') throw new Error('M6 refuses production mode');
if (!['127.0.0.1', 'localhost', '::1'].includes(process.env.SI_TEST_PGHOST ?? '127.0.0.1'))
  throw new Error('M6 requires a loopback PostgreSQL test host');

const path = 'db/migrations/0002_runs.up.sql';
const original = readFileSync(path);
const source = original.toString('utf8');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const originalHash = sha256(original);
const mutants = [
  {
    id: 'M6-WRITE',
    risk: 'collector gains unauthorized UPDATE on collection_runs',
    anchor: 'GRANT SELECT ON si.run_errors TO si_retention;',
    replacement: 'GRANT SELECT ON si.run_errors TO si_retention;\nGRANT UPDATE ON si.collection_runs TO si_collector;',
    detector: /^not ok \d+ - G1: table privileges match the grant matrix exactly/m
  },
  {
    id: 'M6-EXEC',
    risk: 'retention role gains unauthorized EXECUTE on the collector-only SECURITY DEFINER T1 entry point',
    anchor: 'GRANT EXECUTE ON FUNCTION si.si_begin_run(text, text, text, text, text[]) TO si_collector;',
    replacement: 'GRANT EXECUTE ON FUNCTION si.si_begin_run(text, text, text, text, text[]) TO si_collector;\nGRANT EXECUTE ON FUNCTION si.si_begin_run(text, text, text, text, text[]) TO si_retention;',
    detector: /^not ok \d+ - SD1: SECURITY DEFINER contract/m
  }
];

function restore() {
  writeFileSync(path, original);
  const restored = readFileSync(path);
  if (!restored.equals(original)) throw new Error('M6 FATAL: migration not restored byte-for-byte');
  console.log('M6 migration restored byte-for-byte: true; sha256:', sha256(restored));
}

function run(id) {
  const result = spawnSync(process.execPath, ['tests/db/run.mjs', 'privileges'], {
    encoding: 'utf8', timeout: 180000, maxBuffer: 12 * 1024 * 1024
  });
  const output = (result.stdout ?? '') + '\n' + (result.stderr ?? '');
  console.log(id, 'exit:', result.status, 'signal:', result.signal, 'spawn error:', result.error?.message ?? 'none');
  console.log(id, 'relevant output:\n' + output.split('\n').filter(line =>
    /^not ok |^ok \d+ - (G1: table privileges|SD1: SECURITY DEFINER)|^# (tests|pass|fail)|AssertionError|ERR_ASSERTION|^\s*(?:error:|actual:|expected:|code:)/.test(line)
  ).slice(0, 90).join('\n'));
  return { result, output };
}

console.log('M6 original migration sha256:', originalHash);
const outcomes = [];
try {
  for (const mutant of mutants) {
    if (source.split(mutant.anchor).length !== 2)
      throw new Error(mutant.id + ': expected exactly one SQL anchor');
    const mutated = source.replace(mutant.anchor, mutant.replacement);
    if (mutated === source) throw new Error(mutant.id + ': no-op');
    try {
      writeFileSync(path, mutated, 'utf8');
      console.log(mutant.id, 'applied:', mutant.risk);
      const { result, output } = run(mutant.id);
      const expectedFailure = mutant.detector.test(output);
      const assertion = /AssertionError|ERR_ASSERTION/.test(output);
      const classification = result.error || result.signal || result.status === null ? 'INCONCLUSIVE'
        : result.status === 0 ? 'SURVIVED'
        : expectedFailure && assertion ? 'KILLED' : 'INCONCLUSIVE';
      console.log(mutant.id, 'named detector failed:', expectedFailure, 'assertion:', assertion);
      console.log(mutant.id, 'CLASSIFICATION:', classification);
      outcomes.push({ id: mutant.id, classification });
    } finally {
      restore();
    }
  }
  const baseline = run('M6 restored baseline');
  const green = baseline.result.status === 0 && !baseline.result.error && !baseline.result.signal;
  console.log('M6 restored baseline green:', green);
  if (!green) throw new Error('M6 restored baseline failed');
  if (outcomes.some(x => x.classification !== 'KILLED'))
    throw new Error('M6 unresolved: ' + JSON.stringify(outcomes));
  console.log('M6 RESULT: both representative privilege mutants KILLED; baseline green');
} finally {
  restore();
}

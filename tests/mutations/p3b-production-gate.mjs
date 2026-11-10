// Targeted mutation check for the D7 production gate (M3-P3B): drop the collector-session checks from
// assertProductionReady; PR-2/PR-3 must fail. Run ONLY on a disposable CI/local checkout after the
// database template exists. Restores the TypeScript source AND rebuilds dist/, then proves the mutant is gone.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const path = 'src/persistence/production-readiness.ts';
const original = readFileSync(path, 'utf8');
const needle = '    ...await collectorChecks(client, options.collector)\n';
if (original.split(needle).length !== 2) throw new Error('Mutation anchor missing or ambiguous');
let killed = false;
try {
  writeFileSync(path, original.replace(needle, ''));
  const build = spawnSync('npm', ['run', 'build'], { encoding: 'utf8', timeout: 60000 });
  if (build.status !== 0) throw new Error('Mutant failed build; not a valid kill: ' + build.stderr);
  const run = spawnSync(process.execPath, ['--test', '--test-name-pattern=^PR-(2|3):', 'tests/db/production-gate.test.mjs'],
    { encoding: 'utf8', timeout: 180000 });
  const output = (run.stdout ?? '') + '\n' + (run.stderr ?? '');
  killed = run.status !== 0 && /not ok \d+ - PR-2/.test(output) && /not ok \d+ - PR-3/.test(output);
  console.log('Mutation: production gate without the collector-session logging checks');
  console.log('PR-2/PR-3 mutated exit:', run.status);
  console.log(output.split('\n').filter(l => /^(not )?ok \d+ - PR-/.test(l)).join('\n'));
} finally {
  writeFileSync(path, original);
  if (readFileSync(path, 'utf8') !== original) throw new Error('Source restoration failed');
  const rebuild = spawnSync('npm', ['run', 'build'], { encoding: 'utf8', timeout: 60000 });
  const compiled = readFileSync('dist/persistence/production-readiness.js', 'utf8');
  const clean = rebuild.status === 0 && compiled.includes('collectorChecks(client, options.collector)');
  console.log('Original source restored and dist/ rebuilt:', clean);
  if (!clean) throw new Error('Compiled output still carries the mutant or failed to rebuild');
}
if (!killed) throw new Error('MUTANT_SURVIVED_OR_INCONCLUSIVE: PR-2/PR-3 should fail without the collector checks');
console.log('MUTANT_KILLED: PR-2/PR-3 detected the production gate without collector logging checks');

// Targeted, executable mutation check for the D5b production privilege gate.
// Run ONLY on disposable CI/local test checkout after the database test template exists.
// Changes a TypeScript source file temporarily and ALWAYS restores it before exiting.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const path = 'src/persistence/preconditions.ts';
const original = readFileSync(path, 'utf8');
const needle = "'si_collector', 'si_rights_admin', 'si_retention', 'si_monitor'";
const mutant = "'si_mutated_collector', 'si_rights_admin', 'si_retention', 'si_monitor'";
if (original.split(needle).length !== 2) throw new Error('Mutation anchor missing or ambiguous');
let killed = false;
try {
  writeFileSync(path, original.replace(needle, mutant));
  const build = spawnSync('npm', ['run', 'build'], { encoding: 'utf8', timeout: 60000 });
  if (build.status !== 0) throw new Error('Mutant failed build; not a valid kill: ' + build.stderr);
  const run = spawnSync(process.execPath, [
    '--test', '--test-name-pattern=MG10', 'tests/db/migrator.test.mjs'
  ], { encoding: 'utf8', timeout: 120000 });
  const output = (run.stdout ?? '') + '\n' + (run.stderr ?? '');
  killed = run.status !== 0 &&
    output.includes('MG10 (D5b mutation)') &&
    output.includes('not ok') &&
    output.includes('true !== false');
  console.log('Mutation: exclude si_collector from effective privilege scan');
  console.log('Mutated build exit:', build.status);
  console.log('MG10 mutated test exit:', run.status);
  console.log('MG10 failure evidence:\n', output.split('\n').filter(x => /MG10|not ok|true !== false|AssertionError|error:/.test(x)).slice(0, 25).join('\n'));
} finally {
  writeFileSync(path, original);
  const restored = readFileSync(path, 'utf8') === original;
  console.log('Original source restored:', restored);
  if (!restored) throw new Error('Source restoration failed');
}
if (!killed) throw new Error('MUTANT_SURVIVED_OR_INCONCLUSIVE: expected MG10 to fail because collector exposure is hidden');
console.log('MUTANT_KILLED: MG10 detected hidden explicit collector privilege');

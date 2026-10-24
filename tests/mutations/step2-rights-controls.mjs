// B-002 / M2 / Step 2 — independent rights and source-control mutation campaigns.
// Mutate only the disposable checkout of migration 0002; frozen 0001 is never touched.
// A surviving mutant is a finding; never weaken tests to manufacture a kill.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

if (process.env.CI !== 'true') throw new Error('M2 requires CI=true and the disposable PostgreSQL 16 CI service');
if (process.env.SI_PRODUCTION === '1') throw new Error('M2 refuses production mode');
if (!['127.0.0.1', 'localhost', '::1'].includes(process.env.SI_TEST_PGHOST ?? '127.0.0.1'))
  throw new Error('M2 requires a loopback test database host');

const path = 'db/migrations/0002_runs.up.sql';
const original = readFileSync(path);
const source = original.toString('utf8');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const originalHash = sha(original);
const mutations = [
  {
    id: 'M2-R',
    purpose: 'allow evaluation DENIED in T1 rights decision',
    anchors: ["ELSIF v.evaluation <> 'ALLOWED' THEN"],
    replacements: ["ELSIF false THEN"],
    detector: /^not ok \d+ - T1-2: REJECTED codes,/m
  },
  {
    id: 'M2-C',
    purpose: 'bypass both source suspension checks in T1 and insert trigger',
    anchors: [
      'IF si.si_source_suspended(NEW.source_id) THEN',
      'IF si.si_source_suspended(p_source_id) THEN'
    ],
    replacements: ['IF false THEN', 'IF false THEN'],
    detector: /^not ok \d+ - T1-3 \(Q3, CR1\):/m
  }
];

const verifyRestored = () => {
  const actual = readFileSync(path);
  if (!actual.equals(original)) throw new Error('M2 FATAL: migration 0002 not restored byte-for-byte');
  console.log('M2 migration restored byte-for-byte: true; sha256:', sha(actual));
};

function runSuite(label) {
  const r = spawnSync(process.execPath, ['tests/db/run.mjs', 't1'], {
    encoding: 'utf8', timeout: 180000, maxBuffer: 12 * 1024 * 1024
  });
  const output = (r.stdout ?? '') + '\n' + (r.stderr ?? '');
  console.log(label, 'exit:', r.status, 'signal:', r.signal, 'spawn error:', r.error?.message ?? 'none');
  const diagnostic = output.split('\n').filter(s =>
    /^(?:not ok|ok \d+ - T1-2:|ok \d+ - T1-3|# (?:tests|pass|fail)|\s*(?:name:|actual:|expected:|error:|code:)|.*AssertionError|.*ERR_ASSERTION)/.test(s));
  console.log(label, 'detector output:\n' + diagnostic.slice(0, 90).join('\n'));
  return { r, output };
}

const results = [];
console.log('M2 baseline migration sha256:', originalHash);
try {
  for (const mutant of mutations) {
    let mutated = source;
    for (let i = 0; i < mutant.anchors.length; i++) {
      const anchor = mutant.anchors[i];
      if (mutated.split(anchor).length !== 2)
        throw new Error(mutant.id + ' expected exactly one anchor: ' + anchor);
      mutated = mutated.replace(anchor, mutant.replacements[i]);
    }
    if (mutated === source) throw new Error(mutant.id + ' no-op mutation');
    try {
      writeFileSync(path, mutated, 'utf8');
      console.log(mutant.id, 'mutation applied:', mutant.purpose);
      const { r, output } = runSuite(mutant.id);
      const expectedFailure = mutant.detector.test(output);
      const assertion = /AssertionError|ERR_ASSERTION|Missing expected rejection|Missing expected exception/.test(output);
      const classification = r.error || r.signal || r.status === null ? 'INCONCLUSIVE'
        : r.status === 0 ? 'SURVIVED'
        : expectedFailure && assertion ? 'KILLED' : 'INCONCLUSIVE';
      console.log(mutant.id, 'targeted detector failed:', expectedFailure, 'assertion:', assertion);
      console.log(mutant.id, 'CLASSIFICATION:', classification);
      results.push({ id: mutant.id, classification });
    } finally {
      writeFileSync(path, original);
      verifyRestored();
    }
  }
  const baseline = runSuite('M2 restored baseline');
  const baselineGreen = baseline.r.status === 0 && !baseline.r.error && !baseline.r.signal;
  console.log('M2 restored baseline green:', baselineGreen);
  verifyRestored();
  if (!baselineGreen) throw new Error('M2 baseline failure after restoration');
  if (results.some(x => x.classification !== 'KILLED'))
    throw new Error('M2 unresolved mutants: ' + JSON.stringify(results));
  console.log('M2 RESULT: both representative mutants KILLED, baseline green');
} finally {
  writeFileSync(path, original);
  verifyRestored();
}

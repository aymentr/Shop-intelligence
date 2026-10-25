// B-002 M2 Step 2 — M3 lease / expiry mutation campaign.
// CI-only against the workflow's disposable, loopback PostgreSQL 16 test service.
// Two independent, exactly anchored mutations; migration 0001 is never touched.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

if (process.env.CI !== 'true') throw new Error('M3 requires CI=true');
if (process.env.SI_PRODUCTION === '1') throw new Error('M3 refuses production mode');
if (!['127.0.0.1', 'localhost', '::1'].includes(process.env.SI_TEST_PGHOST ?? '127.0.0.1'))
  throw new Error('M3 requires a loopback PostgreSQL test host');

const path = 'db/migrations/0002_runs.up.sql';
const original = readFileSync(path);
const source = original.toString('utf8');
const sha256 = b => createHash('sha256').update(b).digest('hex');
const originalHash = sha256(original);
const mutants = [
  {
    id: 'M3-LIVE',
    hypothesis: 'A live RUNNING lease must prevent a second attempt',
    anchor: "AND x.status = 'RUNNING' AND x.lease_expires_at > clock_timestamp()) THEN",
    replacement: "AND x.status = 'RUNNING' AND x.lease_expires_at < clock_timestamp()) THEN",
    detector: /^not ok \d+ - T1-6 \(C10, EC5\):/m
  },
  {
    id: 'M3-REAP',
    hypothesis: 'An expired RUNNING attempt must be marked FAILED/LEASE_EXPIRED before replacement',
    anchor: "AND x.status = 'RUNNING' AND x.lease_expires_at <= clock_timestamp();",
    replacement: "AND x.status = 'RUNNING' AND x.lease_expires_at > clock_timestamp();",
    detector: /^not ok \d+ - T1-6 \(C10, EC5\):/m
  }
];

function restore() {
  writeFileSync(path, original);
  const restored = readFileSync(path);
  if (!restored.equals(original)) throw new Error('M3 FATAL: byte restoration mismatch');
  console.log('M3 migration restored byte-for-byte: true; sha256:', sha256(restored));
}

function suite(id) {
  const result = spawnSync(process.execPath, ['tests/db/run.mjs', 't1'], {
    encoding: 'utf8', timeout: 180000, maxBuffer: 12 * 1024 * 1024
  });
  const output = (result.stdout ?? '') + '\n' + (result.stderr ?? '');
  console.log(id, 'exit:', result.status, 'signal:', result.signal, 'spawn error:', result.error?.message ?? 'none');
  console.log(id, 'detector output:\n' + output.split('\n').filter(line =>
    /^not ok |^ok \d+ - T1-6|^# (tests|pass|fail)|AssertionError|ERR_ASSERTION|^\s*(?:error:|actual:|expected:|code:)/.test(line)
  ).slice(0, 100).join('\n'));
  return { result, output };
}

console.log('M3 original migration sha256:', originalHash);
const outcomes = [];
try {
  for (const mutant of mutants) {
    if (source.split(mutant.anchor).length !== 2)
      throw new Error(mutant.id + ': expected one exact SQL anchor');
    const changed = source.replace(mutant.anchor, mutant.replacement);
    if (changed === source) throw new Error(mutant.id + ': no-op');
    try {
      writeFileSync(path, changed, 'utf8');
      console.log(mutant.id, 'applied:', mutant.hypothesis);
      const { result, output } = suite(mutant.id);
      const detectorFailed = mutant.detector.test(output);
      const assertion = /AssertionError|ERR_ASSERTION|Missing expected rejection|Missing expected exception/.test(output);
      const classification = result.error || result.signal || result.status === null ? 'INCONCLUSIVE'
        : result.status === 0 ? 'SURVIVED'
        : detectorFailed && assertion ? 'KILLED' : 'INCONCLUSIVE';
      console.log(mutant.id, 'detector failed:', detectorFailed, 'assertion:', assertion);
      console.log(mutant.id, 'CLASSIFICATION:', classification);
      outcomes.push({ mutant: mutant.id, classification });
    } finally {
      restore();
    }
  }
  const baseline = suite('M3 restored baseline');
  const baselineGreen = baseline.result.status === 0 && !baseline.result.error && !baseline.result.signal;
  console.log('M3 restored baseline green:', baselineGreen);
  if (!baselineGreen) throw new Error('M3 restored baseline failed');
  if (outcomes.some(x => x.classification !== 'KILLED'))
    throw new Error('M3 unresolved: ' + JSON.stringify(outcomes));
  console.log('M3 RESULT: both representative lease mutants KILLED; baseline green');
} finally {
  restore();
}

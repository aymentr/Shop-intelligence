// B-002 M4-P3.1-TEST-CLOSE-01: deliberate breaks of the deterministic barriers (tests/db/barriers.mjs). Each mutant is
// applied with exactly one anchor; the barrier tests run; the mutant is KILLED only if its named detector fails with an
// assertion. The file is restored byte for byte after each mutant (verified) and the restored baseline must be green.
//   CI=true node tests/mutations/m4-test-barriers.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

if (process.env.CI !== 'true') throw new Error('m4-test-barriers requires CI=true');
if (process.env.SI_PRODUCTION === '1') throw new Error('m4-test-barriers refuses production mode');
if (!['127.0.0.1', 'localhost', '::1'].includes(process.env.SI_TEST_PGHOST ?? '127.0.0.1')) throw new Error('loopback PostgreSQL test host required');

const F = 'tests/db/barriers.mjs';
const original = readFileSync(F);
const sha = b => createHash('sha256').update(b).digest('hex').slice(0, 12);
const M = [
  { id: 'BX1', why: 'R-43 barrier back to "any PgSleep of the session" (marker ignored)',
    anchor: "WHERE pid = $1 AND application_name = $2 AND state = 'active'", to: "WHERE pid = $1 AND wait_event = 'PgSleep' AND $2::text IS NOT NULL",
    detector: /^not ok \d+ - REM-B3 /m },
  { id: 'BX2', why: 'R-44 observation takes an idle (not yet started) control for a completed one',
    anchor: "    note(r?.state === 'active' ? 'running' : 'not-started');", to: "    if (r?.state === 'idle') { note('completed'); return { state: 'completed', trace, result }; }\n    note('running');",
    detector: /^not ok \d+ - TB-2:/m },
  { id: 'BX3', why: 'the pause marker is session-wide instead of transaction-local (it outlives the read)',
    anchor: "set_config('application_name', current_setting('si.test_mark'), true)", to: "set_config('application_name', current_setting('si.test_mark'), false)",
    detector: /^not ok \d+ - TB-6 /m },
];
const restore = () => { writeFileSync(F, original); if (!readFileSync(F).equals(original)) throw new Error(`FATAL: ${F} not restored`); console.log(`restored byte-for-byte: ${F} ${sha(original)}`); };
const suite = () => {
  const r = spawnSync(process.execPath, ['tests/db/run.mjs', 'm4-remediation', 'm4-test-barriers'], { encoding: 'utf8', timeout: 1800000, maxBuffer: 64 * 1024 * 1024 });
  return { r, out: (r.stdout ?? '') + '\n' + (r.stderr ?? '') };
};
const outcomes = [];
try {
  for (const m of M) {
    const src = original.toString('utf8');
    if (src.split(m.anchor).length !== 2) throw new Error(`${m.id}: expected exactly one anchor in ${F}`);
    try {
      writeFileSync(F, src.replace(m.anchor, () => m.to), 'utf8');
      const { r, out } = suite();
      const detected = m.detector.test(out), assertion = /AssertionError|ERR_ASSERTION/.test(out);
      const cls = r.error || r.signal || r.status === null ? 'INCONCLUSIVE' : r.status === 0 ? 'SURVIVED' : detected && assertion ? 'KILLED' : 'INCONCLUSIVE';
      console.log(`${m.id} ${m.why}: ${cls}; failing tests: ${JSON.stringify([...out.matchAll(/^not ok \d+ - (.{0,80})/gm)].map(z => z[1]))}`);
      outcomes.push({ id: m.id, cls });
    } finally { restore(); }
  }
  const green = suite().r.status === 0;
  console.log('restored baseline green:', green);
  console.log('SUMMARY', JSON.stringify(outcomes));
  const bad = outcomes.filter(o => o.cls !== 'KILLED');
  if (!green || bad.length) { console.error('m4-test-barriers FAILED:', JSON.stringify(bad)); process.exit(1); }
  console.log('m4-test-barriers RESULT: every mutant KILLED by its detector');
} finally { restore(); }

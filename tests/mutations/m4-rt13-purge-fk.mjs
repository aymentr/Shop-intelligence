// B-002 M4-P3.1-RT13-01: file-level deliberate break of migration 0022. Each mutant is applied to the migration file
// with exactly one anchor, the template is rebuilt from the mutated file (tests/db/run.mjs), the named tests run, and the
// mutant is KILLED only if its named detector fails with an assertion. The file is restored byte for byte after each
// mutant (verified) and the restored baseline must be green. A setup error or timeout is INCONCLUSIVE, never a kill.
//   CI=true node tests/mutations/m4-rt13-purge-fk.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

if (process.env.CI !== 'true') throw new Error('m4-rt13-purge-fk requires CI=true');
if (process.env.SI_PRODUCTION === '1') throw new Error('m4-rt13-purge-fk refuses production mode');
if (!['127.0.0.1', 'localhost', '::1'].includes(process.env.SI_TEST_PGHOST ?? '127.0.0.1')) throw new Error('loopback PostgreSQL test host required');

const F = 'db/migrations/0022_purge_fk_support_index.up.sql';
const original = readFileSync(F);
const sha256 = b => createHash('sha256').update(b).digest('hex');
const IX = 'CREATE INDEX observations_by_ad_fk ON si.observations (ad_id, source_id, network, native_ad_id);';
const M = [
  // The fix removed: the RT-13 defect must come back and be detected structurally (cold statistics).
  { id: 'RTX1', why: 'the supporting index is not created', anchor: IX, to: 'SELECT 1;',
    detector: /^not ok \d+ - PF-1 \(cold statistics\)/m },
  // A plausible but insufficient "fix": an index on ad_id alone (a duplicate of observations_by_ad). The RI lookup is
  // then planned exactly as before 0022 under cold statistics.
  { id: 'RTX2', why: 'an index on ad_id only (does not cover the FK key)', anchor: IX,
    to: 'CREATE INDEX observations_by_ad_fk ON si.observations (ad_id);', detector: /^not ok \d+ - PF-1 \(cold statistics\)/m },
];
function restore() {
  writeFileSync(F, original);
  if (!readFileSync(F).equals(original)) throw new Error(`FATAL: ${F} not restored`);
  console.log(`restored byte-for-byte: ${F.split('/').pop()} ${sha256(original).slice(0, 12)}`);
}
const suite = () => {
  const r = spawnSync(process.execPath, ['tests/db/run.mjs', 'm4-rt13-purge-fk'], { encoding: 'utf8', timeout: 1800000, maxBuffer: 64 * 1024 * 1024 });
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
      const built = /migrations applied .*\b22\b/.test(out);
      const detected = m.detector.test(out), assertion = /AssertionError|ERR_ASSERTION/.test(out);
      const cls = r.error || r.signal || r.status === null || !built ? 'INCONCLUSIVE'
        : r.status === 0 ? 'SURVIVED' : detected && assertion ? 'KILLED' : 'INCONCLUSIVE';
      const failed = [...out.matchAll(/^not ok \d+ - (.{0,80})/gm)].map(z => z[1]);
      const lines = [...out.matchAll(/^# \\?# PF-1 cold: .*$/gm)].map(z => z[0]);
      console.log(`${m.id} ${m.why}: ${cls}; failing tests: ${JSON.stringify(failed)}\n  ${lines.join('\n  ')}`);
      outcomes.push({ id: m.id, cls });
    } finally { restore(); }
  }
  const base = suite();
  const green = base.r.status === 0;
  console.log('restored baseline green:', green);
  console.log('SUMMARY', JSON.stringify(outcomes));
  const bad = outcomes.filter(o => o.cls !== 'KILLED');
  if (!green || bad.length) { console.error('m4-rt13-purge-fk FAILED:', JSON.stringify(bad)); process.exit(1); }
  console.log('m4-rt13-purge-fk RESULT: every mutant KILLED by its detector');
} finally { restore(); }

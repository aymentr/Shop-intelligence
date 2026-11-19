// B-002 M4-P3.3-P2-CLOSE-01: deliberate breaks of the closure (migration 0025, the 0024 gap phases the acceptance review found
// uncovered, and the si_monitor idle bound). Each mutant replaces exactly one anchor in one file; tests/db/run.mjs rebuilds
// the template from the files and re-runs the idempotent role bootstrap; the closure suite runs; the mutant is KILLED only
// if its named detector fails with an assertion. Every file is restored byte for byte after each mutant (verified) and the
// restored baseline must be green.
//   CI=true node tests/mutations/m4-p33-p2-close.mjs        (SI_MUT_ONLY=NM1,NM2 for a subset, local diagnosis only)
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

if (process.env.CI !== 'true') throw new Error('m4-p33-p2-close requires CI=true');
if (process.env.SI_PRODUCTION === '1') throw new Error('m4-p33-p2-close refuses production mode');
if (!['127.0.0.1', 'localhost', '::1'].includes(process.env.SI_TEST_PGHOST ?? '127.0.0.1')) throw new Error('loopback PostgreSQL test host required');

const F24 = 'db/migrations/0024_batched_summary_verification.up.sql', F25 = 'db/migrations/0025_verification_safety_closure.up.sql';
const ROLES = 'db/bootstrap/roles.sql';
const FILES = [F24, F25, ROLES];
const original = new Map(FILES.map(f => [f, readFileSync(f)]));
const sha = b => createHash('sha256').update(b).digest('hex').slice(0, 12);
const D = id => new RegExp(`^not ok \\d+ - ${id}:`, 'm');
const M = [
  { id: 'NM1', file: F25, why: 'clearance accepts a clean sweep of another source', detector: D('NM1'),
    anchor: 'SELECT * INTO w FROM si.summary_sweeps s WHERE s.sweep_id = p_sweep_id AND s.source_id = p_source_id;',
    to: 'SELECT * INTO w FROM si.summary_sweeps s WHERE s.sweep_id = p_sweep_id;' },
  { id: 'NM2', file: F25, why: 'clearance takes no source lock (a finding or an in-scope publication can commit between check and DRIFT_CLEARED)', detector: D('NM2'),
    anchor: '  PERFORM 1 FROM si.sources s WHERE s.source_id = p_source_id FOR UPDATE;', to: '  PERFORM 1 FROM si.sources s WHERE s.source_id = p_source_id;' },
  { id: 'NM3', file: F24, why: 'the identity gap phase is skipped', detector: D('NM3'),
    anchor: "    IF v_ids = 0 THEN nxt := CASE ph WHEN 'IDENTITIES' THEN 'IDENTITY_GAPS' ELSE 'DONE' END; END IF;", to: "    IF v_ids = 0 THEN nxt := 'DONE'; END IF;" },
  { id: 'NM4', file: F24, why: 'the run gap phase treats runs recorded by an earlier sweep as done', detector: D('NM4'),
    anchor: 'AND NOT EXISTS (SELECT 1 FROM si.summary_sweep_runs v WHERE v.sweep_id = w.sweep_id AND v.run_id = r.run_id)',
    to: 'AND NOT EXISTS (SELECT 1 FROM si.summary_sweep_runs v WHERE v.run_id = r.run_id)' },
  { id: 'CX1', file: F25, why: 'the legacy full verification auto-clears again', detector: D('CL-9'),
    anchor: "  END IF;                                     -- 0025: a clean pass records nothing; clearance is si_summary_clear_drift only",
    to: "  ELSIF si.si_summary_drift_open(p_source_id) THEN\n    INSERT INTO si.summary_events (source_id, kind) VALUES (p_source_id, 'DRIFT_CLEARED');\n  END IF;" },
  { id: 'CX2', file: F25, why: 'clearance accepts a sweep under an old normalizer fingerprint', detector: D('CL-4'),
    anchor: '  IF w.normalizer IS DISTINCT FROM si.si_normalizer_fingerprint() THEN', to: '  IF false THEN' },
  { id: 'CX3', file: F25, why: 'clearance ignores in-boundary runs without this sweep\'s record', detector: D('CL-5'),
    anchor: '  IF EXISTS (SELECT 1 FROM si.collection_runs r\n              WHERE r.source_id = p_source_id', to: '  IF false AND EXISTS (SELECT 1 FROM si.collection_runs r\n              WHERE r.source_id = p_source_id' },
  { id: 'CX6', file: F25, why: 'clearance ignores in-boundary identities without this sweep\'s record', detector: D('CL-5b'),
    anchor: '     OR EXISTS (SELECT 1 FROM si.advertiser_identities i\n                 WHERE i.source_id = p_source_id', to: '     OR false AND EXISTS (SELECT 1 FROM si.advertiser_identities i\n                 WHERE i.source_id = p_source_id' },
  { id: 'CX4', file: F25, why: 'clearance runs under REPEATABLE READ (snapshot before the lock)', detector: D('CL-7'),
    anchor: "  IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN   -- each check below needs a fresh snapshot",
    to: "  IF false THEN   -- each check below needs a fresh snapshot" },
  { id: 'CX5', file: ROLES, why: 'si_monitor has no idle-in-transaction bound', detector: D('CL-1'),
    anchor: "ALTER ROLE si_monitor      SET idle_in_transaction_session_timeout = '2s';", to: "ALTER ROLE si_monitor      SET idle_in_transaction_session_timeout = 0;" },
];
const ONLY = (process.env.SI_MUT_ONLY ?? '').split(',').filter(Boolean);
const restore = () => { for (const [f, b] of original) { writeFileSync(f, b); if (!readFileSync(f).equals(b)) throw new Error(`FATAL: ${f} not restored`); } };
const suite = () => {
  const r = spawnSync(process.execPath, ['tests/db/run.mjs', 'm4-sweep-close'], { encoding: 'utf8', timeout: 3600000, maxBuffer: 64 * 1024 * 1024 });
  return { r, out: (r.stdout ?? '') + '\n' + (r.stderr ?? '') };
};
const outcomes = [];
try {
  if (suite().r.status !== 0) throw new Error('baseline not green before mutation');
  for (const m of M.filter(z => !ONLY.length || ONLY.includes(z.id))) {
    const src = original.get(m.file).toString('utf8');
    if (src.split(m.anchor).length !== 2) throw new Error(`${m.id}: expected exactly one anchor`);
    try {
      writeFileSync(m.file, src.replace(m.anchor, () => m.to), 'utf8');
      const { r, out } = suite();
      const detected = m.detector.test(out), assertion = /AssertionError|ERR_ASSERTION/.test(out);
      const cls = r.error || r.signal || r.status === null ? 'INCONCLUSIVE' : r.status === 0 ? 'SURVIVED' : detected && assertion ? 'KILLED' : 'INCONCLUSIVE';
      console.log(`${m.id} ${m.why}: ${cls}; failing tests: ${JSON.stringify([...out.matchAll(/^not ok \d+ - (.{0,60})/gm)].map(z => z[1]))}`);
      outcomes.push({ id: m.id, cls });
    } finally { restore(); console.log(`restored byte-for-byte: ${m.file.split('/').pop()} ${sha(original.get(m.file))}`); }
  }
  const green = suite().r.status === 0;
  console.log('restored baseline green:', green);
  console.log('SUMMARY', JSON.stringify(outcomes));
  const bad = outcomes.filter(o => o.cls !== 'KILLED');
  if (!green || bad.length) { console.error('m4-p33-p2-close FAILED:', JSON.stringify(bad)); process.exit(1); }
  console.log('m4-p33-p2-close RESULT: every mutant KILLED by its detector');
} finally { restore(); }

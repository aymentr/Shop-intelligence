// B-002 M4-P3.3 Phase 3: deliberate breaks of the operational observability (migration 0026 and the reader library's
// failure report). Each mutant replaces exactly one anchor in one file; a library mutant is rebuilt (npm run build); the
// template is rebuilt from the migration files by tests/db/run.mjs; the observability suite runs; the mutant is KILLED
// only if its named detector fails with an assertion. Every file is restored byte for byte (verified), dist/ is rebuilt,
// and the restored baseline must be green.
//   CI=true node tests/mutations/m4-p33-p3.mjs        (SI_MUT_ONLY=TX1,TX2 for a subset, local diagnosis only)
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

if (process.env.CI !== 'true') throw new Error('m4-p33-p3 requires CI=true');
if (process.env.SI_PRODUCTION === '1') throw new Error('m4-p33-p3 refuses production mode');
if (!['127.0.0.1', 'localhost', '::1'].includes(process.env.SI_TEST_PGHOST ?? '127.0.0.1')) throw new Error('loopback PostgreSQL test host required');

const F = 'db/migrations/0026_operational_observability.up.sql', LIB = 'src/persistence/intelligence.ts';
const originals = new Map([F, LIB].map(f => [f, readFileSync(f)]));
const sha = b => createHash('sha256').update(b).digest('hex').slice(0, 12);
const D = id => new RegExp(`^not ok \\d+ - ${id}:`, 'm');
const M = [
  { id: 'TX1', file: F, why: 'an in-snapshot guard failure is reported as DRIFT', detector: D('OB-3'),
    anchor: "                     WHEN cov.eligible IS TRUE THEN 'GUARD'", to: "                     WHEN cov.eligible IS TRUE THEN 'DRIFT'" },
  { id: 'TX2', file: F, why: 'every search is recorded as the summary path', detector: D('OB-2'),
    anchor: "          CASE WHEN summary_ok THEN 'summary' ELSE 'observations' END, fallback, t0);", to: "          'summary', NULL, t0);" },
  { id: 'TX3', file: F, why: 'a failing read telemetry write fails the read', detector: D('OB-8'),
    anchor: "  EXCEPTION WHEN OTHERS THEN\n    RAISE WARNING 'SI_TELEMETRY_LOST: read path event not recorded (%)', SQLSTATE;",
    to: "  EXCEPTION WHEN no_data_found THEN\n    NULL;" },
  { id: 'TX4', file: F, why: 'a failing control-timing write fails the emergency control', detector: D('OB-8'),
    anchor: "  EXCEPTION WHEN OTHERS THEN\n    RAISE WARNING 'SI_TELEMETRY_LOST: control timing not recorded (%)', SQLSTATE;",
    to: "  EXCEPTION WHEN no_data_found THEN\n    NULL;" },
  { id: 'TX5', file: F, why: 'a consumed (successful) intent can be labelled failed', detector: D('OB-6'),
    anchor: "  IF NOT FOUND OR i.principal IS DISTINCT FROM who OR i.state <> 'OPEN' THEN", to: "  IF NOT FOUND OR i.principal IS DISTINCT FROM who THEN" },
  { id: 'TX6', file: F, why: "another principal's intent can be labelled", detector: D('OB-6'),
    anchor: "  IF NOT FOUND OR i.principal IS DISTINCT FROM who OR i.state <> 'OPEN' THEN", to: "  IF NOT FOUND OR i.state <> 'OPEN' THEN" },
  { id: 'TX7', file: F, why: 'a never-verified source is not overdue', detector: D('OB-10'),
    anchor: "   WHERE h.last_clean_completed_at IS NULL OR h.seconds_since_clean > extract(epoch FROM p_max_clean_age)",
    to: "   WHERE h.seconds_since_clean > extract(epoch FROM p_max_clean_age)" },
  { id: 'TX8', file: F, why: 'persistent fallback needs strictly more than the ratio', detector: D('OB-12'),
    anchor: "r.observation_path::numeric / r.requests >= p_fallback_ratio", to: "r.observation_path::numeric / r.requests > p_fallback_ratio" },
  { id: 'TX9', file: F, why: 'control waits are compared with ten times the budget', detector: D('OB-11'),
    anchor: "count(*) FILTER (WHERE t.wait_ms > p_budget_ms)", to: "count(*) FILTER (WHERE t.wait_ms > p_budget_ms * 10)" },
  { id: 'TX10', file: F, why: 'row-lock waits on a source are not recognised', detector: D('OB-11'),
    anchor: "\n           OR EXISTS (SELECT 1 FROM pg_locks t WHERE t.pid = l.pid AND t.locktype = 'tuple' AND t.relation = 'si.sources'::regclass),", to: "\n           OR false," },
  { id: 'TX11', file: F, why: 'the monitoring functions are executable by PUBLIC', detector: D('OB-13'),
    anchor: "  si.si_operational_alerts(interval, interval, int, numeric, int, numeric, interval, numeric, int) TO si_monitor;",
    to: "  si.si_operational_alerts(interval, interval, int, numeric, int, numeric, interval, numeric, int) TO si_monitor, PUBLIC;" },
  { id: 'TX12', file: F, why: 'history requests are recorded as searches', detector: D('OB-4'),
    anchor: "  PERFORM si.si_record_read_path('history', who,", to: "  PERFORM si.si_record_read_path('search', who," },
  { id: 'LX1', file: LIB, why: 'the reader library never reports a failure classification', detector: D('OB-5'),
    anchor: "  if (!REPORTABLE.has(code)) return;", to: "  if (REPORTABLE.has(code) || true) return;" },
];
const ONLY = (process.env.SI_MUT_ONLY ?? '').split(',').filter(Boolean);
const restore = () => { for (const [f, b] of originals) { writeFileSync(f, b); if (!readFileSync(f).equals(b)) throw new Error(`FATAL: ${f} not restored`); } };
const build = () => { const r = spawnSync('npm', ['run', 'build'], { encoding: 'utf8' }); if (r.status !== 0) throw new Error('build failed: ' + r.stdout + r.stderr); };
const suite = () => {
  const r = spawnSync(process.execPath, ['tests/db/run.mjs', 'm4-observability'], { encoding: 'utf8', timeout: 3600000, maxBuffer: 64 * 1024 * 1024 });
  return { r, out: (r.stdout ?? '') + '\n' + (r.stderr ?? '') };
};
const outcomes = [];
try {
  build();
  if (suite().r.status !== 0) throw new Error('baseline not green before mutation');
  for (const m of M.filter(z => !ONLY.length || ONLY.includes(z.id))) {
    const src = originals.get(m.file).toString('utf8');
    if (src.split(m.anchor).length !== 2) throw new Error(`${m.id}: expected exactly one anchor`);
    try {
      writeFileSync(m.file, src.replace(m.anchor, () => m.to), 'utf8');
      if (m.file === LIB) build();
      const { r, out } = suite();
      const detected = m.detector.test(out), assertion = /AssertionError|ERR_ASSERTION/.test(out);
      const cls = r.error || r.signal || r.status === null ? 'INCONCLUSIVE' : r.status === 0 ? 'SURVIVED' : detected && assertion ? 'KILLED' : 'INCONCLUSIVE';
      console.log(`${m.id} ${m.why}: ${cls}; failing tests: ${JSON.stringify([...out.matchAll(/^not ok \d+ - (.{0,60})/gm)].map(z => z[1]))}`);
      outcomes.push({ id: m.id, cls });
    } finally { restore(); if (m.file === LIB) build(); console.log(`restored byte-for-byte: ${m.file.split('/').pop()} ${sha(originals.get(m.file))}`); }
  }
  const green = suite().r.status === 0;
  console.log('restored baseline green:', green);
  console.log('SUMMARY', JSON.stringify(outcomes));
  const bad = outcomes.filter(o => o.cls !== 'KILLED');
  if (!green || bad.length) { console.error('m4-p33-p3 FAILED:', JSON.stringify(bad)); process.exit(1); }
  console.log('m4-p33-p3 RESULT: every mutant KILLED by its detector');
} finally { restore(); build(); }

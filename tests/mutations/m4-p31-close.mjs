// B-002 M4-P3.1-CLOSE-01 condition C2: file-level mutation campaign over migrations 0020 and 0021 (the 15 mutants of
// M4-P3.1-ACCEPT-01, MX1-MX15, plus MX16-MX17 for the 0021 eligibility function). Each mutant is applied to the migration
// file with exactly one anchor, the template is rebuilt from the mutated file (tests/db/run.mjs), the named test files
// run, and the mutant is KILLED only if its named detector test fails with an assertion; every file is restored byte for
// byte after each mutant (verified), and the restored baseline must be green. A setup error or timeout is INCONCLUSIVE,
// never a kill. MX10 is a declared equivalent mutant (docs §15.9): it must SURVIVE (if it is ever killed, the
// equivalence argument is wrong and the campaign fails).
//   CI=true node tests/mutations/m4-p31-close.mjs [MX4 MX5 ...]
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

if (process.env.CI !== 'true') throw new Error('m4-p31-close requires CI=true');
if (process.env.SI_PRODUCTION === '1') throw new Error('m4-p31-close refuses production mode');
if (!['127.0.0.1', 'localhost', '::1'].includes(process.env.SI_TEST_PGHOST ?? '127.0.0.1')) throw new Error('loopback PostgreSQL test host required');

const F20 = 'db/migrations/0020_advertiser_summaries.up.sql', F21 = 'db/migrations/0021_summary_coverage_cost.up.sql';
const originals = new Map([F20, F21].map(f => [f, readFileSync(f)]));
const sha256 = b => createHash('sha256').update(b).digest('hex');
const SUM = 'm4-summaries', CLOSE = 'm4-summaries-close', GATE = 'm4-integrity-gate';
const M = [
  { id: 'MX1', file: F20, why: 'the evidence insert guard trigger is not created',
    anchor: 'CREATE TRIGGER trg_observation_open_run BEFORE INSERT ON si.observations\nFOR EACH ROW EXECUTE FUNCTION si.trg_observation_open_run();', to: '',
    tests: [GATE], detector: /^not ok \d+ - IG-1:/m },
  { id: 'MX2', file: F20, why: 'the summary guard admits every DELETE',
    anchor: "  IF TG_OP = 'DELETE' AND TG_LEVEL = 'ROW' THEN                -- nested", to: "  IF TG_OP = 'DELETE' AND TG_LEVEL = 'ROW' THEN RETURN OLD; END IF;\n  IF TG_OP = 'DELETE' AND TG_LEVEL = 'ROW' THEN                -- nested",
    tests: [SUM], detector: /^not ok \d+ - SUM-6:/m },
  { id: 'MX3', file: F21, why: 'eligibility ignores open drift',
    anchor: "         CASE WHEN si.si_summary_drift_open(p_source_id) THEN 'DRIFT' END,", to: "         CASE WHEN false THEN 'DRIFT' END,",
    tests: [CLOSE], detector: /^not ok \d+ - CV-1:/m },
  { id: 'MX4', file: F20, why: 'verification compares in one direction only',
    anchor: '\n              OR EXISTS (SELECT * FROM si.si_summary_stored(s.run_id) EXCEPT ALL SELECT * FROM si.si_summary_content(s.run_id)))', to: ')',
    tests: [CLOSE], detector: /^not ok \d+ - CC-MX4:/m },
  { id: 'MX5', file: F20, why: 'the commit-time summary check never fires',
    anchor: "FOR EACH ROW WHEN (OLD.status = 'RUNNING' AND NEW.status = 'COMPLETED')", to: "FOR EACH ROW WHEN (OLD.status = 'RUNNING' AND NEW.status = 'NEVER')",
    tests: [CLOSE], detector: /^not ok \d+ - CC-MX5:/m },
  { id: 'MX6', file: F20, why: 'purge keeps the status record',
    anchor: "  DELETE FROM si.run_summary_status s WHERE s.run_id = NEW.run_id;\n  DELETE FROM si.advertiser_identities i\n   WHERE i.identity_id = ANY (coalesce(ids, '{}'))",
    to: "  DELETE FROM si.advertiser_identities i\n   WHERE i.identity_id = ANY (coalesce(ids, '{}'))", tests: [SUM], detector: /^not ok \d+ - SUM-7:/m },
  { id: 'MX7', file: F20, why: 'backfill does not re-check a purge under the lock',
    anchor: "      CONTINUE WHEN NOT EXISTS (SELECT 1 FROM si.collection_runs r WHERE r.run_id = x.run_id\n                                  AND r.status = 'COMPLETED' AND r.retention_state IN ('RETAINED', 'EMPTY'));\n", to: '',
    tests: [CLOSE], detector: /^not ok \d+ - CC-MX7:/m },
  { id: 'MX8', file: F20, why: 'the fingerprint omits the ICU version',
    anchor: "  SELECT 'v1|icu=' || coalesce((SELECT pg_collation_actual_version(c.oid) FROM pg_collation c\n                                 WHERE c.collname = 'und-x-icu' AND c.collnamespace = 'pg_catalog'::regnamespace), 'none')",
    to: "  SELECT 'v1|icu=' || 'fixed'", tests: [CLOSE], detector: /^not ok \d+ - CC-MX8:/m },
  { id: 'MX9', file: F20, why: 'raw names are not de-duplicated',
    anchor: 'array_agg(DISTINCT q.advertiser_name COLLATE "C" ORDER BY q.advertiser_name COLLATE "C")', to: 'array_agg(q.advertiser_name COLLATE "C" ORDER BY q.advertiser_name COLLATE "C")',
    tests: [SUM], detector: /^not ok \d+ - SUM-1:/m },
  { id: 'MX10', file: F20, why: 'identity insertion order removed (declared EQUIVALENT: DISTINCT ON sorts by the digest)', equivalent: true,
    anchor: '   ORDER BY u.advertiser_key\n  ON CONFLICT (source_id, normalizer, advertiser_key) DO NOTHING;', to: '  ON CONFLICT (source_id, normalizer, advertiser_key) DO NOTHING;',
    tests: [SUM], detector: /^not ok \d+ - SUM-3:/m },
  { id: 'MX11', file: F20, why: 'ad_ids not sorted ascending',
    anchor: 'array_agg(q.ad_id ORDER BY q.ad_id)', to: 'array_agg(q.ad_id ORDER BY q.ad_id DESC)', tests: [SUM], detector: /^not ok \d+ - SUM-1:/m },
  { id: 'MX12', file: F20, why: 'verification no longer reports orphan identities',
    anchor: '       WHERE i.source_id = p_source_id AND NOT EXISTS (SELECT 1 FROM si.run_advertiser_summaries x WHERE x.identity_id = i.identity_id)', to: '       WHERE false',
    tests: [CLOSE], detector: /^not ok \d+ - CC-MX12:/m },
  { id: 'MX13', file: F20, why: 'the commit-time check ignores the observation count',
    anchor: '                    AND s.observation_count = (SELECT count(*) FROM si.observations o WHERE o.run_id = NEW.run_id)\n', to: '',
    tests: [CLOSE], detector: /^not ok \d+ - CC-MX13:/m },
  { id: 'MX14', file: F20, why: 'a clean verification never clears drift',
    anchor: "  ELSIF si.si_summary_drift_open(p_source_id) THEN\n    INSERT INTO si.summary_events (source_id, kind) VALUES (p_source_id, 'DRIFT_CLEARED');", to: '  ELSIF false THEN\n    NULL;',
    tests: [SUM], detector: /^not ok \d+ - SUM-6:/m },
  { id: 'MX15', file: F20, why: 'rebuild is allowed without recorded drift',
    anchor: "  IF NOT si.si_summary_drift_open(src) THEN\n    RAISE EXCEPTION 'SI_SUMMARY_NO_DRIFT", to: "  IF false THEN\n    RAISE EXCEPTION 'SI_SUMMARY_NO_DRIFT",
    tests: [SUM], detector: /^not ok \d+ - SUM-6:/m },
  { id: 'MX16', file: F21, why: 'eligibility evaluates the fingerprint per run again',
    anchor: 'WHERE s.source_id = p_source_id AND s.normalizer = fp AND s.run_id = x.run_id))', to: 'WHERE s.source_id = p_source_id AND s.normalizer = si.si_normalizer_fingerprint() AND s.run_id = x.run_id))',
    tests: [CLOSE], detector: /^not ok \d+ - CV-2:/m },
  { id: 'MX17', file: F21, why: 'eligibility accepts a status under any fingerprint',
    anchor: 'WHERE s.source_id = p_source_id AND s.normalizer = fp AND s.run_id = x.run_id))', to: 'WHERE s.source_id = p_source_id AND s.run_id = x.run_id))',
    tests: [CLOSE], detector: /^not ok \d+ - CV-1:/m },
];
const only = process.argv.slice(2);

function restoreAll() {
  for (const [f, b] of originals) { writeFileSync(f, b); if (!readFileSync(f).equals(b)) throw new Error(`FATAL: ${f} not restored`); }
  console.log('restored byte-for-byte:', [...originals].map(([f, b]) => `${f.split('/').pop()} ${sha256(b).slice(0, 12)}`).join(', '));
}
function suite(tests) {
  const r = spawnSync(process.execPath, ['tests/db/run.mjs', ...tests], { encoding: 'utf8', timeout: 1800000, maxBuffer: 64 * 1024 * 1024 });
  return { r, out: (r.stdout ?? '') + '\n' + (r.stderr ?? '') };
}
const outcomes = [];
try {
  for (const m of M) {
    if (only.length && !only.includes(m.id)) continue;
    const src = originals.get(m.file).toString('utf8');
    if (src.split(m.anchor).length !== 2) throw new Error(`${m.id}: expected exactly one anchor in ${m.file}`);
    try {
      writeFileSync(m.file, src.replace(m.anchor, () => m.to), 'utf8');
      const { r, out } = suite(m.tests);
      const built = /migrations applied .*\b21\b/.test(out);
      const detected = m.detector.test(out), assertion = /AssertionError|ERR_ASSERTION/.test(out);
      const cls = r.error || r.signal || r.status === null || !built ? 'INCONCLUSIVE'
        : r.status === 0 ? (m.equivalent ? 'EQUIVALENT (survived as declared)' : 'SURVIVED')
        : detected && assertion ? (m.equivalent ? 'KILLED (equivalence claim WRONG)' : 'KILLED') : 'INCONCLUSIVE';
      const failed = [...out.matchAll(/^not ok \d+ - (.{0,80})/gm)].map(x => x[1]);
      console.log(`${m.id} ${m.why}: ${cls}; failing tests: ${JSON.stringify(failed)}`);
      outcomes.push({ id: m.id, cls });
    } finally { restoreAll(); }
  }
  const base = suite([SUM, CLOSE, GATE]);
  const green = base.r.status === 0;
  console.log('restored baseline green:', green);
  const bad = outcomes.filter(o => !(o.cls === 'KILLED' || o.cls.startsWith('EQUIVALENT')));
  console.log('SUMMARY', JSON.stringify(outcomes));
  if (!green || bad.length) { console.error('m4-p31-close FAILED:', JSON.stringify(bad)); process.exit(1); }
  console.log('m4-p31-close RESULT: every non-equivalent mutant KILLED by its detector; MX10 survived as declared');
} finally { restoreAll(); }

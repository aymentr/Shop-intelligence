// B-002 M4-P3.2: deliberate breaks of the summary-backed search (migration 0023). Each mutant edits the 0023 up file at
// anchors that must each occur exactly once; the template is rebuilt from the edited file and the summary-search suite
// runs. A mutant is KILLED only if its named detector fails with an assertion (a fixture error is INCONCLUSIVE). The file
// is restored byte for byte after each mutant (verified) and the restored baseline must be green.
//   CI=true node tests/mutations/m4-p32-search.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

if (process.env.CI !== 'true') throw new Error('m4-p32-search requires CI=true');
if (process.env.SI_PRODUCTION === '1') throw new Error('m4-p32-search refuses production mode');
if (!['127.0.0.1', 'localhost', '::1'].includes(process.env.SI_TEST_PGHOST ?? '127.0.0.1')) throw new Error('loopback PostgreSQL test host required');

// M4-P3.3 Phase 3: 0026 replaces si_search_advertisers (the 0023 text with telemetry lines added); the mutants edit the
// live definition, and only inside its function block (0026 also defines si_advertiser_history, which shares some anchors).
const F = 'db/migrations/0026_operational_observability.up.sql';
const BLOCK = ['CREATE OR REPLACE FUNCTION si.si_search_advertisers(', 'END $search$;'];
const original = readFileSync(F);
const sha = b => createHash('sha256').update(b).digest('hex').slice(0, 12);
const GRANT = 'IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM si.reader_grants g';
const M = [
  { id: 'SSX1', why: 'unsafe fallback: the summary path is taken whatever eligibility and the guard say',
    edits: [['    IF cov.eligible IS TRUE THEN\n', '    IF true THEN\n'], ['           AND (SELECT g.ok FROM guard g)),', '           ),'],
            ['    SELECT (SELECT g.ok FROM guard g), (SELECT c.n FROM counted c),', '    SELECT true, (SELECT c.n FROM counted c),']],
    detector: /^not ok \d+ - SS-2a:/m },
  { id: 'SSX2', why: 'incomplete summaries treated as complete: the guard no longer requires a status for every readable run',
    edits: [['                   = cardinality(readable_runs) AS ok),', '                   >= 0 AS ok),']], detector: /^not ok \d+ - SS-2d:/m },
  { id: 'SSX3', why: 'distinct ads lose the union (per-row ad_ids counted, not distinct)',
    edits: [['count(DISTINCT u.ad_id)::int AS distinct_ads', 'count(u.ad_id)::int AS distinct_ads']], detector: /^not ok \d+ - SS-1b:/m },
  { id: 'SSX4', why: 'stale readability: summary rows of runs that are not readable now (live readability ignored)',
    edits: [['                                AND s.run_id = ANY (readable_runs)                    -- no join: a hashed membership test\n', ''],
            ['                                AND s.run_id = ANY (readable_runs)\n', '', 3]], detector: /^not ok \d+ - SS-3:/m },
  { id: 'SSX5', why: 'authorization bypass: the grant check is omitted',
    edits: [[GRANT, 'IF NOT FOUND OR false AND NOT EXISTS (SELECT 1 FROM si.reader_grants g']], detector: /^not ok \d+ - SS-3:/m },
  { id: 'SSX6', why: 'network filter ignored on the summary path',
    edits: [['AND (cardinality(p_networks) = 0 OR s.network = ANY (p_networks))', '', 4]], detector: /^not ok \d+ - SS-1 \(seed 11\)/m },
  { id: 'SSX7', why: 'inclusive cursor ignored on the summary path',
    edits: [['OR (p_after_inclusive AND e.nn = p_after)', '']], detector: /^not ok \d+ - SS-5:/m },
  { id: 'SSX8', why: 'observation cap ignored on the summary path',
    edits: [['        candidates := least(summary_candidates, max_candidates + 1)::int;', '        candidates := 0;']], detector: /^not ok \d+ - SS-6:/m },
  { id: 'SSX9', why: 'open drift ignored by the in-statement guard',
    edits: [['        SELECT NOT si.si_summary_drift_open(p_source_id)\n               AND', '        SELECT true\n               AND']], detector: /^not ok \d+ - SS-2d:/m },
  { id: 'SSX10', why: 'observation path (fallback): distinct ads counted as observations',
    edits: [['count(DISTINCT (c.network, c.native_ad_id))::int AS distinct_ads', 'count(*)::int AS distinct_ads']], detector: /^not ok \d+ - SS-1 \(seed 11\)/m },
  { id: 'SSX11', why: 'source lock omitted (controls no longer wait for the summary page)',
    edits: [['PERFORM 1 FROM si.sources x WHERE x.source_id = p_source_id FOR SHARE;', 'PERFORM 1 FROM si.sources x WHERE x.source_id = p_source_id;']], detector: /^not ok \d+ - SS-4a:/m },
  // M4-P3.2-CLOSE-01 (IM7 of M4-P3.2-ACCEPT-01): only the guard's current-fingerprint condition removed.
  { id: 'SSX12', why: 'guard accepts summary statuses of any normalizer fingerprint (IM7)',
    edits: [[' AND ss.source_id = p_source_id AND ss.normalizer = fp)', ' AND ss.source_id = p_source_id)']], detector: /^not ok \d+ - SS-2e:/m },
];
const restore = () => { writeFileSync(F, original); if (!readFileSync(F).equals(original)) throw new Error(`FATAL: ${F} not restored`); console.log(`restored byte-for-byte: ${F} ${sha(original)}`); };
const suite = () => {
  const r = spawnSync(process.execPath, ['tests/db/run.mjs', 'm4-summary-search'], { encoding: 'utf8', timeout: 1800000, maxBuffer: 64 * 1024 * 1024 });
  return { r, out: (r.stdout ?? '') + '\n' + (r.stderr ?? '') };
};
const outcomes = [];
try {
  for (const m of M) {
    const whole = original.toString('utf8'), b0 = whole.indexOf(BLOCK[0]), b1 = whole.indexOf(BLOCK[1], b0) + BLOCK[1].length;
    if (b0 < 0 || b1 < BLOCK[1].length) throw new Error('search function block not found');
    let src = whole.slice(b0, b1);
    // Each edit names its anchor and how many times it occurs (default once); every occurrence is replaced.
    for (const [from, to, count = 1] of m.edits) {
      if (src.split(from).length !== count + 1) throw new Error(`${m.id}: expected ${count} anchor(s) in ${F}: ${from.slice(0, 80)}`);
      src = src.split(from).join(to);
    }
    try {
      writeFileSync(F, whole.slice(0, b0) + src + whole.slice(b1), 'utf8');
      const { r, out } = suite();
      const detected = m.detector.test(out), assertion = /AssertionError|ERR_ASSERTION/.test(out);
      const cls = r.error || r.signal || r.status === null ? 'INCONCLUSIVE' : r.status === 0 ? 'SURVIVED' : detected && assertion ? 'KILLED' : 'INCONCLUSIVE';
      console.log(`${m.id} ${m.why}: ${cls}; failing tests: ${JSON.stringify([...out.matchAll(/^not ok \d+ - (.{0,80})/gm)].map(z => z[1]))}`);
      outcomes.push({ id: m.id, cls });
    } finally { restore(); }
  }
  const base = suite(), green = base.r.status === 0;
  console.log('restored baseline green:', green, green ? '' : JSON.stringify([...base.out.matchAll(/^not ok \d+ - (.{0,80})/gm)].map(z => z[1])));
  if (!green) console.log(base.out.split('\n').filter(l => /error:|expected|actual|Error/.test(l)).slice(0, 40).join('\n'));
  console.log('SUMMARY', JSON.stringify(outcomes));
  const bad = outcomes.filter(o => o.cls !== 'KILLED');
  if (!green || bad.length) { console.error('m4-p32-search FAILED:', JSON.stringify(bad)); process.exit(1); }
  console.log('m4-p32-search RESULT: every mutant KILLED by its detector');
} finally { restore(); }

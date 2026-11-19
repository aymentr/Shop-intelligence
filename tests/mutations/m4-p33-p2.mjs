// B-002 M4-P3.3 Phase 2: deliberate breaks of the batched summary verification (migration 0024). Each mutant replaces
// exactly one anchor in the migration file; the test template is rebuilt from the files by tests/db/run.mjs; the sweep
// suite runs; the mutant is KILLED only if its named detector fails with an assertion. The file is restored byte for byte
// after each mutant (verified) and the restored baseline must be green.
//   CI=true node tests/mutations/m4-p33-p2.mjs        (SI_MUT_ONLY=VX1,VX2 for a subset, local diagnosis only)
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

if (process.env.CI !== 'true') throw new Error('m4-p33-p2 requires CI=true');
if (process.env.SI_PRODUCTION === '1') throw new Error('m4-p33-p2 refuses production mode');
if (!['127.0.0.1', 'localhost', '::1'].includes(process.env.SI_TEST_PGHOST ?? '127.0.0.1')) throw new Error('loopback PostgreSQL test host required');

const F = 'db/migrations/0024_batched_summary_verification.up.sql';
const original = readFileSync(F);
const sha = b => createHash('sha256').update(b).digest('hex').slice(0, 12);
const D = id => new RegExp(`^not ok \\d+ - ${id}:`, 'm');
const M = [
  { id: 'VX1', why: 'the observation budget is ignored (no deferral)', detector: D('SW-5'),
    anchor: '      IF v_runs > 0 AND work + n > p_max_observations THEN EXIT; END IF;   -- defer: the next batch starts with it\n', to: '' },
  { id: 'VX2', why: 'an oversized run is verified anyway (unbounded batch)', detector: D('SW-4b'),
    anchor: '      IF n > p_max_observations THEN                                -- cannot be verified within any batch budget', to: '      IF false THEN' },
  { id: 'VX3', why: 'the run gap phase is skipped', detector: D('SW-6'),
    anchor: "    IF v_runs = 0 THEN nxt := CASE ph WHEN 'RUNS' THEN 'RUN_GAPS' ELSE 'IDENTITIES' END; END IF;", to: "    IF v_runs = 0 THEN nxt := 'IDENTITIES'; END IF;" },
  { id: 'VX4', why: 'a resubmitted batch is not replayed', detector: D('SW-9'),
    anchor: '  IF p_seq IS NOT NULL AND p_seq >= 1 AND p_seq = w.batches THEN', to: '  IF false THEN' },
  { id: 'VX5', why: 'a changed normalizer fingerprint does not stale the sweep', detector: D('SW-3'),
    anchor: '  IF fp IS DISTINCT FROM w.normalizer THEN\n    stale := true;', to: '  IF false THEN\n    stale := true;' },
  { id: 'VX6', why: 'run findings are not recorded as drift', detector: D('SW-2'),
    anchor: "          INSERT INTO si.summary_events (source_id, run_id, kind, finding) SELECT w.source_id, x.run_id, 'DRIFT_DETECTED', k FROM unnest(f) k;", to: '          NULL;' },
  { id: 'VX7', why: 'clearance ignores drift and rebuilds after the sweep started', detector: D('SW-14'),
    anchor: '  IF EXISTS (SELECT 1 FROM si.summary_events e WHERE e.source_id = p_source_id AND e.event_id > w.start_event_id',
    to: '  IF false AND EXISTS (SELECT 1 FROM si.summary_events e WHERE e.source_id = p_source_id AND e.event_id > w.start_event_id' },
  { id: 'VX8', why: 'clearance does not require a COMPLETED_CLEAN sweep', detector: D('SW-14'),
    anchor: "  IF NOT FOUND OR w.state <> 'COMPLETED_CLEAN' THEN", to: '  IF NOT FOUND THEN' },
  { id: 'VX9', why: 'a busy sweep row is waited for instead of refused (NOWAIT)', detector: D('SW-10'),
    anchor: 'FOR NO KEY UPDATE NOWAIT;   -- 55P03: another verifier', to: 'FOR NO KEY UPDATE;   -- 55P03: another verifier' },
  { id: 'VX10', why: 'the state machine accepts an advance that does not match its batch record', detector: D('SW-11'),
    anchor: "    RAISE EXCEPTION 'SI_SWEEP_TRANSITION: sweep % does not match its batch %', OLD.sweep_id, NEW.batches USING ERRCODE = '23514';",
    to: '    NULL;' },
  { id: 'VX11', why: 'a batch runs under READ COMMITTED (no single snapshot)', detector: D('SW-10'),
    anchor: "  IF current_setting('transaction_isolation') IS DISTINCT FROM 'repeatable read' THEN\n    RAISE EXCEPTION 'SI_ISOLATION: a verification batch",
    to: "  IF false THEN\n    RAISE EXCEPTION 'SI_ISOLATION: a verification batch" },
  { id: 'VX12', why: 'a batch holds the source lock (the legacy FOR SHARE)', detector: D('SW-7'),
    anchor: "  fp := si.si_normalizer_fingerprint();\n  ph := w.phase;",
    to: "  PERFORM 1 FROM si.sources z WHERE z.source_id = w.source_id FOR SHARE;\n  fp := si.si_normalizer_fingerprint();\n  ph := w.phase;" },
  { id: 'VX13', why: 'orphan identities are not reported', detector: D('SW-2'),
    anchor: "      IF NOT EXISTS (SELECT 1 FROM si.run_advertiser_summaries s WHERE s.identity_id = x.identity_id) THEN f := f || 'ORPHAN_IDENTITY'::text; END IF;\n", to: '' },
  { id: 'VX14', why: 'a stale-fingerprint status counts as verified', detector: D('SW-3'),
    anchor: '    RETURN NULL;                                                     -- stale status', to: "    RETURN '{}'::text[];                                             -- stale status" },
  { id: 'VX15', why: 'the status digest is not compared', detector: D('SW-2'),
    anchor: '     OR st.content_digest IS DISTINCT FROM (SELECT si.si_summary_digest(', to: '     OR false AND st.content_digest IS DISTINCT FROM (SELECT si.si_summary_digest(' },
  { id: 'VX16', why: 'stored content is compared in one direction only', detector: D('SW-2'),
    anchor: '     OR EXISTS (SELECT * FROM si.si_summary_stored(p_run_id) EXCEPT ALL SELECT * FROM unnest(content)) THEN', to: '     THEN' },
];
const ONLY = (process.env.SI_MUT_ONLY ?? '').split(',').filter(Boolean);
const restore = () => { writeFileSync(F, original); if (!readFileSync(F).equals(original)) throw new Error('FATAL: not restored'); };
const suite = () => {
  const r = spawnSync(process.execPath, ['tests/db/run.mjs', 'm4-sweep'], { encoding: 'utf8', timeout: 3600000, maxBuffer: 64 * 1024 * 1024 });
  return { r, out: (r.stdout ?? '') + '\n' + (r.stderr ?? '') };
};
const outcomes = [];
try {
  for (const m of M.filter(z => !ONLY.length || ONLY.includes(z.id))) {
    const src = original.toString('utf8');
    if (src.split(m.anchor).length !== 2) throw new Error(`${m.id}: expected exactly one anchor`);
    try {
      writeFileSync(F, src.replace(m.anchor, () => m.to), 'utf8');
      const { r, out } = suite();
      const detected = m.detector.test(out), assertion = /AssertionError|ERR_ASSERTION/.test(out);
      const cls = r.error || r.signal || r.status === null ? 'INCONCLUSIVE' : r.status === 0 ? 'SURVIVED' : detected && assertion ? 'KILLED' : 'INCONCLUSIVE';
      console.log(`${m.id} ${m.why}: ${cls}; failing tests: ${JSON.stringify([...out.matchAll(/^not ok \d+ - (.{0,60})/gm)].map(z => z[1]))}`);
      outcomes.push({ id: m.id, cls });
    } finally { restore(); console.log(`restored byte-for-byte: ${F.split('/').pop()} ${sha(original)}`); }
  }
  const green = suite().r.status === 0;
  console.log('restored baseline green:', green);
  console.log('SUMMARY', JSON.stringify(outcomes));
  const bad = outcomes.filter(o => o.cls !== 'KILLED');
  if (!green || bad.length) { console.error('m4-p33-p2 FAILED:', JSON.stringify(bad)); process.exit(1); }
  console.log('m4-p33-p2 RESULT: every mutant KILLED by its detector');
} finally { restore(); }
